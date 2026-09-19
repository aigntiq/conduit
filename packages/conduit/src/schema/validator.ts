/**
 * A compact JSON Schema (2020-12 subset) validator, used for connector specs,
 * operation inputs and forms. Zero dependencies, runs anywhere.
 *
 * Supported keywords: `$ref` (local `#/$defs/…`), `type`, `properties`,
 * `required`, `additionalProperties`, `patternProperties`, `propertyNames`,
 * `minProperties`, `items`, `enum`, `const`, `oneOf`, `anyOf`, `pattern`,
 * `format`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`,
 * `maxItems`, `uniqueItems`. Annotations (`title`, `default`, `x-*`, …) are
 * ignored.
 *
 * Formats checked: `email`, `uri`/`url`, `date`, `date-time`, `uuid`. Other
 * formats (e.g. `password`) are annotations.
 *
 * `oneOf` gets one extension in behaviour, not syntax: when every branch pins
 * the same property with `const` (a tagged union — `"type": "oauth2"`), the
 * branch is selected by that tag and only its errors are reported. A `oneOf`
 * whose branches are all `{ const }` (labelled choices) reads like `enum`.
 */

export type SchemaNode = Record<string, unknown>;

export interface SchemaIssue {
    path: string;
    /** The failing keyword: `type`, `required`, `enum`, `format`, `minLength`, … */
    keyword: string;
    params?: Record<string, unknown>;
    message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

function matchesType(v: unknown, type: string): boolean {
    const actual = typeOf(v);
    if (type === 'number') return actual === 'number' || actual === 'integer';
    return actual === type;
}

function join(path: string, key: string | number): string {
    if (typeof key === 'number') return `${path}[${key}]`;
    return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
}

function equal(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function describe(v: unknown): string {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

const FORMATS: Record<string, (v: string) => boolean> = {
    // A bare address, or a mailbox with a display name: `Ada <ada@example.com>`.
    email: (v) => ADDRESS.test(/^[^<>]*<([^<>]+)>$/.exec(v.trim())?.[1] ?? v),
    uri: (v) => {
        try {
            return /^[a-z][a-z0-9+.-]*:/i.test(v) && !!new URL(v);
        } catch {
            return false;
        }
    },
    date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
    'date-time': (v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(v) && !Number.isNaN(Date.parse(v)),
    uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
};
FORMATS.url = FORMATS.uri!;

const FORMAT_NAMES: Record<string, string> = { email: 'an email address', uri: 'a URL', url: 'a URL', date: 'a date (YYYY-MM-DD)', 'date-time': 'a date and time', uuid: 'a UUID' };

export function checkFormat(format: string, value: string): boolean {
    const check = FORMATS[format];
    return check ? check(value) : true;
}

export function validateAgainstSchema(schema: SchemaNode, value: unknown, basePath = ''): SchemaIssue[] {
    const root = schema;
    const issues: SchemaIssue[] = [];

    const resolve = (node: SchemaNode): SchemaNode => {
        let current = node;
        for (let guard = 0; typeof current.$ref === 'string'; guard++) {
            if (guard > 32) throw new Error('schema $ref cycle');
            const ref = current.$ref;
            if (!ref.startsWith('#/')) throw new Error(`unsupported $ref "${ref}"`);
            let target: unknown = root;
            for (const part of ref.slice(2).split('/')) target = (target as Record<string, unknown>)[part];
            if (!isObject(target)) throw new Error(`unresolved $ref "${ref}"`);
            current = target;
        }
        return current;
    };

    const tagOf = (branches: SchemaNode[]): string | undefined => {
        let tag: string | undefined;
        for (const b of branches.map(resolve)) {
            const props = b.properties;
            if (!isObject(props)) return undefined;
            const found = Object.keys(props).find((k) => isObject(props[k]) && 'const' in (props[k] as object));
            if (!found || (tag && tag !== found)) return undefined;
            tag = found;
        }
        return tag;
    };

    const check = (node: SchemaNode, v: unknown, path: string, out: SchemaIssue[]): void => {
        const s = resolve(node);
        const push = (keyword: string, message: string, params?: Record<string, unknown>, at = path) =>
            out.push(params ? { path: at, keyword, params, message } : { path: at, keyword, message });

        if (s.type !== undefined) {
            const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
            if (!types.some((t) => matchesType(v, t))) {
                push('type', `must be ${types.join(' or ')}, got ${typeOf(v)}`, { expected: types, actual: typeOf(v) });
                return;
            }
        }
        if ('const' in s && !equal(v, s.const)) push('const', `must be ${describe(s.const)}`, { expected: s.const });
        if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, v))) {
            push('enum', `must be one of ${s.enum.map(describe).join(', ')}`, { allowed: s.enum });
        }

        if (typeof v === 'string') {
            if (typeof s.minLength === 'number' && v.length < s.minLength) push('minLength', `must be at least ${s.minLength} characters`, { limit: s.minLength });
            if (typeof s.maxLength === 'number' && v.length > s.maxLength) push('maxLength', `must be at most ${s.maxLength} characters`, { limit: s.maxLength });
            if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) push('pattern', `must match ${s.pattern}`, { pattern: s.pattern });
            if (typeof s.format === 'string' && !checkFormat(s.format, v)) {
                push('format', `must be ${FORMAT_NAMES[s.format] ?? `a valid ${s.format}`}`, { format: s.format });
            }
        }
        if (typeof v === 'number') {
            if (typeof s.minimum === 'number' && v < s.minimum) push('minimum', `must be >= ${s.minimum}`, { limit: s.minimum });
            if (typeof s.maximum === 'number' && v > s.maximum) push('maximum', `must be <= ${s.maximum}`, { limit: s.maximum });
        }
        if (Array.isArray(v)) {
            if (typeof s.minItems === 'number' && v.length < s.minItems) push('minItems', `must have at least ${s.minItems} item(s)`, { limit: s.minItems });
            if (typeof s.maxItems === 'number' && v.length > s.maxItems) push('maxItems', `must have at most ${s.maxItems} item(s)`, { limit: s.maxItems });
            if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) push('uniqueItems', 'must not contain duplicates');
            if (isObject(s.items)) v.forEach((item, i) => check(s.items as SchemaNode, item, join(path, i), out));
        }
        if (isObject(v)) {
            const props = isObject(s.properties) ? s.properties : {};
            if (typeof s.minProperties === 'number' && Object.keys(v).length < s.minProperties) {
                push('minProperties', `must have at least ${s.minProperties} propert${s.minProperties === 1 ? 'y' : 'ies'}`, { limit: s.minProperties });
            }
            if (Array.isArray(s.required)) {
                for (const key of s.required as string[]) {
                    if (!Object.hasOwn(v, key) || v[key] === undefined) push('required', 'is required', undefined, join(path, key));
                }
            }
            const patterns = isObject(s.patternProperties) ? Object.entries(s.patternProperties) : [];
            for (const key of Object.keys(v)) {
                const child = join(path, key);
                if (isObject(s.propertyNames)) check(s.propertyNames, key, child, out);
                let known = false;
                if (Object.hasOwn(props, key)) {
                    known = true;
                    check(props[key] as SchemaNode, v[key], child, out);
                }
                for (const [pattern, sub] of patterns) {
                    if (new RegExp(pattern, 'u').test(key)) {
                        known = true;
                        check(sub as SchemaNode, v[key], child, out);
                    }
                }
                if (!known) {
                    if (s.additionalProperties === false) push('additionalProperties', 'is not a known property', undefined, child);
                    else if (isObject(s.additionalProperties)) check(s.additionalProperties, v[key], child, out);
                }
            }
        }

        if (Array.isArray(s.anyOf)) {
            const attempts = (s.anyOf as SchemaNode[]).map((b) => {
                const o: SchemaIssue[] = [];
                check(b, v, path, o);
                return o;
            });
            if (!attempts.some((a) => a.length === 0)) {
                // Report the closest branch — the one with the fewest issues.
                out.push(...attempts.reduce((best, a) => (a.length < best.length ? a : best)));
            }
        }

        if (Array.isArray(s.oneOf)) {
            const branches = s.oneOf as SchemaNode[];
            const choices = branches.every((b) => isObject(b) && 'const' in b && Object.keys(b).every((k) => k === 'const' || k === 'title' || k === 'description'));
            const tag = !choices && isObject(v) ? tagOf(branches) : undefined;
            if (choices) {
                if (!branches.some((b) => equal(b.const, v))) {
                    const allowed = branches.map((b) => b.const);
                    push('enum', `must be one of ${allowed.map(describe).join(', ')}`, { allowed });
                }
            } else if (tag && isObject(v)) {
                const values = branches.map((b) => (resolve(b).properties as Record<string, SchemaNode>)[tag]!.const);
                const index = values.findIndex((c) => equal(c, v[tag]));
                if (index === -1) {
                    if (v[tag] === undefined) push('required', 'is required', undefined, join(path, tag));
                    else push('enum', `must be one of ${values.map(describe).join(', ')}`, { allowed: values }, join(path, tag));
                } else {
                    check(branches[index]!, v, path, out);
                }
            } else {
                const results = branches.map((b) => {
                    const o: SchemaIssue[] = [];
                    check(b, v, path, o);
                    return o;
                });
                const passing = results.filter((r) => r.length === 0).length;
                if (passing === 0) out.push(...results.reduce((best, a) => (a.length < best.length ? a : best)));
                else if (passing > 1) push('oneOf', 'matches more than one allowed shape');
            }
        }
    };

    check(schema, value, basePath, issues);
    return issues;
}
