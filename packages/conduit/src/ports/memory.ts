/**
 * In-memory port implementations. Correct, not durable: fine for tests,
 * development and single-process hosts that accept losing accounts on
 * restart. Everything else wants an adapter package.
 */
import type { AccountFilter, AccountStore, LockProvider, StoredAccount, TransientStore } from './types';

export function memoryAccounts(initial: Iterable<StoredAccount> = []): AccountStore {
    const rows = new Map<string, StoredAccount>();
    for (const a of initial) rows.set(a.id, structuredClone(a));
    const matches = (a: StoredAccount, f: AccountFilter) =>
        (f.owner === undefined || a.owner === f.owner) && (f.connector === undefined || a.connector === f.connector);
    return {
        async get(id) {
            const row = rows.get(id);
            return row && structuredClone(row);
        },
        async list(filter = {}) {
            return [...rows.values()].filter((a) => matches(a, filter)).map((a) => structuredClone(a));
        },
        async create(account) {
            if (rows.has(account.id)) throw new Error(`account "${account.id}" already exists`);
            rows.set(account.id, structuredClone(account));
        },
        async update(account, expectedVersion) {
            const current = rows.get(account.id);
            if (!current || current.version !== expectedVersion) return false;
            rows.set(account.id, structuredClone(account));
            return true;
        },
        async delete(id) {
            return rows.delete(id);
        }
    };
}

export function memoryTransient(options: { now?: () => number } = {}): TransientStore {
    const now = options.now ?? Date.now;
    const rows = new Map<string, { value: string; expiresAt: number }>();
    const sweep = () => {
        const t = now();
        for (const [k, v] of rows) if (v.expiresAt <= t) rows.delete(k);
    };
    return {
        async put(key, value, ttlMs) {
            if (rows.size > 1000) sweep();
            rows.set(key, { value, expiresAt: now() + ttlMs });
        },
        async take(key) {
            const row = rows.get(key);
            rows.delete(key);
            if (!row || row.expiresAt <= now()) return undefined;
            return row.value;
        }
    };
}

/** Per-key promise chaining. Single-process only. */
export function inProcessLocks(): LockProvider {
    const tails = new Map<string, Promise<unknown>>();
    return {
        async withLock(key, fn) {
            const previous = tails.get(key) ?? Promise.resolve();
            let release!: () => void;
            const gate = new Promise<void>((r) => (release = r));
            const tail = previous.then(() => gate);
            tails.set(key, tail);
            await previous;
            try {
                return await fn();
            } finally {
                release();
                if (tails.get(key) === tail) tails.delete(key);
            }
        }
    };
}
