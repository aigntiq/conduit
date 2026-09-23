/**
 * Static analysis for expressions and templates — the part of validation
 * that runs without a scope: syntax, unknown functions, and which scope
 * roots an expression reads.
 */
import { ConduitExpressionError } from '../errors';
import type { Node } from './ast';
import type { FunctionRegistry } from './evaluate';
import { parseExpression } from './parser';
import { findExpressions } from './template';
import { isPlainObject } from './evaluate';

export interface ExpressionIssue {
    message: string;
    /** Offset into the analysed text. */
    position?: number;
    severity: 'error' | 'warning';
}

export interface ExpressionAnalysis {
    issues: ExpressionIssue[];
    /** Free identifiers read, e.g. `inputs`, `response`. */
    roots: Set<string>;
    /** Functions called (excluding lambda-valued locals). */
    functions: Set<string>;
}

export interface AnalyzeOptions {
    /** When given, calling anything not in it is an error. */
    functions?: FunctionRegistry | ReadonlySet<string>;
    /** When given, reading a root not in it is a warning (it will read as undefined). */
    roots?: ReadonlySet<string>;
}

function walk(node: Node, bound: ReadonlySet<string>, out: ExpressionAnalysis, options: AnalyzeOptions): void {
    switch (node.type) {
        case 'literal':
            return;
        case 'ident':
            if (!bound.has(node.name)) {
                out.roots.add(node.name);
                if (options.roots && !options.roots.has(node.name)) {
                    out.issues.push({
                        message: `"${node.name}" is not available here (available: ${[...options.roots].join(', ')})`,
                        position: node.pos,
                        severity: 'warning'
                    });
                }
            }
            return;
        case 'member':
            walk(node.object, bound, out, options);
            if (typeof node.property !== 'string') walk(node.property, bound, out, options);
            return;
        case 'call':
            if (!bound.has(node.callee)) {
                out.functions.add(node.callee);
                if (options.functions && !options.functions.has(node.callee)) {
                    out.issues.push({ message: `unknown function "${node.callee}"`, position: node.pos, severity: 'error' });
                }
            }
            for (const a of node.args) walk(a, bound, out, options);
            return;
        case 'unary':
            walk(node.arg, bound, out, options);
            return;
        case 'binary':
            walk(node.left, bound, out, options);
            walk(node.right, bound, out, options);
            return;
        case 'conditional':
            walk(node.test, bound, out, options);
            walk(node.consequent, bound, out, options);
            walk(node.alternate, bound, out, options);
            return;
        case 'array':
            for (const e of node.elements) walk(e.type === 'spread' ? e.arg : e, bound, out, options);
            return;
        case 'object':
            for (const e of node.entries) {
                if (e.type === 'spread') walk(e.arg, bound, out, options);
                else {
                    if (typeof e.key !== 'string') walk(e.key, bound, out, options);
                    walk(e.value, bound, out, options);
                }
            }
            return;
        case 'lambda':
            walk(node.body, new Set([...bound, ...node.params]), out, options);
            return;
    }
}

function emptyAnalysis(): ExpressionAnalysis {
    return { issues: [], roots: new Set(), functions: new Set() };
}

function analyzeInto(source: string, offset: number, out: ExpressionAnalysis, options: AnalyzeOptions): void {
    let ast: Node;
    try {
        ast = parseExpression(source);
    } catch (e) {
        if (e instanceof ConduitExpressionError) {
            out.issues.push({ message: e.message, position: offset + (e.position ?? 0), severity: 'error' });
            return;
        }
        throw e;
    }
    const before = out.issues.length;
    walk(ast, new Set(), out, options);
    for (let i = before; i < out.issues.length; i++) {
        const issue = out.issues[i]!;
        if (issue.position !== undefined) issue.position += offset;
    }
}

/** Analyse a bare expression (no `{{ }}`). */
export function analyzeExpression(source: string, options: AnalyzeOptions = {}): ExpressionAnalysis {
    const out = emptyAnalysis();
    analyzeInto(source, 0, out, options);
    return out;
}

/** Analyse one template string. Positions are offsets into the string. */
export function analyzeTemplateString(text: string, options: AnalyzeOptions = {}): ExpressionAnalysis {
    const out = emptyAnalysis();
    let spans;
    try {
        spans = findExpressions(text);
    } catch (e) {
        if (e instanceof ConduitExpressionError) {
            out.issues.push({ message: e.message, position: e.position, severity: 'error' });
            return out;
        }
        throw e;
    }
    for (const span of spans) analyzeInto(span.source, span.offset, out, options);
    return out;
}

export interface LocatedIssue extends ExpressionIssue {
    /** Path within the analysed value, e.g. `body.items[0].name`. */
    path: string;
}

/**
 * Analyse every template string inside a JSON-shaped value. Returns issues
 * with their path relative to `basePath`, plus the union of roots and
 * functions used.
 */
export function analyzeTemplate(
    value: unknown,
    options: AnalyzeOptions = {},
    basePath = ''
): { issues: LocatedIssue[]; roots: Set<string>; functions: Set<string> } {
    const result = { issues: [] as LocatedIssue[], roots: new Set<string>(), functions: new Set<string>() };
    const visit = (v: unknown, path: string): void => {
        if (typeof v === 'string') {
            if (!v.includes('{{')) return;
            const a = analyzeTemplateString(v, options);
            for (const issue of a.issues) result.issues.push({ ...issue, path });
            a.roots.forEach((r) => result.roots.add(r));
            a.functions.forEach((f) => result.functions.add(f));
        } else if (Array.isArray(v)) {
            v.forEach((item, i) => visit(item, `${path}[${i}]`));
        } else if (isPlainObject(v)) {
            for (const key of Object.keys(v)) visit(v[key], path ? `${path}.${key}` : key);
        }
    };
    visit(value, basePath);
    return result;
}
