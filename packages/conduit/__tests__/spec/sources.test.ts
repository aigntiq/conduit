import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConduitSpecError, compositeSource, memorySource, type ConnectorSpec } from '@sigx/conduit';
import { fileSource } from '@sigx/conduit/node';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'connectors');

const spec = (id: string, name = id): ConnectorSpec => ({ spec: 'conduit/1', id, name, version: '1.0.0', operations: [] });

describe('memorySource', () => {
    it('lists, gets, sets, deletes and notifies', async () => {
        const source = memorySource([spec('a')]);
        const seen: (string | undefined)[] = [];
        const stop = source.watch!((id) => seen.push(id));
        source.set(spec('b'));
        expect((await source.list()).map((s) => s.id)).toEqual(['a', 'b']);
        expect(source.delete('a')).toBe(true);
        expect(source.delete('a')).toBe(false);
        expect(await source.get('a')).toBeUndefined();
        stop();
        source.set(spec('c'));
        expect(seen).toEqual(['b', 'a']);
    });
});

describe('compositeSource', () => {
    it('lets earlier sources win and fans out watches', async () => {
        const first = memorySource([spec('a', 'first')]);
        const second = memorySource([spec('a', 'second'), spec('b')]);
        const both = compositeSource(first, second);
        expect((await both.list()).map((s) => `${s.id}:${s.name}`)).toEqual(['a:first', 'b:b']);
        expect((await both.get('b'))?.id).toBe('b');
        expect(await both.get('zz')).toBeUndefined();
        const seen: (string | undefined)[] = [];
        const stop = both.watch!((id) => seen.push(id));
        second.set(spec('c'));
        stop();
        first.set(spec('d'));
        expect(seen).toEqual(['c']);
    });
});

describe('fileSource', () => {
    let dir: string | undefined;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it('assembles a directory connector: auth, operations (ids from file names) and an inlined icon', async () => {
        const acme = await fileSource(FIXTURES).get('acme-crm');
        expect(acme?.auth?.map((m) => m.id)).toEqual(['oauth', 'key']);
        expect(acme?.operations.map((o) => o.id)).toEqual(['contact-created', 'create-contact', 'get-contact', 'list-contacts', 'list-owners']);
        expect(acme?.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('loads single-file connectors and ignores unrelated JSON', async () => {
        dir = mkdtempSync(join(tmpdir(), 'conduit-src-'));
        writeFileSync(join(dir, 'one.json'), JSON.stringify(spec('one')));
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'not-a-connector' }));
        expect((await fileSource(dir).list()).map((s) => s.id)).toEqual(['one']);
    });

    it('reports unreadable JSON with its path', async () => {
        dir = mkdtempSync(join(tmpdir(), 'conduit-src-'));
        mkdirSync(join(dir, 'broken'));
        writeFileSync(join(dir, 'broken', 'connector.json'), '{ nope');
        const err = await fileSource(dir).list().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitSpecError);
        expect((err as Error).message).toMatch(/connector\.json is not valid JSON/);
    });

    it('rejects duplicate ids', async () => {
        dir = mkdtempSync(join(tmpdir(), 'conduit-src-'));
        writeFileSync(join(dir, 'a.json'), JSON.stringify(spec('same')));
        writeFileSync(join(dir, 'b.json'), JSON.stringify(spec('same')));
        await expect(fileSource(dir).list()).rejects.toThrow(/used twice/);
    });

    it('re-reads after a change when watching', async () => {
        dir = mkdtempSync(join(tmpdir(), 'conduit-src-'));
        writeFileSync(join(dir, 'a.json'), JSON.stringify(spec('a', 'before')));
        const source = fileSource(dir, { watch: true });
        expect((await source.get('a'))?.name).toBe('before');
        const changed = new Promise<void>((resolve) => {
            const stop = source.watch!(() => {
                stop();
                resolve();
            });
        });
        writeFileSync(join(dir, 'a.json'), JSON.stringify(spec('a', 'after')));
        await changed;
        expect((await source.get('a'))?.name).toBe('after');
    });
});
