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
        // MORE SPECIFIC FIRST: aliases match in order. (An array, so a
        // pattern can map every connector subpath to its generated module.)
        alias: [
            { find: '@aigntiq/conduit/expr', replacement: src('expr/index.ts') },
            { find: '@aigntiq/conduit/schema', replacement: src('schema/index.ts') },
            { find: '@aigntiq/conduit/oauth', replacement: src('oauth/index.ts') },
            { find: '@aigntiq/conduit/server', replacement: src('server/index.ts') },
            { find: '@aigntiq/conduit/node', replacement: src('node/index.ts') },
            { find: '@aigntiq/conduit/builder', replacement: src('builder/index.ts') },
            { find: '@aigntiq/conduit/testing', replacement: src('testing/index.ts') },
            // Workspace-only: the Node mock provider is not part of any published entry.
            { find: '@aigntiq/conduit/test/mock-provider', replacement: resolve(__dirname, 'packages/conduit/test/mock-provider.ts') },
            { find: /^@aigntiq\/conduit$/, replacement: src('index.ts') },
            // `@aigntiq/conduit-connectors/<id>` → that connector's generated module.
            { find: /^@aigntiq\/conduit-connectors\/([\w-]+)$/, replacement: resolve(__dirname, 'packages/conduit-connectors/src/generated/$1.ts') },
            { find: /^@aigntiq\/conduit-connectors$/, replacement: resolve(__dirname, 'packages/conduit-connectors/src/index.ts') }
        ]
    }
});
