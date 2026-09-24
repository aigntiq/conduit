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
            '@aigntiq/conduit/expr': src('expr/index.ts'),
            '@aigntiq/conduit/schema': src('schema/index.ts'),
            '@aigntiq/conduit/oauth': src('oauth/index.ts'),
            '@aigntiq/conduit/server': src('server/index.ts'),
            '@aigntiq/conduit/node': src('node/index.ts'),
            '@aigntiq/conduit/builder': src('builder/index.ts'),
            '@aigntiq/conduit/testing': src('testing/index.ts'),
            // Workspace-only: the Node mock provider is not part of any published entry.
            '@aigntiq/conduit/test/mock-provider': resolve(__dirname, 'packages/conduit/test/mock-provider.ts'),
            '@aigntiq/conduit': src('index.ts'),
            '@aigntiq/conduit-connectors/gmail': resolve(__dirname, 'packages/conduit-connectors/src/generated/gmail.ts'),
            '@aigntiq/conduit-connectors': resolve(__dirname, 'packages/conduit-connectors/src/index.ts')
        }
    }
});
