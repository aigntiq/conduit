import { defineLibBuild } from '../../scripts/lib/lib-build.ts';

// `./testing` holds only the runner-agnostic conformance suites — no vitest,
// no `node:` — so it ships. The Node-only mock provider lives in `test/`,
// outside every entry.
export default defineLibBuild({
    entry: {
        index: 'src/index.ts',
        expr: 'src/expr/index.ts',
        schema: 'src/schema/index.ts',
        oauth: 'src/oauth/index.ts',
        server: 'src/server/index.ts',
        node: 'src/node/index.ts',
        builder: 'src/builder/index.ts',
        testing: 'src/testing/index.ts'
    },
    // `node:` imports are only legal under src/node — everything else runs on
    // any WinterCG runtime (fetch + WebCrypto). Keeping them external here is
    // the belt; the import-boundary test is the braces.
    external: [/^node:/],
    root: import.meta.url
});
