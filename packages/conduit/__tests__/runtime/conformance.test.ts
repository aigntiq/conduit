import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inProcessLocks, memoryAccounts, memoryTransient, type AccountStore, type LockProvider, type TransientStore } from '@aigntiq/conduit';
import {
    ConformanceError,
    accountStoreConformance,
    lockProviderConformance,
    registerConformance,
    transientStoreConformance,
    type ConformanceSuite
} from '@aigntiq/conduit/testing';

const TESTING_SRC = join(__dirname, '..', '..', 'src', 'testing');

/** Run every case without a runner; collect the failures. */
async function failures(suite: ConformanceSuite): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const c of suite.cases) {
        await c.run().catch((e: unknown) => {
            out[c.name] = e instanceof ConformanceError ? e.message : `not a ConformanceError: ${String(e)}`;
        });
    }
    return out;
}

describe('the conformance suites', () => {
    it('import no test runner and no Node built-in, so any runner and runtime can use them', () => {
        for (const file of readdirSync(TESTING_SRC)) {
            // Statements only, not the usage example in a doc comment.
            const specifiers = [...readFileSync(join(TESTING_SRC, file), 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map((m) => m[1]!);
            expect(specifiers.filter((s) => !s.startsWith('.')), file).toEqual([]);
        }
    });

    it('are plain data: named suites of named cases', () => {
        const suite = accountStoreConformance('memory', () => memoryAccounts());
        expect(suite.name).toBe('AccountStore conformance: memory');
        expect(suite.cases.map((c) => c.name)).toEqual([
            'creates, reads, lists and deletes',
            'rejects creating an existing id',
            'updates only when the version matches (compare-and-set)',
            'returns copies — mutating a result does not change the store'
        ]);
    });

    it('pass for the in-memory defaults when run without a runner', async () => {
        expect(await failures(accountStoreConformance('memory', () => memoryAccounts()))).toEqual({});
        expect(await failures(transientStoreConformance('memory', (clock) => memoryTransient({ now: () => clock.now })))).toEqual({});
        expect(await failures(lockProviderConformance('memory', () => inProcessLocks()))).toEqual({});
    });

    it('fail a broken AccountStore with a ConformanceError naming the check', async () => {
        // Leaks references, ignores the version and accepts duplicate ids.
        const leaky = (): AccountStore => {
            const rows = new Map<string, Parameters<AccountStore['create']>[0]>();
            return {
                get: async (id) => rows.get(id),
                list: async (filter = {}) => [...rows.values()].filter((a) => (!filter.owner || a.owner === filter.owner) && (!filter.connector || a.connector === filter.connector)),
                create: async (a) => void rows.set(a.id, a),
                update: async (a) => (rows.has(a.id) ? (rows.set(a.id, a), true) : false),
                delete: async (id) => rows.delete(id)
            };
        };
        const failed = await failures(accountStoreConformance('leaky', leaky));
        expect(Object.keys(failed)).toEqual([
            'rejects creating an existing id',
            'updates only when the version matches (compare-and-set)',
            'returns copies — mutating a result does not change the store'
        ]);
        expect(failed['rejects creating an existing id']).toBe('create("dup") twice: expected a rejection');
        expect(failed['updates only when the version matches (compare-and-set)']).toBe('update at a stale version: expected false, got true');
    });

    it('fail a TransientStore that ignores the clock, and a LockProvider that does not lock', async () => {
        const forever = (): TransientStore => {
            const values = new Map<string, string>();
            return {
                put: async (k, v) => void values.set(k, v),
                take: async (k) => {
                    const v = values.get(k);
                    values.delete(k);
                    return v;
                }
            };
        };
        expect(await failures(transientStoreConformance('forever', () => forever()))).toEqual({ 'expires values': 'take after the TTL: expected undefined, got "v"' });

        const noLock: LockProvider = { withLock: (_key, fn) => fn() };
        expect(Object.keys(await failures(lockProviderConformance('none', () => noLock)))).toEqual(['serializes work per key and releases after failures']);
    });

    it('treat an undefined property as absent, as structural equality in most runners does', async () => {
        // A store that reads optional columns back as explicit `undefined`s (a SQL row mapper, say).
        const explicit = (): AccountStore => {
            const inner = memoryAccounts();
            return { ...inner, get: async (id) => {
                const a = await inner.get(id);
                return a && { externalId: undefined, displayName: undefined, expiresAt: undefined, ...a };
            } };
        };
        expect(await failures(accountStoreConformance('explicit-undefined', explicit))).toEqual({});
    });
});

describe('registerConformance', () => {
    it('registers one describe per suite and one it per case with any runner', async () => {
        const calls: string[] = [];
        const bodies: (() => Promise<void>)[] = [];
        registerConformance(
            [accountStoreConformance('a', () => memoryAccounts()), lockProviderConformance('l', () => inProcessLocks())],
            {
                describe: (name, fn) => {
                    calls.push(`describe ${name}`);
                    fn();
                },
                it: (name, fn) => {
                    calls.push(`  it ${name}`);
                    bodies.push(fn);
                }
            }
        );
        expect(calls).toEqual([
            'describe AccountStore conformance: a',
            '  it creates, reads, lists and deletes',
            '  it rejects creating an existing id',
            '  it updates only when the version matches (compare-and-set)',
            '  it returns copies — mutating a result does not change the store',
            'describe LockProvider conformance: l',
            '  it serializes work per key and releases after failures',
            '  it does not serialize different keys'
        ]);
        await Promise.all(bodies.map((run) => run()));
    });
});
