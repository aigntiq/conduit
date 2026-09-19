import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const src = (p: string) => resolve(__dirname, 'packages/conduit/src', p);

export default defineConfig({
    // `__DEV__` is the compile-time dev flag package sources guard on; the build
    // replaces it in the dists, so tests must define it too.
    define: {
        __DEV__: 'true'
    },
    test: {
        environment: 'node',
        include: [
            'packages/**/__tests__/**/*.test.ts',
            'examples/**/__tests__/**/*.test.ts'
        ],
        exclude: ['**/node_modules/**'],
        globals: false
    },
    resolve: {
        // MORE SPECIFIC FIRST: aliases match by prefix, in order.
        alias: {
            '@sigx/conduit/expr': src('expr/index.ts'),
            '@sigx/conduit/schema': src('schema/index.ts'),
            '@sigx/conduit/oauth': src('oauth/index.ts'),
            '@sigx/conduit/server': src('server/index.ts'),
            '@sigx/conduit/node': src('node/index.ts'),
            '@sigx/conduit/builder': src('builder/index.ts'),
            '@sigx/conduit/testing': src('testing/index.ts'),
            '@sigx/conduit': src('index.ts'),
            '@sigx/conduit-connectors/gmail': resolve(__dirname, 'packages/conduit-connectors/src/generated/gmail.ts'),
            '@sigx/conduit-connectors': resolve(__dirname, 'packages/conduit-connectors/src/index.ts')
        }
    }
});
