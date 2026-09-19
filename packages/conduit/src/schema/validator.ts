/**
 * A compact JSON Schema (2020-12 subset) validator, used for both connector
 * specs and operation inputs. Zero dependencies.
 *
 * Supported keywords: `$ref` (local `#/$defs/…`), `type`, `properties`,
 * `required`, `additionalProperties`, `patternProperties`, `propertyNames`,
 * `items`, `enum`, `const`, `pattern`, `minLength`, `maxLength`, `minimum`,
 * `maximum`, `minItems`, `maxItems`, `uniqueItems`, `oneOf`, `anyOf`.
 * Annotations (`title`, `description`, `default`, `x-*`, …) are ignored.
 *
 * `oneOf` gets one extension in behaviour, not syntax: when every branch pins
 * the same property with `const` (a tagged union — `"type": "oauth2"`), the
 * branch is selected by that tag and only its errors are reported. That is
 * the difference between "type must be one of oauth2, apiKey, …" / "tokenUrl
 * is required" and an unreadable "matched none of 6 schemas".
 */

export type SchemaNode = Record<string, unknown>;

export interface SchemaIssue {
    path: string;
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

        if (s.type !== undefined) {
            const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
            if (!types.some((t) => matchesType(v, t))) {
                out.push({ path, message: `must be ${types.join(' or ')}, got ${typeOf(v)}` });
                return;
            }
        }
        if ('const' in s && !equal(v, s.const)) out.push({ path, message: `must be ${describe(s.const)}` });
        if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, v))) {
            out.push({ path, message: `must be one of ${s.enum.map(describe).join(', ')}` });
        }

        if (typeof v === 'string') {
            if (typeof s.minLength === 'number' && v.length < s.minLength) out.push({ path, message: `must be at least ${s.minLength} characters` });
            if (typeof s.maxLength === 'number' && v.length > s.maxLength) out.push({ path, message: `must be at most ${s.maxLength} characters` });
            if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) out.push({ path, message: `must match ${s.pattern}` });
        }
        if (typeof v === 'number') {
            if (typeof s.minimum === 'number' && v < s.minimum) out.push({ path, message: `must be >= ${s.minimum}` });
            if (typeof s.maximum === 'number' && v > s.maximum) out.push({ path, message: `must be <= ${s.maximum}` });
        }
        if (Array.isArray(v)) {
            if (typeof s.minItems === 'number' && v.length < s.minItems) out.push({ path, message: `must have at least ${s.minItems} item(s)` });
            if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push({ path, message: `must have at most ${s.maxItems} item(s)` });
            if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) out.push({ path, message: 'must not contain duplicates' });
            if (isObject(s.items)) v.forEach((item, i) => check(s.items as SchemaNode, item, join(path, i), out));
        }
        if (isObject(v)) {
            const props = isObject(s.properties) ? s.properties : {};
            if (Array.isArray(s.required)) {
                for (const key of s.required as string[]) {
                    if (!Object.hasOwn(v, key) || v[key] === undefined) out.push({ path: join(path, key), message: 'is required' });
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
                    if (s.additionalProperties === false) out.push({ path: child, message: 'is not a known property' });
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
            const tag = isObject(v) ? tagOf(branches) : undefined;
            if (tag && isObject(v)) {
                const values = branches.map((b) => (resolve(b).properties as Record<string, SchemaNode>)[tag]!.const);
                const index = values.findIndex((c) => equal(c, v[tag]));
                if (index === -1) {
                    out.push({
                        path: join(path, tag),
                        message: v[tag] === undefined ? 'is required' : `must be one of ${values.map(describe).join(', ')}`
                    });
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
                else if (passing > 1) out.push({ path, message: 'matches more than one allowed shape' });
            }
        }
    };

    check(schema, value, basePath, issues);
    return issues;
}
