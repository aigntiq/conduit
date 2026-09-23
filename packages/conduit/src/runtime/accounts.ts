/**
 * The account service: the only code that seals, opens, stores and renews
 * credentials. Everything that needs a usable credential asks `ensureFresh`.
 *
 * Refresh is EARLY (`refreshSkewSec` before expiry) and SINGLE-FLIGHT: under
 * the account's lock, the stored row is re-read first — if another caller
 * (or another process, with a distributed LockProvider) refreshed while we
 * waited, its result is used and no second refresh is sent. Writes are
 * compare-and-set on `version`, so even a lock-less store cannot lose one.
 */
import { ConduitAuthError, ConduitError, ConduitRequestError } from '../errors';
import { randomToken } from '../oauth';
import type { Credentials, StoredAccount } from '../ports/types';
import type { AuthMethod } from '../spec/types';
import { canRefresh, refresh, type Identity } from './auth-flows';
import { maskerFor, type CallContext, type Kernel } from './kernel';
import type { LoadedConnector } from './registry';
import type { AccountInfo } from './types';

export function toInfo(a: StoredAccount): AccountInfo {
    const info: AccountInfo = {
        id: a.id,
        owner: a.owner,
        connector: a.connector,
        method: a.method,
        status: a.status,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt
    };
    if (a.externalId !== undefined) info.externalId = a.externalId;
    if (a.displayName !== undefined) info.displayName = a.displayName;
    if (a.data !== undefined) info.data = a.data;
    if (a.expiresAt !== undefined) info.expiresAt = a.expiresAt;
    return info;
}

export async function seal(k: Kernel, credentials: Credentials): Promise<string> {
    return k.cipher.seal(JSON.stringify(credentials));
}

export async function open(k: Kernel, account: StoredAccount): Promise<Credentials> {
    try {
        return JSON.parse(await k.cipher.open(account.credentials)) as Credentials;
    } catch (e) {
        throw new ConduitAuthError(`credentials of account "${account.id}" cannot be read`, { accountId: account.id, needsReauth: true, cause: e });
    }
}

export async function loadAccount(k: Kernel, id: string, owner?: string): Promise<StoredAccount> {
    const account = await k.accounts.get(id);
    // An owner mismatch reads exactly like a missing account: no existence oracle.
    if (!account || (owner !== undefined && account.owner !== owner)) {
        throw new ConduitError('account_unknown', `no account "${id}"`);
    }
    return account;
}

/**
 * Store newly minted credentials. Reconnecting (`replace`) or connecting the
 * same external account again for the same owner updates that account
 * instead of creating a duplicate.
 */
export async function upsertAccount(
    k: Kernel,
    input: { owner: string; connector: string; method: string; credentials: Credentials; identity: Identity; replace?: string }
): Promise<StoredAccount> {
    const now = k.now();
    const sealed = await seal(k, input.credentials);
    let existing: StoredAccount | undefined;
    if (input.replace) existing = await loadAccount(k, input.replace, input.owner);
    else if (input.identity.externalId !== undefined) {
        existing = (await k.accounts.list({ owner: input.owner, connector: input.connector })).find(
            (a) => a.externalId === input.identity.externalId && a.method === input.method
        );
    }

    if (existing) {
        const next: StoredAccount = {
            ...existing,
            method: input.method,
            status: 'active',
            externalId: input.identity.externalId ?? existing.externalId,
            displayName: input.identity.displayName ?? existing.displayName,
            data: input.identity.data ?? existing.data,
            credentials: sealed,
            expiresAt: input.credentials.expiresAt,
            updatedAt: now,
            version: existing.version + 1
        };
        if (!(await k.accounts.update(next, existing.version))) {
            throw new ConduitError('account_conflict', `account "${existing.id}" changed while it was being reconnected — try again`);
        }
        k.plugins.emitAccount({ type: 'updated', account: toInfo(next) });
        return next;
    }

    const account: StoredAccount = {
        id: `acc_${randomToken(16)}`,
        owner: input.owner,
        connector: input.connector,
        method: input.method,
        status: 'active',
        externalId: input.identity.externalId,
        displayName: input.identity.displayName,
        data: input.identity.data,
        credentials: sealed,
        expiresAt: input.credentials.expiresAt,
        createdAt: now,
        updatedAt: now,
        version: 1
    };
    if (account.externalId === undefined) delete account.externalId;
    if (account.displayName === undefined) delete account.displayName;
    if (account.data === undefined) delete account.data;
    if (account.expiresAt === undefined) delete account.expiresAt;
    await k.accounts.create(account);
    k.plugins.emitAccount({ type: 'created', account: toInfo(account) });
    return account;
}

export async function markNeedsReauth(k: Kernel, account: StoredAccount): Promise<void> {
    if (account.status === 'needsReauth') return;
    const next = { ...account, status: 'needsReauth' as const, updatedAt: k.now(), version: account.version + 1 };
    if (await k.accounts.update(next, account.version)) {
        k.plugins.emitAccount({ type: 'needsReauth', account: toInfo(next) });
    }
}

function expiring(k: Kernel, method: AuthMethod, credentials: Credentials): boolean {
    if (credentials.expiresAt === undefined) return false;
    return credentials.expiresAt - (method.refreshSkewSec ?? 60) * 1000 <= k.now();
}

export interface Fresh {
    account: StoredAccount;
    credentials: Credentials;
}

/**
 * Credentials usable right now. `force` renews even when not expiring (after
 * a 401) — unless someone else already renewed since `seen`.
 */
export async function ensureFresh(
    k: Kernel,
    loaded: LoadedConnector,
    method: AuthMethod,
    current: Fresh,
    options: { force?: boolean; ctx?: Partial<CallContext> } = {}
): Promise<Fresh> {
    if (!options.force && !expiring(k, method, current.credentials)) return current;

    return k.locks.withLock(`conduit:account:${current.account.id}`, async () => {
        const latest = await k.accounts.get(current.account.id);
        if (!latest) throw new ConduitError('account_unknown', `no account "${current.account.id}"`);
        const latestCredentials = latest.version === current.account.version ? current.credentials : await open(k, latest);

        // Someone renewed while we waited (or since our 401): use theirs.
        if (latest.version !== current.account.version && !expiring(k, method, latestCredentials)) {
            return { account: latest, credentials: latestCredentials };
        }
        if (!options.force && !expiring(k, method, latestCredentials)) return { account: latest, credentials: latestCredentials };

        if (!canRefresh(method, latestCredentials)) {
            if (options.force) {
                throw new ConduitAuthError(`account "${latest.id}" was rejected and cannot be renewed automatically`, { accountId: latest.id, needsReauth: true });
            }
            await markNeedsReauth(k, latest);
            throw new ConduitAuthError(`the credentials of account "${latest.id}" expired and cannot be renewed automatically`, {
                accountId: latest.id,
                needsReauth: true
            });
        }

        const ctx: CallContext = {
            loaded,
            guard: loaded.guard,
            method,
            credentials: latestCredentials,
            info: { connector: loaded.spec.id, account: latest.id },
            mask: maskerFor(method, latestCredentials),
            ...options.ctx
        };

        let renewed: Credentials;
        try {
            renewed = await refresh(k, ctx, method, latestCredentials, latest.owner);
        } catch (e) {
            // A refused grant means the owner has to reconnect. A transient failure does not.
            if (e instanceof ConduitRequestError && !e.retryable && (e.kind === 'auth' || e.kind === 'validation' || e.kind === 'forbidden')) {
                await markNeedsReauth(k, latest);
                throw new ConduitAuthError(`renewing the credentials of account "${latest.id}" was refused: ${e.message}`, {
                    accountId: latest.id,
                    needsReauth: true,
                    cause: e
                });
            }
            throw e;
        }

        const next: StoredAccount = {
            ...latest,
            status: 'active',
            credentials: await seal(k, renewed),
            expiresAt: renewed.expiresAt,
            updatedAt: k.now(),
            version: latest.version + 1
        };
        if (next.expiresAt === undefined) delete next.expiresAt;
        if (!(await k.accounts.update(next, latest.version))) {
            // Lost a race with a writer that did not take the lock: theirs wins.
            const winner = await loadAccount(k, latest.id);
            return { account: winner, credentials: await open(k, winner) };
        }
        k.plugins.emitAccount({ type: 'refreshed', account: toInfo(next) });
        return { account: next, credentials: renewed };
    });
}
