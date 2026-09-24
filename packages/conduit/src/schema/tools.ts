/**
 * Operations as tool definitions — for hosts that hand a connector's
 * operations to a model or an MCP-style tool list. Pure data in, pure data
 * out: naming and error wording stay with the host. To reflect an operation
 * policy, pass the verdicts from `conduit.decide` as `decisions`.
 */

import type { Decision, PolicyVerdict } from '../runtime/policy';
import type { ConnectorDescription, OperationDescription } from '../runtime/types';
import type { InputSchema, JsonSchema } from '../spec/types';

export interface ToolAnnotations {
    /** Only reads — safe to run without confirmation. */
    readOnly?: true;
    /** Deletes or irreversibly changes data — confirm first. */
    destructive?: true;
    /** The host's policy wants each call confirmed — run it with `confirmed: true` once approved. */
    confirm?: true;
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
    /**
     * Policy verdicts by operation id, e.g. from `conduit.decide`. `deny`
     * drops the operation; `confirm` sets `annotations.confirm`. Operations
     * not listed are kept as they are.
     */
    decisions?: Record<string, Decision | PolicyVerdict>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keywords whose value is a subschema, or a list of them. */
const SUBSCHEMA = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']);
const SUBSCHEMA_LIST = new Set(['oneOf', 'anyOf', 'allOf', 'prefixItems']);
/** Keywords whose value maps names (field names, not keywords) to subschemas. */
const SUBSCHEMA_MAP = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs']);

/**
 * A schema without its `x-` hint keywords. Only keyword positions are
 * stripped: field names under `properties` and data under `default`,
 * `const`, `examples` and the like are copied untouched.
 */
function withoutHints(schema: unknown): unknown {
    if (!isObject(schema)) return schema;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
        if (k.startsWith('x-')) continue;
        if (SUBSCHEMA.has(k)) out[k] = Array.isArray(v) ? v.map(withoutHints) : withoutHints(v);
        else if (SUBSCHEMA_LIST.has(k) && Array.isArray(v)) out[k] = v.map(withoutHints);
        else if (SUBSCHEMA_MAP.has(k) && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, withoutHints(s)]));
        else out[k] = jsonCopy(v);
    }
    return out;
}

/** A deep copy of plain JSON data, so the result never aliases the spec. */
function jsonCopy(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(jsonCopy);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonCopy(v)]));
}

/**
 * An operation's inputs as a plain JSON Schema: a copy with the `x-` hints
 * (widgets, groups, option sources, cross-field rules) removed from every subschema.
 * No inputs give an empty object schema.
 */
export function toolSchema(inputs: InputSchema | undefined): JsonSchema {
    return inputs === undefined ? { type: 'object', properties: {} } : (withoutHints(inputs) as JsonSchema);
}

/** Anything but a decision (or a verdict holding one) — e.g. a `null` from JSON — counts as none. */
const decisionOf = (d: Decision | PolicyVerdict | null | undefined): Decision | undefined =>
    typeof d === 'string' ? d : d !== null && typeof d === 'object' ? d.decision : undefined;

function annotations(op: OperationDescription, decision: Decision | undefined): ToolAnnotations {
    const out: ToolAnnotations = {};
    // A search only lists, so it reads unless it says otherwise.
    if (op.readOnly ?? op.kind === 'search') out.readOnly = true;
    if (op.destructive === true) out.destructive = true;
    if (decision === 'confirm') out.confirm = true;
    return out;
}

/**
 * One tool definition per callable operation (`action` and `search`) of a
 * connector, from `conduit.connectors.describe(id)`. `options` operations feed
 * form pickers and triggers are delivered, so neither becomes a tool.
 * Operations `decisions` deny are left out.
 */
export function toolDefinitions(description: ConnectorDescription, options: ToolDefinitionOptions = {}): ToolDefinition[] {
    const decision = (op: OperationDescription) => decisionOf(options.decisions?.[op.id]);
    return description.operations
        .filter((op) => (op.kind === 'action' || op.kind === 'search') && (options.includeHidden === true || !op.hidden) && decision(op) !== 'deny')
        .map((op) => ({
            name: op.id,
            operation: op.id,
            description: op.description ? `${op.label}. ${op.description}` : op.label,
            inputSchema: toolSchema(op.inputs),
            annotations: annotations(op, decision(op))
        }));
}
