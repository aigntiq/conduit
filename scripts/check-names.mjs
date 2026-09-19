#!/usr/bin/env node
/**
 * check-names.mjs — CI guard (`pnpm verify:names`).
 *
 * Conduit is an independent product. It must not name other products — not
 * the systems whose problems it solves, not competitors — anywhere in the
 * repo: code, docs, fixtures, examples or scripts. This walks every tracked
 * (and untracked, not-ignored) file and fails on a match.
 *
 * The terms are stored base64-encoded so this file does not itself carry
 * them. To add one, encode it with `Buffer.from(term).toString('base64')`.
 * All-caps terms match case-sensitively; the rest match case-insensitively.
 * Every term matches as a whole word only.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENCODED = [
    'b21uaWE=',
    'b21uaWFmbG93',
    'YW5kaWlmbG93',
    'Zmxvdw==',
    'aW50ZWdyb21hdA==',
    'bWFrZS5jb20=',
    'emFwaWVy',
    'bjhu',
    'd29ya2F0bw==',
    'cGlwZWRyZWFt',
    'SU1M'
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = ENCODED.map((b) => Buffer.from(b, 'base64').toString('utf8')).map((t) =>
    /^[A-Z]+$/.test(t) ? new RegExp(`\\b${escape(t)}\\b`) : new RegExp(`\\b${escape(t)}\\b`, 'i')
);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = execSync('git ls-files --cached --others --exclude-standard', {
    cwd: root,
    encoding: 'utf8'
})
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|tgz)$/i.test(f))
    .filter((f) => f !== 'pnpm-lock.yaml');

const hits = [];
for (const file of files) {
    let text;
    try {
        text = readFileSync(join(root, file), 'utf8');
    } catch {
        continue;
    }
    text.split('\n').forEach((line, i) => {
        if (patterns.some((re) => re.test(line))) {
            hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
    });
}

if (hits.length) {
    console.error(`✖ ${hits.length} line(s) name another product:\n  ${hits.join('\n  ')}`);
    process.exit(1);
}
console.log(`✓ no other product names in ${files.length} files`);
