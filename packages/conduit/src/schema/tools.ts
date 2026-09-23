/**
 * Operations as tool definitions — for hosts that hand a connector's
 * operations to a model or an MCP-style tool list. Pure data in, pure data
 * out: naming, error wording and approval policy stay with the host.
 */

import type { ConnectorDescription, OperationDescription } from '../runtime/types';
import type { InputSchema, JsonSchema } from '../spec/types';

export interface ToolAnnotations {
    /** Only reads — safe to run without confirmation. */
    readOnly?: true;
    /** Deletes or irreversibly changes data — confirm first. */
    destructive?: true;
}

export interface ToolDefinition {
    /** The operation id. Prefix it yourself when tools from several connectors share a namespace. */
    name: string;
    /** The operation to `execute`. */
    operation: string;
    description: string;
    /** Plain JSON Schema for the arguments — the inputs without their `x-` UI hints. */
    inputSchema: JsonSchema;
    annotations: ToolAnnotations;
}

export interface ToolDefinitionOptions {
    /** Include operations marked `hidden` (default: false). */
    includeHidden?: boolean;
}

function withoutHints(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutHints);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('x-')) out[k] = withoutHints(v);
    return out;
}

/**
 * An operation's inputs as a plain JSON Schema: a copy with every `x-` hint
 * (widgets, groups, option sources, cross-field rules) removed at any depth.
 * No inputs give an empty object schema.
 */
export function toolSchema(inputs: InputSchema | undefined): JsonSchema {
    return inputs === undefined ? { type: 'object', properties: {} } : (withoutHints(inputs) as JsonSchema);
}

function annotations(op: OperationDescription): ToolAnnotations {
    const out: ToolAnnotations = {};
    // A search only lists, so it reads unless it says otherwise.
    if (op.readOnly ?? op.kind === 'search') out.readOnly = true;
    if (op.destructive === true) out.destructive = true;
    return out;
}

/**
 * One tool definition per callable operation (`action` and `search`) of a
 * connector, from `conduit.connectors.describe(id)`. `options` operations feed
 * form pickers and triggers are delivered, so neither becomes a tool.
 */
export function toolDefinitions(description: ConnectorDescription, options: ToolDefinitionOptions = {}): ToolDefinition[] {
    return description.operations
        .filter((op) => (op.kind === 'action' || op.kind === 'search') && (options.includeHidden === true || !op.hidden))
        .map((op) => ({
            name: op.id,
            operation: op.id,
            description: op.description ? `${op.label}. ${op.description}` : op.label,
            inputSchema: toolSchema(op.inputs),
            annotations: annotations(op)
        }));
}
