import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigFnObject } from 'vite';

export interface LibBuildOptions {
    /** Entry name → source path, relative to the package root. */
    entry: Record<string, string>;
    /** Modules left out of the bundle. */
    external?: (string | RegExp)[];
    /** The package's `vite.config.ts` `import.meta.url`. */
    root: string;
}

/**
 * The library build every package here shares. A dev pass (`vite build`)
 * emits dist/<entry>.js; a prod pass (`vite build --mode prod-dist`) emits
 * dist/<entry>.prod.js next to it with `__DEV__` pinned to `false` and
 * `process.env.NODE_ENV` defined away, so the minifier strips dev-only code.
 * `.d.ts` come from `tsc -p tsconfig.build.json`.
 */
export function defineLibBuild({ entry, external = [], root }: LibBuildOptions): UserConfigFnObject {
    const rootDir = fileURLToPath(new URL('.', root));
    return defineConfig(({ mode }) => {
        const prodDist = mode === 'prod-dist';
        return {
            root: rootDir,
            define: prodDist
                ? { __DEV__: 'false', 'process.env.NODE_ENV': JSON.stringify('production') }
                : // The dev dist must not assume a `process` global: keep the
                  // `typeof process` guard so runtimes without one don't throw.
                  { __DEV__: "(typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')" },
            build: {
                outDir: 'dist',
                sourcemap: true,
                // The prod pass writes into the dev pass's outDir.
                emptyOutDir: !prodDist,
                lib: {
                    entry,
                    formats: ['es'],
                    fileName: (_format, name) => (prodDist ? `${name}.prod.js` : `${name}.js`)
                },
                rolldownOptions: {
                    external,
                    output: prodDist ? { chunkFileNames: '[name]-[hash].prod.js' } : {}
                },
                minify: 'oxc'
            }
        };
    });
}
