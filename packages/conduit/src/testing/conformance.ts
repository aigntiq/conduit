/**
 * Conformance suites for port implementations. An adapter package
 * (`@aigntiq/conduit-pg`, …) runs these against its own store:
 *
 *     accountStoreConformance('pg', () => pgAccounts(db));
 *
 * Each registers a vitest `describe` block.
 */
import { describe, expect, it } from 'vitest';
import type { AccountStore, LockProvider, StoredAccount, TransientStore } from '../ports/types';

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

export function accountStoreConformance(name: string, factory: () => AccountStore | Promise<AccountStore>): void {
    describe(`AccountStore conformance: ${name}`, () => {
        it('creates, reads, lists and deletes', async () => {
            const store = await factory();
            await store.create(account('a1', { data: { region: 'eu' }, expiresAt: 5 }));
            await store.create(account('a2', { owner: 'owner-2' }));
            await store.create(account('a3', { connector: 'other' }));
            expect(await store.get('a1')).toEqual(account('a1', { data: { region: 'eu' }, expiresAt: 5 }));
            expect(await store.get('missing')).toBeUndefined();
            expect((await store.list({ owner: 'owner-1' })).map((a) => a.id).sort()).toEqual(['a1', 'a3']);
            expect((await store.list({ owner: 'owner-1', connector: 'acme' })).map((a) => a.id)).toEqual(['a1']);
            expect((await store.list()).length).toBe(3);
            expect(await store.delete('a1')).toBe(true);
            expect(await store.delete('a1')).toBe(false);
            expect(await store.get('a1')).toBeUndefined();
        });

        it('rejects creating an existing id', async () => {
            const store = await factory();
            await store.create(account('dup'));
            await expect(store.create(account('dup'))).rejects.toThrow();
        });

        it('updates only when the version matches (compare-and-set)', async () => {
            const store = await factory();
            await store.create(account('cas'));
            expect(await store.update(account('cas', { version: 2, credentials: 'v1.new' }), 1)).toBe(true);
            expect(await store.update(account('cas', { version: 3, credentials: 'v1.stale' }), 1)).toBe(false);
            expect((await store.get('cas'))?.credentials).toBe('v1.new');
            expect(await store.update(account('ghost', { version: 2 }), 1)).toBe(false);
        });

        it('returns copies — mutating a result does not change the store', async () => {
            const store = await factory();
            await store.create(account('copy', { data: { a: 1 } }));
            const read = (await store.get('copy'))!;
            read.data!.a = 2;
            read.status = 'needsReauth';
            expect(await store.get('copy')).toEqual(account('copy', { data: { a: 1 } }));
        });
    });
}

export function transientStoreConformance(name: string, factory: (clock: { now: number }) => TransientStore | Promise<TransientStore>): void {
    describe(`TransientStore conformance: ${name}`, () => {
        it('takes a value once', async () => {
            const store = await factory({ now: 1000 });
            await store.put('k', 'v', 60_000);
            expect(await store.take('k')).toBe('v');
            expect(await store.take('k')).toBeUndefined();
        });

        it('expires values', async () => {
            const clock = { now: 1000 };
            const store = await factory(clock);
            await store.put('k', 'v', 100);
            clock.now = 1200;
            expect(await store.take('k')).toBeUndefined();
        });
    });
}

export function lockProviderConformance(name: string, factory: () => LockProvider | Promise<LockProvider>): void {
    describe(`LockProvider conformance: ${name}`, () => {
        it('serializes work per key and releases after failures', async () => {
            const locks = await factory();
            const order: string[] = [];
            const task = (id: string, ms: number, fail = false) =>
                locks.withLock('key', async () => {
                    order.push(`start ${id}`);
                    await new Promise((r) => setTimeout(r, ms));
                    order.push(`end ${id}`);
                    if (fail) throw new Error('boom');
                    return id;
                });
            const results = await Promise.allSettled([task('a', 20, true), task('b', 5), task('c', 1)]);
            expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
            expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
        });

        it('does not serialize different keys', async () => {
            const locks = await factory();
            const order: string[] = [];
            await Promise.all([
                locks.withLock('x', async () => {
                    order.push('x start');
                    await new Promise((r) => setTimeout(r, 20));
                    order.push('x end');
                }),
                locks.withLock('y', async () => {
                    order.push('y');
                })
            ]);
            expect(order).toEqual(['x start', 'y', 'x end']);
        });
    });
}
