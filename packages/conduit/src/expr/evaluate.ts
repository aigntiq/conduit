/**
 * Compiles an expression AST to a tree of async closures and runs it.
 *
 * The sandbox is structural rather than a runtime wrapper:
 *  - there is no `eval`/`Function` anywhere — the AST is the program;
 *  - member access only reads OWN properties of plain data, never
 *    `__proto__`/`constructor`/`prototype`, so nothing reaches a prototype;
 *  - only named functions from the registry (or lambdas) can be called;
 *  - every node evaluation spends one step from a per-run budget, and string
 *    results are length-capped, so a hostile spec cannot spin or balloon.
 *
 * Async end to end because some standard functions (digests, HMAC, JWT
 * signing) sit on WebCrypto, which only has async APIs.
 */
import { ConduitExpressionError } from '../errors';
import type { Node } from './ast';

export interface ExprFunction {
    /** Minimum number of arguments (including a piped value). */
    minArgs?: number;
    /** Maximum number of arguments; omit for variadic. */
    maxArgs?: number;
    /** One-line human signature, e.g. `join(list, separator?)`. For docs and tooling. */
    signature?: string;
    description?: string;
    /** Called with fully evaluated arguments. Lambdas arrive as `Lambda` instances. */
    call(args: unknown[], ctx: CallContext): unknown | Promise<unknown>;
}

export type FunctionRegistry = ReadonlyMap<string, ExprFunction>;

export interface CallContext {
    /** The evaluation clock, in epoch milliseconds. */
    now(): number;
    /**
     * Invoke a callable argument: a `Lambda`, or a string path shorthand
     * (`map(items, 'id')` ≡ `map(items, i => i.id)`).
     */
    invoke(fn: unknown, ...args: unknown[]): Promise<unknown>;
    /** Throw an expression error attributed to the calling function. */
    fail(message: string): never;
}

export interface EvalOptions {
    functions?: FunctionRegistry;
    /** Clock override, epoch ms. Defaults to `Date.now`. */
    now?: () => number;
    /** Node evaluations allowed per run. Default 100 000. */
    maxSteps?: number;
    /** Longest string a run may produce. Default 5 000 000 characters. */
    maxStringLength?: number;
}

export type Scope = Readonly<Record<string, unknown>>;

interface Run {
    source: string;
    steps: number;
    readonly maxSteps: number;
    readonly maxStringLength: number;
    readonly functions: FunctionRegistry;
    readonly now: () => number;
}

interface Env {
    readonly scope: Scope;
    readonly locals: Readonly<Record<string, unknown>> | null;
    readonly run: Run;
}

type Compiled = (env: Env) => Promise<unknown>;

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EMPTY_REGISTRY: FunctionRegistry = new Map();

/** A lambda value (`x => x.id`). Only callable by functions, never stored in output. */
export class Lambda {
    constructor(
        readonly params: readonly string[],
        private readonly body: Compiled,
        private readonly env: Env
    ) {}

    call(...args: unknown[]): Promise<unknown> {
        const locals: Record<string, unknown> = Object.create(this.env.locals);
        this.params.forEach((p, i) => {
            locals[p] = args[i];
        });
        return this.body({ scope: this.env.scope, locals, run: this.env.run });
    }
}

export function createRun(source: string, options: EvalOptions = {}): Run {
    return {
        source,
        steps: 0,
        maxSteps: options.maxSteps ?? 100_000,
        maxStringLength: options.maxStringLength ?? 5_000_000,
        functions: options.functions ?? EMPTY_REGISTRY,
        now: options.now ?? Date.now
    };
}

export function execute(compiled: Compiled, scope: Scope, run: Run): Promise<unknown> {
    return compiled({ scope, locals: null, run });
}

function fail(env: Env, message: string, pos?: number): never {
    throw new ConduitExpressionError(message, env.run.source, pos);
}

function tick(env: Env, pos: number): void {
    if (++env.run.steps > env.run.maxSteps) fail(env, `expression exceeded its budget of ${env.run.maxSteps} steps`, pos);
}

function capString(env: Env, s: string, pos: number): string {
    if (s.length > env.run.maxStringLength) fail(env, `string result longer than ${env.run.maxStringLength} characters`, pos);
    return s;
}

/** Read `key` from `target` without ever touching a prototype. */
export function getMember(target: unknown, key: unknown): unknown {
    if (target === null || target === undefined) return undefined;
    if (typeof key === 'number' || (typeof key === 'string' && /^-?\d+$/.test(key))) {
        if (Array.isArray(target) || typeof target === 'string') {
            const n = Number(key);
            return target[n < 0 ? target.length + n : n];
        }
    }
    const name = String(key);
    if (BLOCKED_KEYS.has(name)) throw new ConduitExpressionError(`access to "${name}" is not allowed`, '');
    if (Array.isArray(target) || typeof target === 'string' || ArrayBuffer.isView(target)) {
        return name === 'length' ? (target as { length: number }).length : undefined;
    }
    if (typeof target === 'object' && !(target instanceof Lambda)) {
        return Object.hasOwn(target, name) ? (target as Record<string, unknown>)[name] : undefined;
    }
    return undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
    }
    return false;
}

/** How a value reads when interpolated into a string. */
export function display(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (value instanceof Lambda) throw new ConduitExpressionError('a function cannot be converted to text', '');
    return JSON.stringify(value);
}

function toNumber(env: Env, value: unknown, op: string, pos: number): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return fail(env, `"${op}" needs numbers, got ${describeType(value)}`, pos);
}

export function describeType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Lambda) return 'function';
    return typeof value;
}

function compare(a: unknown, b: unknown): number | undefined {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') {
        const na = Number(a);
        const nb = Number(b);
        if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return a < b ? -1 : a > b ? 1 : 0;
    }
    const na = typeof a === 'string' || typeof a === 'number' ? Number(a) : NaN;
    const nb = typeof b === 'string' || typeof b === 'number' ? Number(b) : NaN;
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return undefined;
}

function setKey(env: Env, target: Record<string, unknown>, key: unknown, value: unknown, pos: number): void {
    const name = typeof key === 'string' ? key : display(key);
    if (BLOCKED_KEYS.has(name)) fail(env, `"${name}" cannot be used as an object key`, pos);
    target[name] = value;
}

export function compile(node: Node): Compiled {
    switch (node.type) {
        case 'literal': {
            const { value } = node;
            return async (env) => {
                tick(env, node.pos);
                return value;
            };
        }

        case 'ident': {
            const { name } = node;
            return async (env) => {
                tick(env, node.pos);
                if (env.locals && name in env.locals) return env.locals[name];
                return Object.hasOwn(env.scope, name) ? env.scope[name] : undefined;
            };
        }

        case 'member': {
            const object = compile(node.object);
            const property = typeof node.property === 'string' ? node.property : compile(node.property);
            return async (env) => {
                tick(env, node.pos);
                const target = await object(env);
                const key = typeof property === 'string' ? property : await property(env);
                try {
                    return getMember(target, key);
                } catch (e) {
                    return fail(env, (e as Error).message, node.pos);
                }
            };
        }

        case 'call': {
            const { callee } = node;
            const args = node.args.map(compile);
            return async (env) => {
                tick(env, node.pos);
                const values: unknown[] = [];
                for (const a of args) values.push(await a(env));
                const local = env.locals && callee in env.locals ? env.locals[callee] : undefined;
                if (local instanceof Lambda) return local.call(...values);
                const fn = env.run.functions.get(callee);
                if (!fn) return fail(env, `unknown function "${callee}"`, node.pos);
                if (fn.minArgs !== undefined && values.length < fn.minArgs) {
                    fail(env, `${callee}() needs at least ${fn.minArgs} argument(s), got ${values.length}`, node.pos);
                }
                if (fn.maxArgs !== undefined && values.length > fn.maxArgs) {
                    fail(env, `${callee}() takes at most ${fn.maxArgs} argument(s), got ${values.length}`, node.pos);
                }
                const ctx: CallContext = {
                    now: env.run.now,
                    invoke: (f, ...a) => invoke(env, f, a, node.pos),
                    fail: (message) => fail(env, `${callee}(): ${message}`, node.pos)
                };
                try {
                    const result = await fn.call(values, ctx);
                    return typeof result === 'string' ? capString(env, result, node.pos) : result;
                } catch (e) {
                    if (e instanceof ConduitExpressionError) {
                        if (e.source === '') throw new ConduitExpressionError(e.message, env.run.source, node.pos);
                        throw e;
                    }
                    return fail(env, `${callee}(): ${(e as Error).message}`, node.pos);
                }
            };
        }

        case 'unary': {
            const arg = compile(node.arg);
            const { op } = node;
            return async (env) => {
                tick(env, node.pos);
                const v = await arg(env);
                return op === '!' ? !v : -toNumber(env, v, '-', node.pos);
            };
        }

        case 'binary': {
            const left = compile(node.left);
            const right = compile(node.right);
            const { op, pos } = node;
            switch (op) {
                case '&&':
                    return async (env) => {
                        tick(env, pos);
                        const l = await left(env);
                        return l ? right(env) : l;
                    };
                case '||':
                    return async (env) => {
                        tick(env, pos);
                        const l = await left(env);
                        return l ? l : right(env);
                    };
                case '??':
                    return async (env) => {
                        tick(env, pos);
                        const l = await left(env);
                        return l === null || l === undefined ? right(env) : l;
                    };
            }
            return async (env) => {
                tick(env, pos);
                const l = await left(env);
                const r = await right(env);
                switch (op) {
                    case '+':
                        if (typeof l === 'number' && typeof r === 'number') return l + r;
                        return capString(env, display(l) + display(r), pos);
                    case '-':
                        return toNumber(env, l, op, pos) - toNumber(env, r, op, pos);
                    case '*':
                        return toNumber(env, l, op, pos) * toNumber(env, r, op, pos);
                    case '/':
                        return toNumber(env, l, op, pos) / toNumber(env, r, op, pos);
                    case '%':
                        return toNumber(env, l, op, pos) % toNumber(env, r, op, pos);
                    case '==':
                        return deepEqual(l, r);
                    case '!=':
                        return !deepEqual(l, r);
                    default: {
                        const c = compare(l, r);
                        if (c === undefined) return false;
                        if (op === '<') return c < 0;
                        if (op === '<=') return c <= 0;
                        if (op === '>') return c > 0;
                        return c >= 0;
                    }
                }
            };
        }

        case 'conditional': {
            const test = compile(node.test);
            const consequent = compile(node.consequent);
            const alternate = compile(node.alternate);
            return async (env) => {
                tick(env, node.pos);
                return (await test(env)) ? consequent(env) : alternate(env);
            };
        }

        case 'array': {
            const elements = node.elements.map((e) =>
                e.type === 'spread' ? { spread: true, value: compile(e.arg), pos: e.pos } : { spread: false, value: compile(e), pos: e.pos }
            );
            return async (env) => {
                tick(env, node.pos);
                const out: unknown[] = [];
                for (const e of elements) {
                    const v = await e.value(env);
                    if (!e.spread) out.push(v);
                    else if (Array.isArray(v)) out.push(...v);
                    else if (v !== null && v !== undefined) fail(env, `cannot spread ${describeType(v)} into an array`, e.pos);
                }
                return out;
            };
        }

        case 'object': {
            const entries = node.entries.map((e) =>
                e.type === 'spread'
                    ? { spread: true as const, value: compile(e.arg), pos: e.pos }
                    : {
                          spread: false as const,
                          key: typeof e.key === 'string' ? e.key : compile(e.key),
                          value: compile(e.value),
                          pos: e.pos
                      }
            );
            return async (env) => {
                tick(env, node.pos);
                const out: Record<string, unknown> = {};
                for (const e of entries) {
                    if (e.spread) {
                        const v = await e.value(env);
                        if (v === null || v === undefined) continue;
                        if (!isPlainObject(v)) fail(env, `cannot spread ${describeType(v)} into an object`, e.pos);
                        for (const k of Object.keys(v)) if (!BLOCKED_KEYS.has(k)) out[k] = v[k];
                        continue;
                    }
                    const key = typeof e.key === 'string' ? e.key : await e.key(env);
                    setKey(env, out, key, await e.value(env), e.pos);
                }
                return out;
            };
        }

        case 'lambda': {
            const body = compile(node.body);
            const { params } = node;
            return async (env) => {
                tick(env, node.pos);
                return new Lambda(params, body, env);
            };
        }
    }
}

async function invoke(env: Env, fn: unknown, args: unknown[], pos: number): Promise<unknown> {
    if (fn instanceof Lambda) return fn.call(...args);
    if (typeof fn === 'string') {
        // Path shorthand: 'a.b' reads that path from the first argument.
        let target: unknown = args[0];
        for (const part of fn.split('.')) {
            try {
                target = getMember(target, part);
            } catch (e) {
                return fail(env, (e as Error).message, pos);
            }
        }
        return target;
    }
    return fail(env, `expected a function (x => …) or a property path, got ${describeType(fn)}`, pos);
}
