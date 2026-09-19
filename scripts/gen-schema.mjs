#!/usr/bin/env node
/**
 * gen-schema.mjs — `pnpm gen:schema`.
 *
 * Writes packages/conduit/schema/conduit-1.schema.json from the TypeScript
 * source of truth (src/schema/conduit-1.ts). A unit test fails when the two
 * drift, so run this after editing the schema. Needs Node's built-in type
 * stripping (Node >= 22.18).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages', 'conduit');
const { conduitSchema } = await import(pathToFileURL(join(pkg, 'src', 'schema', 'conduit-1.ts')).href);

const out = join(pkg, 'schema', 'conduit-1.schema.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(conduitSchema, null, 2) + '\n');
console.log(`wrote ${out}`);
