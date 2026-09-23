/**
 * `{{ }}` templates.
 *
 *  - A string that is exactly one `{{ expr }}` (nothing around it) evaluates
 *    to the expression's raw value, so `"{{inputs.count}}"` stays a number
 *    and `"{{response.body.items}}"` stays a list.
 *  - Any other string with `{{ }}` interpolates: each value is converted to
 *    text (`null`/`undefined` → "", objects → JSON).
 *  - Strings without `{{` are literals.
 *
 * `renderTemplate` walks JSON-shaped values deeply. An object key whose
 * template renders `undefined` is DROPPED — that is how a spec writes an
 * optional query parameter or body field: `"limit": "{{inputs.limit}}"`.
 */
import { ConduitExpressionError } from '../errors';
import { compile, createRun, display, execute, isPlainObject, type EvalOptions, type Scope } from './evaluate';
import { parseExpression } from './parser';

type Compiled = ReturnType<typeof compile>;

export interface ExpressionSegment {
    source: string;
    /** Offset of the expression source within the template string. */
    offset: number;
    compiled: Compiled;
}

export interface CompiledTemplate {
    readonly text: string;
    /** True when the template is exactly one expression (raw value). */
    readonly whole: boolean;
    readonly segments: readonly (string | ExpressionSegment)[];
}

export interface TemplateSpan {
    source: string;
    offset: number;
}

/**
 * Locate the `{{ … }}` spans in a string. Tracks string literals and brace
 * depth so object literals (`{{ {a: {b: 1}} }}`) and strings containing
 * `}}` parse correctly.
 */
export function findExpressions(text: string): TemplateSpan[] {
    const spans: TemplateSpan[] = [];
    let i = 0;
    while (i < text.length) {
        const open = text.indexOf('{{', i);
        if (open === -1) break;
        let j = open + 2;
        let depth = 0;
        let quote: string | null = null;
        let closed = false;
        while (j < text.length) {
            const c = text[j]!;
            if (quote) {
                if (c === '\\') j++;
                else if (c === quote) quote = null;
            } else if (c === "'" || c === '"') {
                quote = c;
            } else if (c === '{') {
                depth++;
            } else if (c === '}') {
                if (depth === 0 && text[j + 1] === '}') {
                    closed = true;
                    break;
                }
                depth--;
            }
            j++;
        }
        if (!closed) throw new ConduitExpressionError('unterminated "{{" in template', text, open);
        spans.push({ source: text.slice(open + 2, j), offset: open + 2 });
        i = j + 2;
    }
    return spans;
}

export function isTemplateString(value: unknown): value is string {
    return typeof value === 'string' && value.includes('{{');
}

const CACHE_LIMIT = 5_000;
const cache = new Map<string, CompiledTemplate>();

export function compileTemplate(text: string): CompiledTemplate {
    const cached = cache.get(text);
    if (cached) return cached;

    const spans = findExpressions(text);
    const segments: (string | ExpressionSegment)[] = [];
    let cursor = 0;
    for (const span of spans) {
        const before = text.slice(cursor, span.offset - 2);
        if (before) segments.push(before);
        let compiled: Compiled;
        try {
            compiled = compile(parseExpression(span.source));
        } catch (e) {
            if (e instanceof ConduitExpressionError) {
                throw new ConduitExpressionError(e.message, text, (e.position ?? 0) + span.offset);
            }
            throw e;
        }
        segments.push({ source: span.source, offset: span.offset, compiled });
        cursor = span.offset + span.source.length + 2;
    }
    const after = text.slice(cursor);
    if (after) segments.push(after);

    const whole = segments.length === 1 && typeof segments[0] !== 'string';
    const result: CompiledTemplate = { text, whole, segments };
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(text, result);
    return result;
}

async function renderString(text: string, scope: Scope, options: EvalOptions, run: ReturnType<typeof createRun>): Promise<unknown> {
    const template = compileTemplate(text);
    if (template.whole) {
        const seg = template.segments[0] as ExpressionSegment;
        run.source = seg.source;
        return execute(seg.compiled, scope, run);
    }
    let out = '';
    for (const seg of template.segments) {
        if (typeof seg === 'string') {
            out += seg;
            continue;
        }
        run.source = seg.source;
        out += display(await execute(seg.compiled, scope, run));
        if (out.length > (options.maxStringLength ?? 5_000_000)) {
            throw new ConduitExpressionError('template result is too long', text);
        }
    }
    return out;
}

async function renderValue(value: unknown, scope: Scope, options: EvalOptions, run: ReturnType<typeof createRun>): Promise<unknown> {
    if (typeof value === 'string') return value.includes('{{') ? renderString(value, scope, options, run) : value;
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) out.push(await renderValue(item, scope, options, run));
        return out;
    }
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            const rendered = await renderValue(value[key], scope, options, run);
            if (rendered !== undefined) out[key] = rendered;
        }
        return out;
    }
    return value;
}

/**
 * Render a template value against a scope. Strings, arrays and plain objects
 * are walked deeply; every other value is returned as is. One step budget is
 * shared across the whole value.
 */
export async function renderTemplate(value: unknown, scope: Scope, options: EvalOptions = {}): Promise<unknown> {
    return renderValue(value, scope, options, createRun('', options));
}

/** Evaluate a bare expression (no `{{ }}`) against a scope. */
export async function evaluateExpression(source: string, scope: Scope, options: EvalOptions = {}): Promise<unknown> {
    return execute(compileExpression(source), scope, createRun(source, options));
}

const exprCache = new Map<string, Compiled>();

export function compileExpression(source: string): Compiled {
    let compiled = exprCache.get(source);
    if (!compiled) {
        compiled = compile(parseExpression(source));
        if (exprCache.size >= CACHE_LIMIT) exprCache.clear();
        exprCache.set(source, compiled);
    }
    return compiled;
}
