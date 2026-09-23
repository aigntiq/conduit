#!/usr/bin/env node
/**
 * gen-schema.mjs — `pnpm gen:schema`.
 *
 * Writes packages/conduit/schema/conduit-1.schema.json from the TypeScript
 * source of truth (src/schema/conduit-1.ts). A unit test fails when the two
 * drift, so run this after editing the schema. Loads the source through
 * Vite, so it resolves imports exactly as the build does.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null }
});
try {
    const { conduitSchema } = await server.ssrLoadModule('/packages/conduit/src/schema/conduit-1.ts');
    const out = join(root, 'packages', 'conduit', 'schema', 'conduit-1.schema.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(conduitSchema, null, 2) + '\n');
    console.log(`wrote ${out}`);
} finally {
    await server.close();
}
