import { readdirSync } from 'node:fs';
import { defineLibBuild } from '../../scripts/lib/lib-build.ts';

// One entry for the catalog plus one per connector, so each connector is its
// own subpath and bundlers only include the ones a host imports.
const connectors = readdirSync(new URL('./connectors', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

export default defineLibBuild({
    entry: {
        index: 'src/index.ts',
        ...Object.fromEntries(connectors.map((id) => [id, `src/generated/${id}.ts`]))
    },
    // The connectors import @aigntiq/conduit as a peer, never bundle it.
    external: [/^@aigntiq\/conduit(\/.*)?$/, /^node:/],
    root: import.meta.url
});
