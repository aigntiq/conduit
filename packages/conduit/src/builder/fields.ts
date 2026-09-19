/**
 * Field helpers: each returns a `Field<T>` carrying the JSON Schema property
 * it compiles to and, as a phantom, the TypeScript type of its value — so
 * `inputs({...})` knows the exact shape of `inputs` for refs and for typed
 * `execute` calls.
 *
 * Fields are required by default; `.optional()` makes one optional.
 */
import type { Condition, InputProperty, InputRule, InputSchema, Widget } from '../spec/types';
import { toTemplate, toTemplateString, type Ref } from './refs';

declare const valueType: unique symbol;

export interface Field<T, Required extends boolean = true> {
    readonly property: InputProperty;
    readonly required: Required;
    readonly [valueType]?: T;
    /** Make the field optional. */
    optional(): Field<T, false>;
}

export type FieldValue<F> = F extends Field<infer T, boolean> ? T : never;
export type Fields = Record<string, Field<unknown, boolean>>;

type RequiredKeys<F extends Fields> = { [K in keyof F]: F[K] extends Field<unknown, true> ? K : never }[keyof F];
type OptionalKeys<F extends Fields> = Exclude<keyof F, RequiredKeys<F>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The value type of a set of fields. */
export type InferFields<F extends Fields> = Simplify<{ [K in RequiredKeys<F>]: FieldValue<F[K]> } & { [K in OptionalKeys<F>]?: FieldValue<F[K]> }>;

/** A file value, as the `file` widget produces and `multipart`/`mime()` consume. */
export interface FileValue {
    filename: string;
    contentType?: string;
    base64: string;
}

/** Options every field accepts. */
export interface CommonOptions<T> {
    title?: string;
    description?: string;
    default?: T;
    examples?: T[];
    placeholder?: string;
    group?: string;
    order?: number;
    advanced?: boolean;
    readOnly?: boolean;
    deprecated?: boolean;
    secret?: boolean;
    widget?: Widget;
    visibleWhen?: Condition;
    requiredWhen?: Condition;
    /** Message overrides per issue code (`required`, `pattern`, …). */
    messages?: Record<string, string>;
}

export interface DynamicOptions {
    operation: string;
    /** Inputs for the options operation; refs to this form's inputs are allowed. */
    inputs?: Record<string, unknown>;
    dependsOn?: string[];
    search?: string;
}

export interface StringOptions<T extends string = string> extends CommonOptions<T> {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
    options?: DynamicOptions;
    language?: string;
}

export interface NumberOptions extends CommonOptions<number> {
    minimum?: number;
    maximum?: number;
}

export interface ArrayOptions<T> extends CommonOptions<T[]> {
    minItems?: number;
    maxItems?: number;
    options?: DynamicOptions;
}

export interface FileOptions extends CommonOptions<FileValue> {
    accept?: string;
    maxBytes?: number;
}

function makeField<T, R extends boolean>(property: InputProperty, required: R): Field<T, R> {
    return {
        property,
        required,
        optional: () => makeField<T, false>(property, false)
    };
}

function common<T>(o: CommonOptions<T> | undefined, p: InputProperty): InputProperty {
    if (!o) return p;
    const set = (key: keyof InputProperty, v: unknown) => {
        if (v !== undefined) (p as unknown as Record<string, unknown>)[key] = v;
    };
    set('title', o.title);
    set('description', o.description);
    set('default', o.default);
    set('examples', o.examples);
    set('readOnly', o.readOnly);
    set('deprecated', o.deprecated);
    set('x-placeholder', o.placeholder);
    set('x-group', o.group);
    set('x-order', o.order);
    set('x-advanced', o.advanced);
    set('x-secret', o.secret);
    set('x-widget', o.widget);
    set('x-visibleWhen', o.visibleWhen);
    set('x-requiredWhen', o.requiredWhen);
    set('x-errorMessage', o.messages);
    return p;
}

function dynamicOptions(o: DynamicOptions | undefined): InputProperty['x-options'] {
    if (!o) return undefined;
    const out: NonNullable<InputProperty['x-options']> = { operation: o.operation };
    if (o.inputs) out.inputs = toTemplate(o.inputs) as Record<string, unknown>;
    if (o.dependsOn) out.dependsOn = o.dependsOn;
    if (o.search) out.search = o.search;
    return out;
}

function stringProp(o: StringOptions | undefined, extra: Partial<InputProperty> = {}): InputProperty {
    const p = common(o, { type: 'string', ...extra });
    if (o?.minLength !== undefined) p.minLength = o.minLength;
    if (o?.maxLength !== undefined) p.maxLength = o.maxLength;
    if (o?.pattern !== undefined) p.pattern = o.pattern;
    if (o?.format !== undefined) p.format = o.format;
    if (o?.language !== undefined) p['x-language'] = o.language;
    const opts = dynamicOptions(o?.options);
    if (opts) p['x-options'] = opts;
    return p;
}

export function string(options?: StringOptions): Field<string> {
    return makeField(stringProp(options), true);
}

export function text(options?: StringOptions): Field<string> {
    return makeField(stringProp({ widget: 'textarea', ...options }), true);
}

export function richtext(options?: StringOptions): Field<string> {
    return makeField(stringProp({ widget: 'richtext', ...options }), true);
}

export function email(options?: StringOptions): Field<string> {
    return makeField(stringProp(options, { format: 'email' }), true);
}

export function url(options?: StringOptions): Field<string> {
    return makeField(stringProp(options, { format: 'uri' }), true);
}

export function date(options?: StringOptions): Field<string> {
    return makeField(stringProp(options, { format: 'date' }), true);
}

export function datetime(options?: StringOptions): Field<string> {
    return makeField(stringProp(options, { format: 'date-time' }), true);
}

export function secret(options?: StringOptions): Field<string> {
    return makeField(stringProp({ secret: true, ...options }, { format: 'password' }), true);
}

/**
 * Labelled choices: `select({ inbox: 'Inbox', sent: 'Sent' })` or plain
 * `select(['a', 'b'])`. The value type is the union of the keys.
 */
export function select<const V extends string>(choices: Record<V, string> | readonly V[], options?: CommonOptions<NoInfer<V>>): Field<V> {
    const p = common(options, { type: 'string' });
    if (Array.isArray(choices)) p.enum = [...choices];
    else p.oneOf = Object.entries(choices).map(([c, title]) => ({ const: c, title: title as string }));
    return makeField(p, true);
}

export function number(options?: NumberOptions): Field<number> {
    const p = common(options, { type: 'number' });
    if (options?.minimum !== undefined) p.minimum = options.minimum;
    if (options?.maximum !== undefined) p.maximum = options.maximum;
    return makeField(p, true);
}

export function integer(options?: NumberOptions): Field<number> {
    const f = number(options);
    return makeField({ ...f.property, type: 'integer' }, true);
}

export function boolean(options?: CommonOptions<boolean>): Field<boolean> {
    return makeField(common(options, { type: 'boolean' }), true);
}

export function array<T>(item: Field<T, boolean>, options?: ArrayOptions<T>): Field<T[]> {
    const p = common(options, { type: 'array', items: item.property });
    if (options?.minItems !== undefined) p.minItems = options.minItems;
    if (options?.maxItems !== undefined) p.maxItems = options.maxItems;
    const opts = dynamicOptions(options?.options);
    if (opts) p['x-options'] = opts;
    return makeField(p, true);
}

/** A list of email addresses (the `emails` widget). */
export function emails(options?: ArrayOptions<string>): Field<string[]> {
    return array(email(), options);
}

export function file(options?: FileOptions): Field<FileValue> {
    const p = common(options, {
        type: 'object',
        'x-widget': 'file',
        properties: { filename: { type: 'string' }, contentType: { type: 'string' }, base64: { type: 'string' } },
        required: ['filename', 'base64']
    });
    if (options?.accept !== undefined) p['x-accept'] = options.accept;
    if (options?.maxBytes !== undefined) p['x-maxBytes'] = options.maxBytes;
    return makeField(p, true);
}

export function files(options?: FileOptions & { minItems?: number; maxItems?: number }): Field<FileValue[]> {
    const { minItems, maxItems, ...fileOptions } = options ?? {};
    const itemOptions: FileOptions = {};
    if (fileOptions.accept !== undefined) itemOptions.accept = fileOptions.accept;
    if (fileOptions.maxBytes !== undefined) itemOptions.maxBytes = fileOptions.maxBytes;
    const { accept: _a, maxBytes: _m, ...rest } = fileOptions;
    return array(file(itemOptions), { ...(rest as ArrayOptions<FileValue>), minItems, maxItems });
}

export function object<F extends Fields>(fields: F, options?: CommonOptions<InferFields<F>>): Field<InferFields<F>> {
    const { properties, required } = compileFields(fields);
    const p = common(options, { type: 'object', properties });
    if (required.length) p.required = required;
    return makeField(p, true);
}

/** Free-form JSON (the `json` widget). */
export function json<T = unknown>(options?: CommonOptions<T>): Field<T> {
    return makeField(common(options, { type: 'object', 'x-widget': 'json' }), true);
}

function compileFields(fields: Fields): { properties: Record<string, InputProperty>; required: string[] } {
    const properties: Record<string, InputProperty> = {};
    const required: string[] = [];
    for (const [name, f] of Object.entries(fields)) {
        properties[name] = f.property;
        if (f.required) required.push(name);
    }
    return { properties, required };
}

/** Compile a field set (plus cross-field rules) into an `InputSchema`. */
export function toInputSchema(fields: Fields, rules?: readonly InputRule[]): InputSchema {
    const { properties, required } = compileFields(fields);
    const schema: InputSchema = { type: 'object', properties };
    if (required.length) schema.required = required;
    if (rules?.length) schema['x-rules'] = [...rules];
    return schema;
}

// ── Conditions and rules ────────────────────────────────────────────────

export const when = {
    equals: (field: string, value: unknown): Condition => ({ [field]: value }),
    in: (field: string, values: unknown[]): Condition => ({ [field]: { in: values } }),
    notEmpty: (field: string): Condition => ({ [field]: { notEmpty: true } }),
    empty: (field: string): Condition => ({ [field]: { empty: true } }),
    /** Combine conditions (all must hold). */
    all: (...conditions: Condition[]): Condition => Object.assign({}, ...conditions)
};

export const rules = {
    /** At least one of these inputs has a value. */
    atLeastOne(fields: string[], message = `Fill in at least one of: ${fields.join(', ')}`): InputRule {
        return { check: `{{ ${fields.map((f) => `!isEmpty(inputs.${f})`).join(' || ')} }}`, message, fields };
    },
    /** A custom rule over the inputs. */
    check(check: Ref<unknown> | string | object, message: string, fields?: string[]): InputRule {
        const rule: InputRule = { check: toTemplateString(check), message };
        if (fields) rule.fields = fields;
        return rule;
    }
};
