import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConnector } from '@aigntiq/conduit';
import { catalog, connectorCatalog } from '@aigntiq/conduit-connectors';
import gmail from '@aigntiq/conduit-connectors/gmail';
import gmailSource from '../connectors/gmail/index';
import { connectorIds, exportsMap, generate, withIcon } from '../scripts/generate-lib';

const ROOT = join(__dirname, '..');

describe('generated output', () => {
    it('is in sync with the connector sources (run `pnpm --filter @aigntiq/conduit-connectors generate`)', () => {
        const specs = connectorIds(ROOT).map((id) => {
            expect(id).toBe('gmail'); // add new connectors to this list's imports
            return withIcon(ROOT, gmailSource);
        });
        for (const file of generate(specs)) {
            expect(readFileSync(join(ROOT, file.path), 'utf8'), file.path).toBe(file.content);
        }
        const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        expect(manifest.exports).toEqual(exportsMap(connectorIds(ROOT)));
    });

    it('ships only spotless connectors', () => {
        expect(validateConnector(gmail).diagnostics).toEqual([]);
        expect(() => generate([{ ...gmail, operations: [...gmail.operations, { id: 'x', kind: 'action', label: 'X', request: { url: '{{ nope( }}' } }] }])).toThrow(
            /connector "gmail" has 1 diagnostic/
        );
    });

    it('ships the same spec as a module, as JSON and through the catalog', async () => {
        const json = JSON.parse(readFileSync(join(ROOT, 'json', 'gmail.json'), 'utf8'));
        expect(json).toEqual(JSON.parse(JSON.stringify(gmail)));
        expect(json.icon).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(await connectorCatalog({ include: ['gmail'] }).get('gmail')).toBe(gmail);
    });
});

describe('connectorCatalog', () => {
    it('lists the package', () => {
        expect(catalog.map((c) => c.id)).toEqual(['gmail']);
        expect(catalog[0]).toMatchObject({ name: 'Gmail', version: '1.1.0', categories: ['email', 'productivity'] });
    });

    it('serves only what was included, loading on demand', async () => {
        const source = connectorCatalog({ include: '*' });
        expect((await source.list()).map((c) => c.id)).toEqual(['gmail']);
        expect(await connectorCatalog({ include: [] }).get('gmail')).toBeUndefined();
        expect(await source.get('elsewhere')).toBeUndefined();
    });

    it('rejects unknown connector ids up front', () => {
        // @ts-expect-error — not in the package
        expect(() => connectorCatalog({ include: ['gmial'] })).toThrow(/no connector "gmial".*available: gmail/);
    });
});
