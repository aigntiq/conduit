import { defineLibBuild } from '../../scripts/lib/lib-build.ts';

// `./testing` is deliberately NOT an entry: it is alias-only inside this
// workspace (tests and examples), never published.
export default defineLibBuild({
    entry: {
        index: 'src/index.ts',
        expr: 'src/expr/index.ts',
        schema: 'src/schema/index.ts',
        oauth: 'src/oauth/index.ts',
        server: 'src/server/index.ts',
        node: 'src/node/index.ts',
        builder: 'src/builder/index.ts'
    },
    // `node:` imports are only legal under src/node — everything else runs on
    // any WinterCG runtime (fetch + WebCrypto). Keeping them external here is
    // the belt; the import-boundary test is the braces.
    external: [/^node:/],
    root: import.meta.url
});
