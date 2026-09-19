/**
 * Typed references into a template scope.
 *
 * `inputs.email` in a builder function is a `Ref` — a proxy that records its
 * path and serialises to `"{{inputs.email}}"`. Because its TypeScript type
 * mirrors the declared inputs, a misspelled field is a compile error, not a
 * validation warning at load time.
 *
 *     body: { email: inputs.email }                 → { "email": "{{inputs.email}}" }
 *     url: $`/contacts/${inputs.id}`                → "/contacts/{{inputs.id}}"
 *     output: expr`${response.body.items} | length`  → "{{response.body.items | length}}"
 */

const REF = Symbol.for('conduit.builder.ref');
const EXPR = Symbol.for('conduit.builder.expr');

declare const refType: unique symbol;

/** A reference to a value of type `T` in the template scope. */
export type Ref<T = unknown> = { readonly [refType]?: T } & (unknown extends T
    ? AnyRef
    : T extends readonly (infer I)[]
      ? { readonly [index: number]: Ref<I>; readonly length: Ref<number> }
      : T extends object
        ? { readonly [K in keyof T]-?: Ref<T[K]> }
        : unknown);

/**
 * A reference into untyped data (API responses): any path is allowed. It is
 * `any` on purpose — the data has no declared shape to check against, and an
 * index signature would read as "possibly undefined" under
 * `noUncheckedIndexedAccess`.
 */
// oxlint-disable-next-line no-explicit-any
export type AnyRef = any;

/** A whole expression, produced by `expr`. */
export interface Expr {
    readonly [EXPR]: string;
}

function isIdentifier(key: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

/** Create a reference to `path` (e.g. `inputs`, `response.body`). */
export function ref<T = unknown>(path: string): Ref<T> {
    const target = function () {} as unknown as object;
    return new Proxy(target, {
        get(_t, key) {
            if (key === REF) return path;
            if (key === Symbol.toPrimitive || key === 'toString') return () => `{{${path}}}`;
            if (key === 'toJSON') return () => `{{${path}}}`;
            if (typeof key === 'symbol') return undefined;
            if (/^\d+$/.test(key)) return ref(`${path}[${key}]`);
            return ref(isIdentifier(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);
        },
        has(_t, key) {
            return key === REF;
        }
    }) as Ref<T>;
}

export function isRef(value: unknown): boolean {
    return (typeof value === 'function' || typeof value === 'object') && value !== null && REF in (value as object);
}

export function refPath(value: unknown): string {
    return (value as Record<symbol, string>)[REF]!;
}

export function isExpr(value: unknown): value is Expr {
    return typeof value === 'object' && value !== null && EXPR in value;
}

/** The expression source of a ref (`inputs.to`) or an expr, for embedding inside another expression. */
function source(value: unknown): string {
    if (isRef(value)) return refPath(value);
    if (isExpr(value)) return `(${value[EXPR]})`;
    return JSON.stringify(value) ?? 'undefined';
}

/**
 * A whole expression. Refs are embedded as paths, other values as literals:
 * ``expr`${inputs.to} | join(', ')` `` → `"{{inputs.to | join(', ')}}"`.
 */
export function expr(strings: TemplateStringsArray, ...values: unknown[]): Expr {
    let out = collapse(strings[0]!);
    values.forEach((v, i) => {
        out += source(v) + collapse(strings[i + 1]!);
    });
    return { [EXPR]: out.trim() };
}

/**
 * Multi-line expressions are formatting: fold each line break and its
 * indentation into one space, outside string literals, so the compiled JSON
 * stays on one readable line.
 */
function collapse(text: string): string {
    let out = '';
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quote) {
            out += c;
            if (c === '\\') out += text[++i] ?? '';
            else if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
            quote = c;
            out += c;
        } else if (c === '\n' || c === '\r') {
            out = out.replace(/[ \t]+$/, '');
            while (i + 1 < text.length && /\s/.test(text[i + 1]!)) i++;
            out += ' ';
        } else {
            out += c;
        }
    }
    return out;
}

/**
 * An interpolated template string: ``$`/users/${inputs.id}` `` →
 * `"/users/{{inputs.id}}"`. Plain values are inserted as text.
 */
export function $(strings: TemplateStringsArray, ...values: unknown[]): string {
    let out = strings[0]!;
    values.forEach((v, i) => {
        if (isRef(v)) out += `{{${refPath(v)}}}`;
        else if (isExpr(v)) out += `{{${v[EXPR]}}}`;
        else out += String(v);
        out += strings[i + 1]!;
    });
    return out;
}

/**
 * Turn a builder value into plain template JSON: refs and exprs become
 * `{{ }}` strings, `undefined` keys are dropped, everything else is copied.
 */
export function toTemplate(value: unknown): unknown {
    if (isRef(value)) return `{{${refPath(value)}}}`;
    if (isExpr(value)) return `{{${value[EXPR]}}}`;
    if (Array.isArray(value)) return value.map(toTemplate);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            if (v !== undefined) out[k] = toTemplate(v);
        }
        return out;
    }
    return value;
}

/** A template-string field: a string as is, or a ref/expr rendered whole. */
export function toTemplateString(value: unknown): string {
    const t = toTemplate(value);
    if (typeof t !== 'string') throw new TypeError(`expected a template string, got ${typeof t}`);
    return t;
}
