/**
 * Conformance suites for port implementations. An adapter package
 * (`@aigntiq/conduit-pg`, …) runs these against its own store, under any test
 * runner that has `describe` and `it`:
 *
 *     import { describe, it } from 'vitest'; // or 'node:test', or Jest's globals
 *     registerConformance(accountStoreConformance('pg', () => pgAccounts(db)), { describe, it });
 *
 * A suite is plain data — a name and named cases whose `run()` rejects on a
 * failure — so it has no dependency on any runner and no assertion library.
 */
import type { AccountStore, LockProvider, StoredAccount, TransientStore } from '../ports/types';

/** One named check. `run()` resolves when the implementation passes, and rejects with a `ConformanceError` when it does not. */
export interface ConformanceCase {
    readonly name: string;
    run(): Promise<void>;
}

/** A named group of cases, e.g. "AccountStore conformance: pg". */
export interface ConformanceSuite {
    readonly name: string;
    readonly cases: readonly ConformanceCase[];
}

/** The two functions every mainstream runner provides: vitest, Jest, Mocha, `node:test`, Bun. */
export interface TestRegistrar {
    describe(name: string, fn: () => void): unknown;
    it(name: string, fn: () => Promise<void>): unknown;
}

/** A conformance check failed. */
export class ConformanceError extends Error {
    override readonly name = 'ConformanceError';
}

/** Register a suite (or several) with a test runner: one `describe` per suite, one `it` per case. */
export function registerConformance(suites: ConformanceSuite | readonly ConformanceSuite[], runner: TestRegistrar): void {
    for (const suite of Array.isArray(suites) ? suites : [suites as ConformanceSuite]) {
        runner.describe(suite.name, () => {
            for (const c of suite.cases) runner.it(c.name, () => c.run());
        });
    }
}

// --- assertions (deliberately tiny; no runner or library) -------------------

const show = (v: unknown): string => (v === undefined ? 'undefined' : JSON.stringify(v));

/** Structural equality over JSON-like values. A key whose value is `undefined` counts as absent. */
function same(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const bb = b as unknown[];
        return a.length === bb.length && a.every((v, i) => same(v, bb[i]));
    }
    const keys = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
    const ka = keys(a);
    const kb = keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function equal(actual: unknown, expected: unknown, what: string): void {
    if (!same(actual, expected)) throw new ConformanceError(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

async function rejects(promise: Promise<unknown>, what: string): Promise<void> {
    let threw = false;
    try {
        await promise;
    } catch {
        threw = true;
    }
    if (!threw) throw new ConformanceError(`${what}: expected a rejection`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- suites -----------------------------------------------------------------

const account = (id: string, patch: Partial<StoredAccount> = {}): StoredAccount => ({
    id,
    owner: 'owner-1',
    connector: 'acme',
    method: 'oauth',
    status: 'active',
    credentials: 'v1.sealed',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...patch
});

const suite = (name: string, cases: Record<string, () => Promise<void>>): ConformanceSuite => ({
    name,
    cases: Object.entries(cases).map(([caseName, run]) => ({ name: caseName, run }))
});

/** An `AccountStore`: CRUD, listing by owner and connector, compare-and-set updates, and copies out. `factory` must return an empty store each call. */
export function accountStoreConformance(name: string, factory: () => AccountStore | Promise<AccountStore>): ConformanceSuite {
    return suite(`AccountStore conformance: ${name}`, {
        'creates, reads, lists and deletes': async () => {
            const store = await factory();
            await store.create(account('a1', { data: { region: 'eu' }, expiresAt: 5 }));
            await store.create(account('a2', { owner: 'owner-2' }));
            await store.create(account('a3', { connector: 'other' }));
            equal(await store.get('a1'), account('a1', { data: { region: 'eu' }, expiresAt: 5 }), 'get("a1")');
            equal(await store.get('missing'), undefined, 'get("missing")');
            equal((await store.list({ owner: 'owner-1' })).map((a) => a.id).sort(), ['a1', 'a3'], 'list({ owner })');
            equal((await store.list({ owner: 'owner-1', connector: 'acme' })).map((a) => a.id), ['a1'], 'list({ owner, connector })');
            equal((await store.list()).length, 3, 'list().length');
            equal(await store.delete('a1'), true, 'delete("a1")');
            equal(await store.delete('a1'), false, 'delete("a1") again');
            equal(await store.get('a1'), undefined, 'get("a1") after delete');
        },

        'rejects creating an existing id': async () => {
            const store = await factory();
            await store.create(account('dup'));
            await rejects(store.create(account('dup')), 'create("dup") twice');
        },

        'updates only when the version matches (compare-and-set)': async () => {
            const store = await factory();
            await store.create(account('cas'));
            equal(await store.update(account('cas', { version: 2, credentials: 'v1.new' }), 1), true, 'update at the current version');
            equal(await store.update(account('cas', { version: 3, credentials: 'v1.stale' }), 1), false, 'update at a stale version');
            equal((await store.get('cas'))?.credentials, 'v1.new', 'credentials after a stale update');
            equal(await store.update(account('ghost', { version: 2 }), 1), false, 'update of a missing account');
        },

        'returns copies — mutating a result does not change the store': async () => {
            const store = await factory();
            await store.create(account('copy', { data: { a: 1 } }));
            const read = await store.get('copy');
            if (!read) throw new ConformanceError('get("copy"): expected the account');
            read.data!.a = 2;
            read.status = 'needsReauth';
            equal(await store.get('copy'), account('copy', { data: { a: 1 } }), 'get("copy") after mutating a result');
        }
    });
}

/** A `TransientStore`: take-once values that expire. `factory` receives a clock the store must read `now` from. */
export function transientStoreConformance(name: string, factory: (clock: { now: number }) => TransientStore | Promise<TransientStore>): ConformanceSuite {
    return suite(`TransientStore conformance: ${name}`, {
        'takes a value once': async () => {
            const store = await factory({ now: 1000 });
            await store.put('k', 'v', 60_000);
            equal(await store.take('k'), 'v', 'first take');
            equal(await store.take('k'), undefined, 'second take');
        },

        'expires values': async () => {
            const clock = { now: 1000 };
            const store = await factory(clock);
            await store.put('k', 'v', 100);
            clock.now = 1200;
            equal(await store.take('k'), undefined, 'take after the TTL');
        }
    });
}

/** A `LockProvider`: work on one key runs one at a time, a failure releases the lock, and different keys do not wait on each other. */
export function lockProviderConformance(name: string, factory: () => LockProvider | Promise<LockProvider>): ConformanceSuite {
    return suite(`LockProvider conformance: ${name}`, {
        'serializes work per key and releases after failures': async () => {
            const locks = await factory();
            const order: string[] = [];
            const task = (id: string, ms: number, fail = false) =>
                locks.withLock('key', async () => {
                    order.push(`start ${id}`);
                    await sleep(ms);
                    order.push(`end ${id}`);
                    if (fail) throw new Error('boom');
                    return id;
                });
            const results = await Promise.allSettled([task('a', 20, true), task('b', 5), task('c', 1)]);
            equal(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'], 'order of work on one key');
            equal(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled'], 'results');
        },

        'does not serialize different keys': async () => {
            const locks = await factory();
            const order: string[] = [];
            await Promise.all([
                locks.withLock('x', async () => {
                    order.push('x start');
                    await sleep(20);
                    order.push('x end');
                }),
                locks.withLock('y', async () => {
                    order.push('y');
                })
            ]);
            equal(order, ['x start', 'y', 'x end'], 'order of work on two keys');
        }
    });
}
