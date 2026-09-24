#!/usr/bin/env node

/**
 * Conduit - Pre-publish pack smoke test
 *
 * Catches packaging bugs that lint/typecheck/test miss:
 *   - missing files in `files` array
 *   - broken `exports` map
 *   - a runtime-neutral entry that grew a `node:` import
 *
 * What it does:
 *   1. Build the packages (delegates to `pnpm run build`).
 *   2. `pnpm pack` every publishable package into a temp dir.
 *   3. Spin up a scratch project with file: deps on the tarballs.
 *   4. `npm install`, then import every published subpath under `node`.
 *
 * Usage:
 *   node scripts/verify-pack.js
 *
 * No flags. Exits non-zero on any failure.
 */

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Keep in step with scripts/publish.js.
const PACKAGES = ['packages/conduit', 'packages/conduit-connectors'];

// Entries that must run on ANY WinterCG runtime — no `node:` specifier may
// appear in their built output (or in a chunk they pull in). `./node` is the
// one entry allowed to touch Node built-ins.
const NEUTRAL_SUBPATHS = ['.', './expr', './schema', './oauth', './server', './builder', './testing'];

const sandbox = join(tmpdir(), `aigntiq-conduit-verify-pack-${Date.now()}`);
const tarballDir = join(sandbox, 'tarballs');
const appDir = join(sandbox, 'app');

function run(cmd, opts = {}) {
    console.log(`$ ${cmd}${opts.cwd ? `  (in ${opts.cwd})` : ''}`);
    execSync(cmd, { stdio: 'inherit', ...opts });
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Every file an exports-map condition points at must exist in the package dir. */
function checkExportTargets(pkgDir, pkg) {
    const missing = [];
    for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
        const targets = typeof target === 'string' ? [target] : Object.values(target);
        for (const t of targets) {
            // A wildcard target (`./json/*`) must name a directory with files in it.
            const ok = t.includes('*')
                ? existsSync(join(pkgDir, t.slice(0, t.indexOf('*')))) && readdirSync(join(pkgDir, t.slice(0, t.indexOf('*')))).length > 0
                : existsSync(join(pkgDir, t));
            if (!ok) missing.push(`${subpath} → ${t}`);
        }
    }
    if (missing.length) {
        throw new Error(`${pkg.name}: exports point at missing files:\n  ${missing.join('\n  ')}`);
    }
}

/** Walk a built entry's static imports and fail on any `node:` specifier. */
function checkNeutral(pkgDir, pkg) {
    const seen = new Set();
    const visit = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(file, 'utf-8');
        const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
        for (const m of text.matchAll(re)) {
            const spec = m[1] ?? m[2];
            if (spec.startsWith('node:')) {
                throw new Error(`${pkg.name}: runtime-neutral file ${file} imports ${spec}`);
            }
            if (spec.startsWith('./')) visit(join(dirname(file), spec));
        }
    };
    for (const sub of NEUTRAL_SUBPATHS) {
        const entry = pkg.exports?.[sub];
        if (!entry) continue;
        visit(join(pkgDir, entry.import));
        visit(join(pkgDir, entry.production));
    }
}

function main() {
    console.log('\n▶  Build');
    run('pnpm run build', { cwd: rootDir });

    mkdirSync(tarballDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    console.log('\n▶  Static checks + pack');
    const deps = {};
    const smoke = [];
    for (const rel of PACKAGES) {
        const pkgDir = join(rootDir, rel);
        const pkg = readJson(join(pkgDir, 'package.json'));
        checkExportTargets(pkgDir, pkg);
        checkNeutral(pkgDir, pkg);
        run(`pnpm pack --pack-destination "${tarballDir}"`, { cwd: pkgDir });
        const prefix = pkg.name.replace('@', '').replace('/', '-') + '-';
        const tarball = readdirSync(tarballDir).find(
            (f) => f.startsWith(prefix) && f.endsWith('.tgz') && /^\d/.test(f.slice(prefix.length))
        );
        if (!tarball) throw new Error(`${pkg.name}: no tarball produced`);
        deps[pkg.name] = `file:${join(tarballDir, tarball).replace(/\\/g, '/')}`;
        for (const sub of Object.keys(pkg.exports)) {
            if (sub === './package.json' || sub.includes('*')) continue;
            smoke.push(sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`);
        }
    }

    writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify(
            { name: 'aigntiq-conduit-pack-smoke', private: true, type: 'module', dependencies: deps },
            null,
            2
        )
    );
    const lines = smoke.map(
        (s) =>
            `{ const m = await import('${s}'); ` +
            `if (!Object.keys(m).length) throw new Error('${s}: empty module'); ` +
            `console.log('✓ ${s}'); }`
    );
    writeFileSync(join(appDir, 'smoke.mjs'), lines.join('\n') + '\n');

    console.log('\n▶  Install + import smoke');
    run('npm install --no-audit --no-fund --loglevel=error', { cwd: appDir });
    run('node smoke.mjs', { cwd: appDir });
    console.log('\n✅ verify-pack passed');
}

try {
    main();
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
