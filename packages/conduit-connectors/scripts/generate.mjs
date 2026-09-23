#!/usr/bin/env node
/**
 * generate.mjs — `pnpm --filter @aigntiq/conduit-connectors generate` (also the
 * first step of `build`). Loads every `connectors/<id>/index.ts` through Vite
 * (so it resolves exactly as the build and tests do), validates it, and
 * writes the generated sources, the JSON and the package exports map. A test
 * fails when the committed output drifts from the connectors.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkg, '..', '..');
const core = (p) => join(repo, 'packages', 'conduit', 'src', p);

const server = await createServer({
    root: repo,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    resolve: {
        alias: {
            '@aigntiq/conduit/builder': core('builder/index.ts'),
            '@aigntiq/conduit/expr': core('expr/index.ts'),
            '@aigntiq/conduit': core('index.ts')
        }
    }
});

try {
    const lib = await server.ssrLoadModule('/packages/conduit-connectors/scripts/generate-lib.ts');
    const specs = [];
    for (const id of lib.connectorIds(pkg)) {
        const mod = await server.ssrLoadModule(`/packages/conduit-connectors/connectors/${id}/index.ts`);
        const spec = mod.default;
        if (!spec || spec.id !== id) throw new Error(`connectors/${id}/index.ts must default-export connector({ id: '${id}', … })`);
        specs.push(lib.withIcon(pkg, spec));
    }
    for (const file of lib.generate(specs)) {
        const out = join(pkg, file.path);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, file.content);
    }
    const manifestPath = join(pkg, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.exports = lib.exportsMap(specs.map((s) => s.id));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
    console.log(`generated ${specs.length} connector(s): ${specs.map((s) => s.id).join(', ')}`);
} finally {
    await server.close();
}
