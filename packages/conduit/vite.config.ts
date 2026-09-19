import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// Standard sigx lib build: a dev pass (`vite build`) emits dist/<entry>.js, a
// prod pass (`vite build --mode prod-dist`) emits dist/<entry>.prod.js with
// `__DEV__` pinned to `false`. `.d.ts` come from `tsc -p tsconfig.build.json`.
//
// `./testing` is deliberately NOT an entry: it is alias-only inside this
// workspace (tests and examples), never published.
const base = defineLibConfig({
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
    external: [/@sigx\/.*/, /^node:/],
    platform: 'neutral',
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => {
    const config = base(env);
    // The dev dist must not assume a `process` global: keep the `typeof
    // process` guard so runtimes without one don't throw on a dev path.
    if (env.mode !== 'prod-dist') {
        config.define = {
            ...config.define,
            __DEV__: "(typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')"
        };
    }
    return config;
};
