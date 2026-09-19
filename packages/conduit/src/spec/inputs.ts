/**
 * Caller input handling. Everything is delegated to the form layer
 * (`./forms.ts`) so the browser and the runtime run the same rules:
 * defaults, narrow coercion toward the declared type, hidden fields dropped,
 * then validation with coded issues.
 */
import { assertForm, prepareForm, type PrepareOptions, type PreparedForm } from './forms';
import type { AuthMethod, InputProperty, InputSchema } from './types';

export type InputResult = PreparedForm;

/** Apply defaults and coercion, drop hidden fields, validate. See `prepareForm`. */
export function prepareInputs(schema: InputSchema | undefined, raw: unknown, options?: PrepareOptions): Promise<InputResult> {
    return prepareForm(schema, raw, options);
}

/** `prepareInputs`, throwing a `ConduitValidationError` on any issue. */
export function assertInputs(schema: InputSchema | undefined, raw: unknown, what = 'inputs', options: PrepareOptions = {}): Promise<Record<string, unknown>> {
    return assertForm(schema, raw, { ...options, what });
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
