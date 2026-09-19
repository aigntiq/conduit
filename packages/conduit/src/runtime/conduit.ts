/**
 * `createConduit` — the runtime's public surface.
 */
import { ConduitAuthError, ConduitError } from '../errors';
import { callbackParams, createPkce, buildUrl, openState, randomToken, sealState } from '../oauth';
import { webCryptoCipher, deriveKey } from '../ports/cipher';
import { inProcessLocks, memoryAccounts, memoryTransient } from '../ports/memory';
import type { AccountFilter, AccountStore, ClientResolver, HttpClient, LockProvider, OAuthClient, SecretCipher, TransientStore } from '../ports/types';
import type { ConnectorSource } from '../spec/source';
import { assertInputs, authInputs } from '../spec/inputs';
import type { ConnectorSpec, OAuth2Method } from '../spec/types';
import type { Diagnostic } from '../errors';
import { display } from '../expr/evaluate';
import { renderTemplate } from '../expr/template';
import type { RequestMiddleware } from '../http/perform';
import { exchangeCode, identify, mint, resolveClient, revokeRemote, testCredentials } from './auth-flows';
import { ensureFresh, loadAccount, open, seal, toInfo, upsertAccount } from './accounts';
import { execute, normalizeOptions } from './execute';
import { accountScope, maskerFor, type CallContext, type Kernel } from './kernel';
import { PluginHost, type ConduitPlugin, type ConduitRoute } from './plugins';
import { ConnectorRegistry, type LoadedConnector } from './registry';
import type {
    AccountInfo,
    ConnectorDescription,
    ConnectorSummary,
    ExecuteRequest,
    ExecuteResult,
    OptionItem
} from './types';

export interface ConduitOptions {
    /** Where connector specs come from. Earlier sources win on duplicate ids. */
    sources: ConnectorSource | ConnectorSource[];
    /**
     * A long random secret (≥ 32 chars). Signs OAuth state and — unless
     * `cipher` is given — derives the key that seals credentials.
     */
    secret: string;
    accounts?: AccountStore;
    transient?: TransientStore;
    locks?: LockProvider;
    /** Seals credentials at rest. Default: AES-256-GCM keyed from `secret`. */
    cipher?: SecretCipher;
    /** OAuth clients: a resolver, or a map keyed `connector` or `connector/method`. */
    clients?: ClientResolver | Record<string, OAuthClient>;
    /** Default OAuth redirect URI (the absolute URL of your callback route). */
    redirectUri?: string;
    /** Per-connector config overrides, merged over each spec's `config`. */
    config?: Record<string, Record<string, unknown>>;
    /** Values templates can read as `env`. Nothing from the process environment is exposed unless you put it here. */
    env?: Record<string, unknown>;
    /** Extra hosts every connector may reach. `*` disables the host guard (not recommended). */
    allowHosts?: string[];
    /** `fetch` replacement. Default `globalThis.fetch`. */
    http?: HttpClient;
    /** Request middleware, after plugin middleware. */
    middleware?: RequestMiddleware[];
    plugins?: ConduitPlugin[];
    /** Clock, epoch ms. For tests. */
    now?: () => number;
    /** OAuth handshake lifetime. Default 10 minutes. */
    authTtlMs?: number;
}

export interface BeginAuthRequest {
    connector: string;
    method: string;
    owner: string;
    /** Values for the method's `inputs` (e.g. a tenant subdomain, or a bring-your-own client). */
    inputs?: Record<string, unknown>;
    /** Where the provider sends the owner back. Default: `ConduitOptions.redirectUri`. */
    redirectUri?: string;
    /** Opaque value handed back by `complete` — typically where to send the owner next. */
    returnTo?: string;
    /** Override the method's `scopes`. */
    scopes?: string[];
    /** Reconnect this existing account instead of creating a new one. */
    account?: string;
}

export type BeginAuthResult =
    | { type: 'redirect'; url: string; state: string }
    | { type: 'connected'; account: AccountInfo };

export type CompleteAuthRequest =
    | { callbackUrl: string }
    | { params: Record<string, string | undefined> };

export interface ConnectRequest {
    connector: string;
    method: string;
    owner: string;
    inputs?: Record<string, unknown>;
    /** Replace the credentials of this existing account. */
    account?: string;
}

export interface Conduit {
    readonly connectors: {
        list(): Promise<ConnectorSummary[]>;
        get(id: string): Promise<ConnectorSpec>;
        describe(id: string): Promise<ConnectorDescription>;
        /** Validation diagnostics for every connector, including invalid ones. */
        diagnostics(): Promise<Record<string, Diagnostic[]>>;
        /** Drop cached specs so the next call re-reads the sources. */
        reload(id?: string): void;
    };
    readonly accounts: {
        get(id: string, owner?: string): Promise<AccountInfo | undefined>;
        list(filter?: AccountFilter): Promise<AccountInfo[]>;
        /** Remove an account without contacting the provider. See `auth.revoke`. */
        delete(id: string, owner?: string): Promise<boolean>;
    };
    readonly auth: {
        /** Start connecting. Redirect-based methods return a URL; the rest connect immediately. */
        begin(request: BeginAuthRequest): Promise<BeginAuthResult>;
        /** Finish a redirect-based connection from the callback. */
        complete(request: CompleteAuthRequest): Promise<{ account: AccountInfo; returnTo?: string }>;
        /** Connect a method that needs no redirect (API key, basic, bearer, client credentials, JWT, custom). */
        connect(request: ConnectRequest): Promise<AccountInfo>;
        /** Run the method's `test` request. */
        test(accountId: string, owner?: string): Promise<{ ok: true } | { ok: false; error: ConduitError }>;
        /** Renew credentials now. */
        refresh(accountId: string, owner?: string): Promise<AccountInfo>;
        /** Revoke at the provider (best effort) and delete the account. */
        revoke(accountId: string, owner?: string): Promise<void>;
    };
    execute(request: ExecuteRequest): Promise<ExecuteResult>;
    /** Run an `options` operation and return `{label, value}` items. */
    options(request: ExecuteRequest): Promise<OptionItem[]>;
    /** Routes contributed by plugins, served by `createFetchHandler`. */
    readonly routes: readonly ConduitRoute[];
    /** Stop watching sources. */
    close(): void;
}

function clientResolver(clients: ConduitOptions['clients']): ClientResolver {
    if (!clients) return () => undefined;
    if (typeof clients === 'function') return clients;
    return ({ connector, method }) => clients[`${connector}/${method}`] ?? clients[connector];
}

interface Stash {
    verifier?: string;
    redirectUri: string;
    /** Sealed connect inputs — they may hold a bring-your-own client secret. */
    inputs: string;
}

export function createConduit(options: ConduitOptions): Conduit {
    if (!options.secret || options.secret.length < 32) throw new ConduitError('config_invalid', 'createConduit needs a secret of at least 32 characters');

    const plugins = new PluginHost();
    plugins.install(options.plugins ?? []);
    const env = { ...options.env };
    const sources = Array.isArray(options.sources) ? options.sources : [options.sources];
    const now = options.now ?? Date.now;
    const authTtlMs = options.authTtlMs ?? 10 * 60_000;
    const fetchImpl: HttpClient = options.http ?? ((request) => fetch(request));

    const registry = new ConnectorRegistry({
        sources,
        pluginFunctions: () => plugins.functions,
        pluginEncodings: () => plugins.encoders.keys(),
        config: options.config ?? {},
        env,
        allowHosts: options.allowHosts ?? []
    });

    const k: Kernel = {
        registry,
        accounts: options.accounts ?? memoryAccounts(),
        transient: options.transient ?? memoryTransient({ now }),
        locks: options.locks ?? inProcessLocks(),
        cipher: options.cipher ?? webCryptoCipher(options.secret),
        stateKey: deriveKey(options.secret, 'oauth-state/v1', 'hmac'),
        clients: clientResolver(options.clients),
        plugins,
        http: { fetch: fetchImpl, middleware: options.middleware ?? [], now },
        env,
        now,
        redirectUri: options.redirectUri
    };

    const baseCtx = (loaded: LoadedConnector, extra: Partial<CallContext> = {}): CallContext => ({
        loaded,
        guard: loaded.guard,
        info: { connector: loaded.spec.id },
        mask: maskerFor(undefined, undefined),
        ...extra
    });

    async function connect(request: ConnectRequest): Promise<AccountInfo> {
        const loaded = await registry.get(request.connector);
        const method = loaded.method(request.method);
        const values = assertInputs(authInputs(method), request.inputs, 'connect inputs');
        const ctx = baseCtx(loaded, { method, mask: maskerFor(method, { values }) });
        const { credentials, tokenResponse } = await mint(k, ctx, method, values, request.owner);
        const withCreds = { ...ctx, credentials, mask: maskerFor(method, credentials) };
        await testCredentials(k, withCreds, method);
        const identity = await identify(k, withCreds, method, tokenResponse);
        const account = await upsertAccount(k, {
            owner: request.owner,
            connector: loaded.spec.id,
            method: method.id,
            credentials,
            identity,
            replace: request.account
        });
        return toInfo(account);
    }

    const conduit: Conduit = {
        connectors: {
            async list() {
                const out: ConnectorSummary[] = [];
                for (const id of await registry.ids()) {
                    try {
                        const { spec } = await registry.get(id);
                        out.push(summary(spec));
                    } catch {
                        // Invalid connectors are not listed; see diagnostics().
                    }
                }
                return out.sort((a, b) => a.name.localeCompare(b.name));
            },
            async get(id) {
                return (await registry.get(id)).spec;
            },
            async describe(id) {
                return describe((await registry.get(id)).spec);
            },
            diagnostics: () => registry.diagnostics(),
            reload: (id) => registry.invalidate(id)
        },

        accounts: {
            async get(id, owner) {
                const a = await k.accounts.get(id);
                return a && (owner === undefined || a.owner === owner) ? toInfo(a) : undefined;
            },
            async list(filter) {
                return (await k.accounts.list(filter)).map(toInfo);
            },
            async delete(id, owner) {
                const a = await k.accounts.get(id);
                if (!a || (owner !== undefined && a.owner !== owner)) return false;
                const deleted = await k.accounts.delete(id);
                if (deleted) plugins.emitAccount({ type: 'deleted', account: toInfo(a) });
                return deleted;
            }
        },

        auth: {
            async begin(request) {
                const loaded = await registry.get(request.connector);
                const method = loaded.method(request.method);
                if (method.type !== 'oauth2' || (method.grant ?? 'authorization_code') !== 'authorization_code') {
                    return { type: 'connected', account: await connect(request) };
                }
                if (request.account) await loadAccount(k, request.account, request.owner);

                const values = assertInputs(authInputs(method), request.inputs, 'connect inputs');
                const ctx = baseCtx(loaded, { method });
                const client = await resolveClient(k, ctx, method, request.owner, values);
                const redirectUri = request.redirectUri ?? k.redirectUri;
                if (!redirectUri) throw new ConduitError('redirect_uri_missing', 'no redirectUri — pass one to begin() or createConduit()');

                const nonce = randomToken(24);
                const pkce = method.pkce === false ? undefined : await createPkce();
                const stash: Stash = { verifier: pkce?.verifier, redirectUri, inputs: await seal(k, { values }) };
                await k.transient.put(`conduit:oauth:${nonce}`, JSON.stringify(stash), authTtlMs);

                const state = await sealState(
                    { n: nonce, c: loaded.spec.id, m: method.id, o: request.owner, r: request.returnTo, a: request.account },
                    await k.stateKey,
                    { ttlMs: authTtlMs, now: now() }
                );
                const scopes = request.scopes ?? method.scopes ?? [];
                const scopeText = scopes.join(method.scopeSeparator ?? ' ');
                const scope = {
                    inputs: values,
                    config: loaded.config,
                    env,
                    client: { id: client.id },
                    oauth: { redirectUri, state, codeChallenge: pkce?.challenge, codeChallengeMethod: pkce?.method, scope: scopeText }
                };
                const evalOpts = { functions: loaded.functions, now };
                const authorizeUrl = display(await renderTemplate(method.authorizeUrl, scope, evalOpts));
                const extra = ((await renderTemplate(method.authorizeParams, scope, evalOpts)) ?? {}) as Record<string, unknown>;
                const url = buildUrl(authorizeUrl, {
                    response_type: 'code',
                    client_id: client.id,
                    redirect_uri: redirectUri,
                    scope: scopeText || undefined,
                    state,
                    code_challenge: pkce?.challenge,
                    code_challenge_method: pkce?.method,
                    ...extra
                });
                return { type: 'redirect', url, state };
            },

            async complete(request) {
                const params = 'callbackUrl' in request ? callbackParams(request.callbackUrl) : request.params;
                const stateValue = params.state;
                if (!stateValue) throw new ConduitAuthError('the callback has no state', { needsReauth: false });
                let payload: { n: string; c: string; m: string; o: string; r?: string; a?: string };
                try {
                    payload = await openState(stateValue, await k.stateKey, { now: now() });
                } catch (e) {
                    throw new ConduitAuthError(`the callback state is invalid: ${(e as Error).message}`, { needsReauth: false, cause: e });
                }
                const raw = await k.transient.take(`conduit:oauth:${payload.n}`);
                if (params.error) {
                    const detail = params.error_description ? ` — ${params.error_description}` : '';
                    throw new ConduitAuthError(`authorization was not granted: ${params.error}${detail}`, { needsReauth: false });
                }
                if (!raw) throw new ConduitAuthError('this sign-in link was already used or has expired — start again', { needsReauth: false });
                if (!params.code) throw new ConduitAuthError('the callback has no authorization code', { needsReauth: false });

                const stash = JSON.parse(raw) as Stash;
                const loaded = await registry.get(payload.c);
                const method = loaded.method(payload.m) as OAuth2Method;
                const values = (JSON.parse(await k.cipher.open(stash.inputs)) as { values: Record<string, unknown> }).values;
                const ctx = baseCtx(loaded, { method, mask: maskerFor(method, { values }) });
                const client = await resolveClient(k, ctx, method, payload.o, values);
                const { credentials, tokenResponse } = await exchangeCode(k, ctx, method, {
                    code: params.code,
                    redirectUri: stash.redirectUri,
                    verifier: stash.verifier,
                    client,
                    values
                });
                const identity = await identify(k, { ...ctx, credentials, mask: maskerFor(method, credentials) }, method, tokenResponse);
                const account = await upsertAccount(k, {
                    owner: payload.o,
                    connector: loaded.spec.id,
                    method: method.id,
                    credentials,
                    identity,
                    replace: payload.a
                });
                return payload.r === undefined ? { account: toInfo(account) } : { account: toInfo(account), returnTo: payload.r };
            },

            connect,

            async test(accountId, owner) {
                const stored = await loadAccount(k, accountId, owner);
                const loaded = await registry.get(stored.connector);
                const method = loaded.method(stored.method);
                try {
                    const fresh = await ensureFresh(k, loaded, method, { account: stored, credentials: await open(k, stored) });
                    const ctx = baseCtx(loaded, {
                        method,
                        credentials: fresh.credentials,
                        mask: maskerFor(method, fresh.credentials),
                        info: { connector: loaded.spec.id, account: stored.id }
                    });
                    if (!(await testCredentials(k, ctx, method, accountScope(fresh.account)))) {
                        throw new ConduitError('test_unavailable', `auth method "${method.id}" declares no test request`);
                    }
                    return { ok: true };
                } catch (e) {
                    if (e instanceof ConduitError) return { ok: false, error: e };
                    throw e;
                }
            },

            async refresh(accountId, owner) {
                const stored = await loadAccount(k, accountId, owner);
                const loaded = await registry.get(stored.connector);
                const method = loaded.method(stored.method);
                const fresh = await ensureFresh(k, loaded, method, { account: stored, credentials: await open(k, stored) }, { force: true });
                return toInfo(fresh.account);
            },

            async revoke(accountId, owner) {
                const stored = await loadAccount(k, accountId, owner);
                try {
                    const loaded = await registry.get(stored.connector);
                    const method = loaded.method(stored.method);
                    const credentials = await open(k, stored);
                    await revokeRemote(k, baseCtx(loaded, { method, credentials, mask: maskerFor(method, credentials) }), method, credentials, stored.owner);
                } catch {
                    // The connector may be gone or the credentials unreadable: still delete.
                }
                if (await k.accounts.delete(stored.id)) plugins.emitAccount({ type: 'deleted', account: toInfo(stored) });
            }
        },

        async execute(request) {
            const { kind: _kind, ...result } = await execute(k, request);
            return result;
        },

        async options(request) {
            const loaded = await registry.get(request.connector);
            const op = loaded.operation(request.operation);
            if (op.kind !== 'options') throw new ConduitError('operation_kind', `"${op.id}" is a ${op.kind} operation, not options`);
            const { output } = await execute(k, request);
            return normalizeOptions(output);
        },

        routes: plugins.routes,

        close() {
            registry.close();
        }
    };
    return conduit;
}

function summary(spec: ConnectorSpec): ConnectorSummary {
    const s: ConnectorSummary = { id: spec.id, name: spec.name, version: spec.version };
    if (spec.description !== undefined) s.description = spec.description;
    if (spec.icon !== undefined) s.icon = spec.icon;
    if (spec.categories !== undefined) s.categories = spec.categories;
    return s;
}

function describe(spec: ConnectorSpec): ConnectorDescription {
    return {
        ...summary(spec),
        auth: (spec.auth ?? []).map((m) => ({
            id: m.id,
            type: m.type,
            label: m.label ?? m.id,
            ...(m.description === undefined ? {} : { description: m.description }),
            inputs: authInputs(m),
            redirect: m.type === 'oauth2' && (m.grant ?? 'authorization_code') === 'authorization_code'
        })),
        operations: spec.operations.map((o) => ({
            id: o.id,
            kind: o.kind,
            label: o.label,
            ...(o.description === undefined ? {} : { description: o.description }),
            ...(o.inputs === undefined ? {} : { inputs: o.inputs }),
            ...(o.outputs === undefined ? {} : { outputs: o.outputs }),
            auth: o.auth === false ? false : (o.auth ?? (spec.auth ?? []).map((m) => m.id)),
            hidden: o.hidden ?? o.kind === 'options',
            ...(o.tags === undefined ? {} : { tags: o.tags })
        }))
    };
}

