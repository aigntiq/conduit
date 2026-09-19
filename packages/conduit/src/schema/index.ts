/**
 * `@sigx/conduit/schema` — the `conduit/1` JSON Schema and the compact
 * validator that enforces it.
 */
export { conduitSchema } from './conduit-1';
export { validateAgainstSchema, type SchemaIssue, type SchemaNode } from './validator';
