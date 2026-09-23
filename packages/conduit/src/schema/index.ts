/**
 * `@aigntiq/conduit/schema` — the `conduit/1` JSON Schema and the compact
 * validator that enforces it, plus operations as tool definitions.
 */
export { conduitSchema } from './conduit-1';
export { validateAgainstSchema, type SchemaIssue, type SchemaNode } from './validator';
export { toolDefinitions, toolSchema, type ToolAnnotations, type ToolDefinition, type ToolDefinitionOptions } from './tools';
