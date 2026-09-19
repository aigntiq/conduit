/**
 * Forms: the one renderer-agnostic description of an input schema, and the
 * one validator every side runs.
 *
 * `buildForm(schema)` normalises an `InputSchema` into a `FormModel` — fields
 * ordered and grouped, the widget resolved, choices labelled, conditions and
 * option sources spelled out. A renderer (sigx, React, a CLI, an AI tool
 * schema) walks the model and never re-derives anything.
 *
 * `prepareForm(schema, values)` applies defaults and coercion, drops hidden
 * fields, and validates — the browser calls it while the user types, and the
 * runtime calls the SAME function before every request.
 *
 * Hosts with dynamic bindings (a workflow editor binding a field to an
 * upstream step) pass `bound` paths: values that do not exist yet. Conditions
 * then use three-valued logic — a bound field satisfies `required`, its value
 * checks are deferred, a condition that reads it is "unknown" (visible, not
 * required), and a rule that reads it is deferred.
 */
import { ConduitValidationError, type InputIssue } from '../errors';
import type { FunctionRegistry } from '../expr/evaluate';
import { deepEqual, isPlainObject } from '../expr/evaluate';
import { standardRegistry } from '../expr/stdlib';
import { renderTemplate } from '../expr/template';
import { validateAgainstSchema, type SchemaNode } from '../schema/validator';
import type { Condition, InputProperty, InputRule, InputSchema, InputType, Widget } from './types';

// ── The model ───────────────────────────────────────────────────────────

export interface FormChoice {
    value: unknown;
    label: string;
    description?: string;
}

export interface FormField {
    /** Key within its parent object. */
    name: string;
    /** Dotted path from the form root, e.g. `address.city`. Array items end in `[]`. */
    path: string;
    label: string;
    description?: string;
    type: InputType;
    widget: Widget;
    /** Statically required. */
    required: boolean;
    requiredWhen?: Condition;
    visibleWhen?: Condition;
    default?: unknown;
    placeholder?: string;
    examples?: unknown[];
    readOnly: boolean;
    deprecated: boolean;
    secret: boolean;
    /** An array field (multiselect, emails, list, multiple files). */
    multiple: boolean;
    choices?: FormChoice[];
    options?: { operation: string; inputs?: Record<string, unknown>; dependsOn: string[]; search?: string };
    accept?: string;
    maxBytes?: number;
    language?: string;
    constraints: {
        minimum?: number;
        maximum?: number;
        minLength?: number;
        maxLength?: number;
        pattern?: string;
        format?: string;
        minItems?: number;
        maxItems?: number;
    };
    /** Message overrides by issue code. */
    messages?: Record<string, string>;
    group?: string;
    advanced: boolean;
    /** Array fields: the item's model. */
    item?: FormField;
    /** Object fields: child models, ordered. */
    fields?: FormField[];
}

export interface FormGroup {
    /** Undefined for the default (unnamed) group. */
    name?: string;
    advanced: boolean;
    fields: FormField[];
}

export interface FormModel {
    groups: FormGroup[];
    rules: InputRule[];
    /** The source schema, for `prepareForm`. */
    schema: InputSchema;
}

// ── Building ────────────────────────────────────────────────────────────

function humanize(name: string): string {
    const spaced = name
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim()
        .toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function choicesOf(prop: InputProperty): FormChoice[] | undefined {
    if (prop.oneOf?.length) {
        return prop.oneOf.map((c) => {
            const choice: FormChoice = { value: c.const, label: c.title ?? String(c.const) };
            if (c.description) choice.description = c.description;
            return choice;
        });
    }
    if (prop.enum?.length) return prop.enum.map((v) => ({ value: v, label: String(v) }));
    return undefined;
}

/** The single inference table. Documented in docs/ui-hints.md. */
export function inferWidget(prop: InputProperty): Widget {
    if (prop['x-widget']) return prop['x-widget'];
    if (prop['x-secret'] || prop.format === 'password') return 'password';
    const hasChoices = !!(prop.oneOf?.length || prop.enum?.length);
    switch (prop.type) {
        case 'boolean':
            return 'toggle';
        case 'number':
        case 'integer':
            return hasChoices ? 'select' : 'number';
        case 'string':
            if (prop['x-options']) return prop['x-options'].search ? 'combobox' : 'select';
            if (hasChoices) return 'select';
            switch (prop.format) {
                case 'email':
                    return 'email';
                case 'uri':
                case 'url':
                    return 'url';
                case 'date':
                    return 'date';
                case 'date-time':
                    return 'datetime';
            }
            return 'text';
        case 'array': {
            const item = prop.items;
            if (prop['x-options'] || (item && (item.oneOf?.length || item.enum?.length || item['x-options']))) return 'multiselect';
            if (item?.['x-widget'] === 'file') return 'file';
            if (item?.type === 'string' && item.format === 'email') return 'emails';
            return item ? 'list' : 'json';
        }
        case 'object':
            return prop.properties ? 'fieldset' : 'keyvalue';
    }
}

function buildField(name: string, prop: InputProperty, required: boolean, parent: string): FormField {
    const path = parent ? `${parent}.${name}` : name;
    const widget = inferWidget(prop);
    const field: FormField = {
        name,
        path,
        label: prop.title ?? humanize(name),
        type: prop.type,
        widget,
        required,
        readOnly: prop.readOnly === true,
        deprecated: prop.deprecated === true,
        secret: prop['x-secret'] === true || prop.format === 'password',
        multiple: prop.type === 'array',
        advanced: prop['x-advanced'] === true,
        constraints: {}
    };
    const set = <K extends keyof FormField>(key: K, value: FormField[K] | undefined) => {
        if (value !== undefined) field[key] = value;
    };
    set('description', prop.description);
    set('requiredWhen', prop['x-requiredWhen']);
    set('visibleWhen', prop['x-visibleWhen']);
    set('default', prop.default);
    set('placeholder', prop['x-placeholder']);
    set('examples', prop.examples);
    set('accept', prop['x-accept'] ?? prop.items?.['x-accept']);
    set('maxBytes', prop['x-maxBytes'] ?? prop.items?.['x-maxBytes']);
    set('language', prop['x-language']);
    set('messages', prop['x-errorMessage']);
    set('group', prop['x-group']);
    set('choices', choicesOf(prop) ?? (prop.type === 'array' && prop.items ? choicesOf(prop.items) : undefined));
    const options = prop['x-options'] ?? (prop.type === 'array' ? prop.items?.['x-options'] : undefined);
    if (options) {
        field.options = { operation: options.operation, dependsOn: options.dependsOn ?? [] };
        if (options.inputs) field.options.inputs = options.inputs;
        if (options.search) field.options.search = options.search;
    }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems'] as const) {
        if (prop[key] !== undefined) (field.constraints as Record<string, unknown>)[key] = prop[key];
    }
    if (prop.type === 'array' && prop.items) field.item = buildField('[]', prop.items, false, path);
    if (prop.type === 'object' && prop.properties) {
        field.fields = orderedFields(prop.properties, prop.required ?? [], path);
    }
    return field;
}

function orderedFields(properties: Record<string, InputProperty>, required: readonly string[], parent: string): FormField[] {
    return Object.entries(properties)
        .map(([name, prop], index) => ({ field: buildField(name, prop, required.includes(name), parent), order: prop['x-order'] ?? Infinity, index }))
        .sort((a, b) => (a.order === b.order ? a.index - b.index : a.order - b.order))
        .map((x) => x.field);
}

const EMPTY_SCHEMA: InputSchema = { type: 'object', properties: {} };

/** Normalise an input schema into a form model. */
export function buildForm(schema: InputSchema | undefined): FormModel {
    const s = schema ?? EMPTY_SCHEMA;
    const fields = orderedFields(s.properties, s.required ?? [], '');
    // Groups: the unnamed group first, then named groups by first appearance;
    // within each name, regular fields before advanced ones.
    const groups: FormGroup[] = [];
    const find = (name: string | undefined, advanced: boolean) => {
        let g = groups.find((x) => x.name === name && x.advanced === advanced);
        if (!g) {
            g = name === undefined ? { advanced, fields: [] } : { name, advanced, fields: [] };
            groups.push(g);
        }
        return g;
    };
    const nameOrder = new Map<string | undefined, number>([[undefined, -1]]);
    for (const f of fields) {
        if (!nameOrder.has(f.group)) nameOrder.set(f.group, nameOrder.size);
        find(f.group, f.advanced).fields.push(f);
    }
    groups.sort((a, b) => nameOrder.get(a.name)! - nameOrder.get(b.name)! || Number(a.advanced) - Number(b.advanced));
    return { groups, rules: s['x-rules'] ?? [], schema: s };
}

// ── Conditions (three-valued) ───────────────────────────────────────────

/** `true`, `false`, or `undefined` when a bound (not yet known) field decides it. */
export type Tri = boolean | undefined;

const isEmptyValue = (v: unknown) =>
    v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0);

export function evaluateCondition(condition: Condition, values: Record<string, unknown>, bound: (name: string) => boolean = () => false): Tri {
    let unknown = false;
    for (const [name, test] of Object.entries(condition)) {
        if (bound(name)) {
            unknown = true;
            continue;
        }
        const v = values[name];
        let ok: boolean;
        if (isPlainObject(test) && ('in' in test || 'notEmpty' in test || 'empty' in test)) {
            ok = true;
            if (Array.isArray(test.in)) ok &&= test.in.some((x) => deepEqual(x, v));
            if (test.notEmpty === true) ok &&= !isEmptyValue(v);
            if (test.empty === true) ok &&= isEmptyValue(v);
        } else {
            ok = deepEqual(v, test);
        }
        if (!ok) return false;
    }
    return unknown ? undefined : true;
}

// ── Preparation and validation ──────────────────────────────────────────

export interface FormIssue extends InputIssue {
    /** `required`, `type`, `enum`, `format`, `minLength`, `pattern`, `rule`, `remote`, … */
    code: string;
    params?: Record<string, unknown>;
}

export interface PrepareOptions {
    /**
     * Paths the host fills at runtime (e.g. bound to an upstream step), in
     * the form model's dotted notation: `to`, `address.city`.
     */
    bound?: readonly string[];
    /** Functions available to `x-rules` checks. Default: the standard library. */
    functions?: FunctionRegistry;
    /** Prefix for issue paths. Default `inputs`. */
    root?: string;
}

export interface PreparedForm {
    /** Defaults applied, coerced, hidden fields dropped. */
    value: Record<string, unknown>;
    issues: FormIssue[];
}

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
        case 'array': {
            let list = value;
            // Values resolved from elsewhere (an upstream step) arrive as JSON text or a single item.
            if (typeof list === 'string' && /^\s*\[/.test(list)) {
                try {
                    list = JSON.parse(list);
                } catch {
                    // leave it; validation reports the type
                }
            }
            if (!Array.isArray(list)) list = list === '' ? [] : [list];
            return prop.items ? (list as unknown[]).map((v) => coerce(prop.items!, v)) : list;
        }
        case 'object': {
            let obj = value;
            if (typeof obj === 'string' && /^\s*\{/.test(obj)) {
                try {
                    obj = JSON.parse(obj);
                } catch {
                    return value;
                }
            }
            if (prop.properties && isPlainObject(obj)) return withDefaults(prop.properties, obj);
            return obj;
        }
        default:
            return value;
    }
}

function withDefaults(properties: Record<string, InputProperty>, raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...raw };
    for (const [name, prop] of Object.entries(properties)) {
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

/** The validating keywords of a property, minus the nested structure the walker handles itself. */
function valueSchema(prop: InputProperty): SchemaNode {
    const { properties: _p, required: _r, items: _i, ...rest } = prop;
    if (prop.type === 'array' && prop.items && !prop.items.properties) return { ...rest, items: prop.items } as SchemaNode;
    return rest as SchemaNode;
}

const DEFAULT_MESSAGES: Record<string, string> = { required: 'is required' };

class Walker {
    readonly issues: FormIssue[] = [];
    private readonly seen = new Set<string>();

    constructor(private readonly bound: ReadonlySet<string>) {}

    add(path: string, code: string, message: string, params: Record<string, unknown> | undefined, overrides: Record<string, string> | undefined): void {
        // One issue per field: the first problem is the one to fix.
        if (this.seen.has(path)) return;
        this.seen.add(path);
        const issue: FormIssue = { path, code, message: overrides?.[code] ?? message };
        if (params) issue.params = params;
        this.issues.push(issue);
    }

    isBound(modelPath: string): boolean {
        return this.bound.has(modelPath);
    }

    walkObject(properties: Record<string, InputProperty>, required: readonly string[], values: Record<string, unknown>, modelPath: string, issuePath: string): void {
        const boundHere = (name: string) => this.isBound(modelPath ? `${modelPath}.${name}` : name);
        for (const [name, prop] of Object.entries(properties)) {
            const mPath = modelPath ? `${modelPath}.${name}` : name;
            const iPath = `${issuePath}.${name}`;
            const visible = prop['x-visibleWhen'] ? evaluateCondition(prop['x-visibleWhen'], values, boundHere) : true;
            if (visible === false) {
                delete values[name];
                continue;
            }
            if (this.isBound(mPath)) continue;
            const requiredWhen = prop['x-requiredWhen'] ? evaluateCondition(prop['x-requiredWhen'], values, boundHere) : false;
            const isRequired = required.includes(name) || requiredWhen === true;
            const v = values[name];
            if (isEmptyValue(v) && !(prop.type === 'object' && prop.properties && v !== undefined)) {
                if (isRequired) this.add(iPath, 'required', DEFAULT_MESSAGES.required!, undefined, prop['x-errorMessage']);
                if (v === undefined) continue;
                if (v === null || v === '') continue;
            }
            this.walkValue(prop, v, mPath, iPath);
        }
    }

    walkValue(prop: InputProperty, v: unknown, modelPath: string, issuePath: string): void {
        const own = validateAgainstSchema(valueSchema(prop), v, issuePath);
        for (const i of own) this.add(i.path, i.keyword, i.message, i.params, prop['x-errorMessage']);
        if (own.length) return;
        if (prop.type === 'object' && prop.properties && isPlainObject(v)) {
            this.walkObject(prop.properties, prop.required ?? [], v, modelPath, issuePath);
        } else if (prop.type === 'array' && prop.items?.properties && Array.isArray(v)) {
            v.forEach((item, i) => {
                if (isPlainObject(item)) this.walkObject(prop.items!.properties!, prop.items!.required ?? [], item, `${modelPath}[]`, `${issuePath}[${i}]`);
                else this.add(`${issuePath}[${i}]`, 'type', 'must be object', { expected: ['object'] }, prop.items!['x-errorMessage']);
            });
        }
    }
}

const RULE_READS = /inputs(?:\?\.|\.)([A-Za-z_$][\w$]*)|inputs\[\s*['"]([^'"]+)['"]\s*\]/g;

function rulePaths(check: string): string[] {
    const out: string[] = [];
    for (const m of check.matchAll(RULE_READS)) out.push(m[1] ?? m[2]!);
    return out;
}

/**
 * Apply defaults and coercion, drop hidden fields, and validate. The same
 * function runs in the browser and before every request.
 */
export async function prepareForm(schemaOrModel: InputSchema | FormModel | undefined, raw: unknown, options: PrepareOptions = {}): Promise<PreparedForm> {
    const schema = schemaOrModel && 'groups' in schemaOrModel ? schemaOrModel.schema : (schemaOrModel ?? EMPTY_SCHEMA);
    const root = options.root ?? 'inputs';
    const input = raw === undefined || raw === null ? {} : raw;
    if (!isPlainObject(input)) {
        return { value: {}, issues: [{ path: '', code: 'type', message: 'inputs must be an object', params: { expected: ['object'] } }] };
    }
    const value = withDefaults(schema.properties, input);
    const bound = new Set(options.bound ?? []);
    const walker = new Walker(bound);
    walker.walkObject(schema.properties, schema.required ?? [], value, '', root);

    for (const rule of schema['x-rules'] ?? []) {
        const reads = rulePaths(rule.check);
        if (reads.some((p) => bound.has(p) || [...bound].some((b) => b.startsWith(`${p}.`)))) continue;
        const ok = await renderTemplate(rule.check, { inputs: value }, { functions: options.functions ?? standardRegistry });
        if (!ok) {
            const path = rule.fields?.length ? `${root}.${rule.fields[0]}` : root;
            const issue: FormIssue = { path, code: 'rule', message: rule.message };
            if (rule.fields?.length) issue.params = { fields: rule.fields };
            walker.issues.push(issue);
        }
    }
    return { value, issues: walker.issues };
}

/** Just the issues of `prepareForm`. */
export async function validateForm(schemaOrModel: InputSchema | FormModel | undefined, values: unknown, options: PrepareOptions = {}): Promise<FormIssue[]> {
    return (await prepareForm(schemaOrModel, values, options)).issues;
}

/** `prepareForm`, throwing a `ConduitValidationError` on any issue. */
export async function assertForm(schema: InputSchema | undefined, raw: unknown, options: PrepareOptions & { what?: string } = {}): Promise<Record<string, unknown>> {
    const { value, issues } = await prepareForm(schema, raw, options);
    if (issues.length > 0) {
        const detail = issues.map((i) => `${i.path} ${i.message}`).join('; ');
        throw new ConduitValidationError(`invalid ${options.what ?? 'inputs'}: ${detail}`, issues);
    }
    return value;
}
