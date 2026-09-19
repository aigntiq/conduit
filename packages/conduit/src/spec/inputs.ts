/**
 * Caller input handling: defaults, light coercion, then schema validation.
 *
 * Coercion is deliberately narrow and only goes toward the declared type —
 * inputs often come from HTML forms or query strings, where everything is a
 * string: `"5"` becomes `5` for a number, `"true"` becomes `true` for a
 * boolean. Nothing else is guessed.
 */
import { ConduitValidationError, type InputIssue } from '../errors';
import { validateAgainstSchema, type SchemaNode } from '../schema/validator';
import type { AuthMethod, InputProperty, InputSchema } from './types';

function coerce(prop: InputProperty, value: unknown): unknown {
    if (value === undefined || value === null) return value;
    switch (prop.type) {
        case 'number':
        case 'integer':
            if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
            return value;
        case 'boolean':
            if (value === 'true') return true;
            if (value === 'false') return false;
            return value;
        case 'array':
            if (Array.isArray(value) && prop.items) return value.map((v) => coerce(prop.items!, v));
            return value;
        case 'object':
            if (prop.properties && typeof value === 'object' && !Array.isArray(value)) {
                return applyDefaults({ type: 'object', properties: prop.properties, required: prop.required }, value as Record<string, unknown>);
            }
            return value;
        default:
            return value;
    }
}

function applyDefaults(schema: InputSchema, raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...raw };
    for (const [name, prop] of Object.entries(schema.properties)) {
        let v = out[name];
        // An empty string from a form means "not provided" for non-string fields.
        if (v === '' && prop.type !== 'string') v = undefined;
        if (v === undefined && prop.default !== undefined) v = structuredClone(prop.default);
        v = coerce(prop, v);
        if (v === undefined) delete out[name];
        else out[name] = v;
    }
    return out;
}

/** Only the validating keywords — UI hints never affect acceptance. */
function toSchemaNode(schema: InputSchema | InputProperty): SchemaNode {
    return schema as unknown as SchemaNode;
}

export interface InputResult {
    value: Record<string, unknown>;
    issues: InputIssue[];
}

/**
 * Apply defaults and coercion, then validate. Unknown keys pass through
 * untouched — a spec may read `inputs.x` for fields it chose not to declare.
 */
export function prepareInputs(schema: InputSchema | undefined, raw: unknown): InputResult {
    const input = raw === undefined || raw === null ? {} : raw;
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { value: {}, issues: [{ path: '', message: 'inputs must be an object' }] };
    }
    if (!schema) return { value: { ...(input as Record<string, unknown>) }, issues: [] };
    const value = applyDefaults(schema, input as Record<string, unknown>);
    const issues = validateAgainstSchema(toSchemaNode(schema), value, 'inputs');
    return { value, issues };
}

/** `prepareInputs`, throwing a `ConduitValidationError` on any issue. */
export function assertInputs(schema: InputSchema | undefined, raw: unknown, what = 'inputs'): Record<string, unknown> {
    const { value, issues } = prepareInputs(schema, raw);
    if (issues.length > 0) {
        const detail = issues.map((i) => `${i.path} ${i.message}`).join('; ');
        throw new ConduitValidationError(`invalid ${what}: ${detail}`, issues);
    }
    return value;
}

/** Names of inputs marked secret (`x-secret` or `format: "password"`). */
export function secretInputNames(schema: InputSchema | undefined): string[] {
    if (!schema) return [];
    return Object.entries(schema.properties)
        .filter(([, p]) => p['x-secret'] === true || p.format === 'password')
        .map(([name]) => name);
}

const secret = (title: string): InputProperty => ({ type: 'string', title, format: 'password', 'x-secret': true, minLength: 1 });

/**
 * The inputs an auth method collects when connecting: its declared `inputs`,
 * or the type's conventional default.
 */
export function authInputs(method: AuthMethod): InputSchema {
    if (method.inputs) return method.inputs;
    switch (method.type) {
        case 'apiKey':
            return { type: 'object', properties: { apiKey: secret('API key') }, required: ['apiKey'] };
        case 'basic':
            return {
                type: 'object',
                properties: { username: { type: 'string', title: 'Username', minLength: 1 }, password: secret('Password') },
                required: ['username', 'password']
            };
        case 'bearer':
            return { type: 'object', properties: { token: secret('Token') }, required: ['token'] };
        case 'oauth2':
        case 'jwt':
        case 'custom':
            return { type: 'object', properties: {} };
    }
}
