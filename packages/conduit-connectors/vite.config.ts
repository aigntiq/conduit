import { existsSync, readdirSync } from 'node:fs';
import { defineLibBuild } from '../../scripts/lib/lib-build.ts';

// One entry for the catalog plus one per connector, so each connector is its
// own subpath and bundlers only include the ones a host imports. A directory
// without an index.ts (connectors/_shared) holds helpers, not a connector —
// the same rule as connectorIds() in scripts/generate-lib.ts.
const dir = new URL('./connectors/', import.meta.url);
const connectors = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/index.ts`, dir)))
    .map((d) => d.name)
    .sort();

export default defineLibBuild({
    entry: {
        index: 'src/index.ts',
        ...Object.fromEntries(connectors.map((id) => [id, `src/generated/${id}.ts`]))
    },
    // The connectors import @aigntiq/conduit as a peer, never bundle it.
    external: [/^@aigntiq\/conduit(\/.*)?$/, /^node:/],
    root: import.meta.url
});
