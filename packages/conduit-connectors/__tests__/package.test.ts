import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConnector, type ConnectorSpec } from '@aigntiq/conduit';
import { catalog, connectorCatalog } from '@aigntiq/conduit-connectors';
import gmail from '@aigntiq/conduit-connectors/gmail';
import { connectorIds, exportsMap, generate, withIcon } from '../scripts/generate-lib';

const ROOT = join(__dirname, '..');
const IDS = connectorIds(ROOT);

/** Every connector's builder source, loaded the way `generate` loads it. */
async function sources(): Promise<ConnectorSpec[]> {
    return Promise.all(
        IDS.map(async (id) => {
            const spec = ((await import(`../connectors/${id}/index.ts`)) as { default: ConnectorSpec }).default;
            expect(spec.id, `connectors/${id}/index.ts`).toBe(id);
            return withIcon(ROOT, spec);
        })
    );
}

describe('generated output', () => {
    it('is in sync with the connector sources (run `pnpm --filter @aigntiq/conduit-connectors generate`)', async () => {
        for (const file of generate(await sources())) {
            expect(readFileSync(join(ROOT, file.path), 'utf8'), file.path).toBe(file.content);
        }
        const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        expect(manifest.exports).toEqual(exportsMap(IDS));
    });

    it.each(IDS)('%s declares no maxPages input (the caller sets paging.maxPages)', async (id) => {
        const spec = ((await import(`../src/generated/${id}.ts`)) as { default: ConnectorSpec }).default;
        for (const op of spec.operations) expect(Object.keys(op.inputs?.properties ?? {}), `${id} ${op.id}`).not.toContain('maxPages');
    });

    it.each(IDS)('%s ships an icon, a README and replay tests', (id) => {
        for (const path of [`connectors/${id}/icon.svg`, `connectors/${id}/README.md`, `__tests__/${id}.test.ts`]) {
            expect(existsSync(join(ROOT, path)), path).toBe(true);
        }
    });

    it('ships only spotless connectors', () => {
        expect(validateConnector(gmail).diagnostics).toEqual([]);
        expect(() => generate([{ ...gmail, operations: [...gmail.operations, { id: 'x', kind: 'action', label: 'X', request: { url: '{{ nope( }}' } }] }])).toThrow(
            /connector "gmail" has 1 diagnostic/
        );
    });

    it.each(IDS)('%s ships the same spec as a module, as JSON and through the catalog', async (id) => {
        const module = ((await import(`../src/generated/${id}.ts`)) as { default: ConnectorSpec }).default;
        const json = JSON.parse(readFileSync(join(ROOT, 'json', `${id}.json`), 'utf8'));
        expect(json).toEqual(JSON.parse(JSON.stringify(module)));
        expect(json.icon).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(await connectorCatalog({ include: '*' }).get(id)).toBe(module);
    });
});

describe('connectorCatalog', () => {
    it('lists the package', () => {
        expect(catalog.map((c) => c.id)).toEqual(IDS);
        expect(catalog.find((c) => c.id === 'gmail')).toMatchObject({ name: 'Gmail', version: '1.0.0', categories: ['email', 'productivity'] });
    });

    it('serves only what was included, loading on demand', async () => {
        const source = connectorCatalog({ include: '*' });
        expect((await source.list()).map((c) => c.id)).toEqual(IDS);
        expect(await connectorCatalog({ include: [] }).get('gmail')).toBeUndefined();
        expect(await source.get('elsewhere')).toBeUndefined();
    });

    it('rejects unknown connector ids up front', () => {
        // @ts-expect-error — not in the package
        expect(() => connectorCatalog({ include: ['gmial'] })).toThrow(new RegExp(`no connector "gmial".*available: ${IDS.join(', ')}`));
    });
});
