import { readdirSync } from 'node:fs';
import { defineLibConfig } from '@sigx/vite/lib';
import type { ConfigEnv, UserConfig } from 'vite';

// One entry for the catalog plus one per connector, so each connector is its
// own subpath and bundlers only include the ones a host imports.
const connectors = readdirSync(new URL('./connectors', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

const base = defineLibConfig({
    entry: {
        index: 'src/index.ts',
        ...Object.fromEntries(connectors.map((id) => [id, `src/generated/${id}.ts`]))
    },
    external: [/@sigx\/.*/, /^node:/],
    platform: 'neutral',
    root: import.meta.url
}) as (env: ConfigEnv) => UserConfig;

export default (env: ConfigEnv): UserConfig => {
    const config = base(env);
    if (env.mode !== 'prod-dist') {
        config.define = {
            ...config.define,
            __DEV__: "(typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')"
        };
    }
    return config;
};
