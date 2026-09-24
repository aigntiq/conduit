/**
 * The Conduit expression standard library.
 *
 * Every function takes the (optionally piped) subject as its first argument,
 * so `list | join(', ')` ≡ `join(list, ', ')`. Functions are total where that
 * is cheap — `null`/`undefined` in yields `null`/`undefined`/empty out rather
 * than an error — because connector specs map whatever an API returned, and
 * a missing field should read as missing, not crash the call.
 */
import { fromBase64, fromUtf8, toBase64, toBase64Url, toHex, utf8 } from '../util/bytes';
import { buildMime, flattenTree, type MimeMessage } from './mime';
import { digest, hmac, signJwt, type DigestAlgorithm, type JwtAlgorithm, JWT_ALGORITHMS } from '../util/crypto';
import { deepEqual, describeType, display, getMember, isPlainObject, type CallContext, type ExprFunction, type FunctionRegistry } from './evaluate';

type Fn = ExprFunction['call'];

const define = (signature: string, description: string, call: Fn, minArgs?: number, maxArgs?: number): ExprFunction => ({
    signature,
    description,
    call,
    minArgs,
    maxArgs
});

const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;

function asList(ctx: CallContext, v: unknown): unknown[] {
    if (isNil(v)) return [];
    if (Array.isArray(v)) return v;
    return ctx.fail(`expected a list, got ${describeType(v)}`);
}

function asString(v: unknown): string {
    return display(v);
}

/** Bytes as they are (a binary response body); anything else as UTF-8 text. */
function asBytes(v: unknown): Uint8Array {
    return v instanceof Uint8Array ? v : utf8(asString(v));
}

/** Base64 text as it is; bytes (a binary response body) encoded. */
function asBase64(v: unknown): string {
    return v instanceof Uint8Array ? toBase64(v) : asString(v).trim();
}

function byteLength(v: unknown): number {
    if (isNil(v)) return 0;
    if (v instanceof Uint8Array) return v.length;
    const b64 = asBase64(v).replace(/=+$/, '');
    return Math.floor((b64.length * 3) / 4);
}

/** The longest base64 slice `chunks` hands out: the evaluator's string cap. */
const MAX_CHUNK_CHARS = 5_000_000;

function chunks(ctx: CallContext, v: unknown, size: unknown): { base64: string; start: number; end: number; total: number }[] {
    // Whole base64 quanta (3 bytes = 4 characters), so every slice decodes on its own.
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size % 3 !== 0) {
        return ctx.fail(`chunks: size must be a positive multiple of 3`);
    }
    const chars = (size / 3) * 4;
    if (chars > MAX_CHUNK_CHARS) return ctx.fail(`chunks: size ${size} is too large`);
    if (isNil(v)) return [];
    const b64 = asBase64(v);
    const total = byteLength(b64);
    const out: { base64: string; start: number; end: number; total: number }[] = [];
    for (let i = 0, start = 0; start < total; i++, start += size) {
        out.push({ base64: b64.slice(i * chars, (i + 1) * chars), start, end: Math.min(start + size, total) - 1, total });
    }
    return out;
}

function asNumber(ctx: CallContext, v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return ctx.fail(`expected a number, got ${describeType(v)}`);
}

function isEmpty(v: unknown): boolean {
    if (isNil(v) || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (isPlainObject(v)) return Object.keys(v).length === 0;
    return false;
}

function toDate(ctx: CallContext, v: unknown): Date {
    if (v instanceof Date) return v;
    // Epoch numbers: below 1e11 they are seconds (1e11 ms is only 1973), above it millis.
    if (typeof v === 'number') return new Date(Math.abs(v) < 1e11 ? v * 1000 : v);
    if (typeof v === 'string') {
        // All-digit strings are epoch values: 10 digits → seconds, 13 → millis.
        if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000);
        if (/^\d{12,14}$/.test(v)) return new Date(Number(v));
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) return d;
    }
    return ctx.fail(`cannot read ${describeType(v)} "${display(v)}" as a date`);
}

const UNIT_MS: Record<string, number> = {
    ms: 1,
    millisecond: 1,
    milliseconds: 1,
    s: 1000,
    second: 1000,
    seconds: 1000,
    m: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    w: 604_800_000,
    week: 604_800_000,
    weeks: 604_800_000
};

async function mapList(ctx: CallContext, list: unknown[], fn: unknown): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < list.length; i++) out.push(await ctx.invoke(fn, list[i], i));
    return out;
}

const DIGESTS: Record<string, DigestAlgorithm> = {
    sha1: 'SHA-1',
    sha256: 'SHA-256',
    sha384: 'SHA-384',
    sha512: 'SHA-512'
};

function encodeBytes(ctx: CallContext, bytes: Uint8Array, encoding: unknown): string {
    switch (encoding ?? 'hex') {
        case 'hex':
            return toHex(bytes);
        case 'base64':
            return toBase64(bytes);
        case 'base64url':
            return toBase64Url(bytes);
        default:
            return ctx.fail(`unknown encoding "${display(encoding)}" (hex, base64, base64url)`);
    }
}

export const STANDARD_FUNCTIONS: Record<string, ExprFunction> = {
    // ── values & types ──────────────────────────────────────────────────
    default: define('default(value, fallback)', 'The value, or the fallback when it is null, undefined or "".', ([v, f]) => (isNil(v) || v === '' ? f : v), 2, 2),
    ifEmpty: define('ifEmpty(value, fallback)', 'Like default, but also treats [] and {} as empty.', ([v, f]) => (isEmpty(v) ? f : v), 2, 2),
    isEmpty: define('isEmpty(value)', 'True for null, undefined, "", [] and {}.', ([v]) => isEmpty(v), 1, 1),
    type: define('type(value)', 'One of: null, undefined, string, number, boolean, array, object.', ([v]) => describeType(v), 1, 1),
    string: define('string(value)', 'Text form of a value (objects become JSON).', ([v]) => asString(v), 1, 1),
    number: define(
        'number(value)',
        'Parse a number; null when it is not one.',
        ([v]) => {
            if (typeof v === 'number') return v;
            if (typeof v === 'boolean') return v ? 1 : 0;
            if (typeof v === 'string' && v.trim() !== '') {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            }
            return null;
        },
        1,
        1
    ),
    boolean: define(
        'boolean(value)',
        'Truthiness, with "false", "0" and "" as false.',
        ([v]) => (typeof v === 'string' ? !['', '0', 'false', 'no', 'off'].includes(v.trim().toLowerCase()) : Boolean(v)),
        1,
        1
    ),
    json: define('json(value)', 'Serialize to JSON text.', ([v]) => JSON.stringify(v ?? null), 1, 1),
    parseJson: define(
        'parseJson(text)',
        'Parse JSON text; null/undefined pass through.',
        ([v], ctx) => {
            if (isNil(v) || v === '') return v === '' ? undefined : v;
            if (typeof v !== 'string') return v;
            try {
                return JSON.parse(v);
            } catch {
                return ctx.fail('text is not valid JSON');
            }
        },
        1,
        1
    ),
    equals: define('equals(a, b)', 'Deep equality.', ([a, b]) => deepEqual(a, b), 2, 2),

    // ── text ────────────────────────────────────────────────────────────
    upper: define('upper(text)', 'Upper-case.', ([v]) => (isNil(v) ? v : asString(v).toUpperCase()), 1, 1),
    lower: define('lower(text)', 'Lower-case.', ([v]) => (isNil(v) ? v : asString(v).toLowerCase()), 1, 1),
    trim: define('trim(text)', 'Strip surrounding whitespace.', ([v]) => (isNil(v) ? v : asString(v).trim()), 1, 1),
    split: define(
        'split(text, separator?)',
        'Split text into a list (default separator ",").',
        ([v, sep]) => (isNil(v) || v === '' ? [] : asString(v).split(isNil(sep) ? ',' : asString(sep))),
        1,
        2
    ),
    join: define('join(list, separator?)', 'Join a list into text (default separator ",").', ([v, sep], ctx) => asList(ctx, v).map(asString).join(isNil(sep) ? ',' : asString(sep)), 1, 2),
    replace: define(
        'replace(text, find, replacement)',
        'Replace every literal occurrence.',
        ([v, find, repl]) => (isNil(v) ? v : asString(v).split(asString(find)).join(asString(repl))),
        3,
        3
    ),
    startsWith: define('startsWith(text, prefix)', 'Prefix test.', ([v, p]) => !isNil(v) && asString(v).startsWith(asString(p)), 2, 2),
    endsWith: define('endsWith(text, suffix)', 'Suffix test.', ([v, s]) => !isNil(v) && asString(v).endsWith(asString(s)), 2, 2),
    contains: define(
        'contains(textOrList, item)',
        'Substring test for text; deep membership test for lists; key test for objects.',
        ([v, item]) => {
            if (isNil(v)) return false;
            if (Array.isArray(v)) return v.some((x) => deepEqual(x, item));
            if (isPlainObject(v)) return Object.hasOwn(v, asString(item));
            return asString(v).includes(asString(item));
        },
        2,
        2
    ),
    substring: define(
        'substring(text, start, end?)',
        'Slice text by character offsets.',
        ([v, s, e], ctx) => (isNil(v) ? v : asString(v).slice(asNumber(ctx, s), isNil(e) ? undefined : asNumber(ctx, e))),
        2,
        3
    ),
    padStart: define(
        'padStart(text, length, fill?)',
        'Left-pad text to a length.',
        ([v, n, fill], ctx) => asString(v).padStart(asNumber(ctx, n), isNil(fill) ? ' ' : asString(fill)),
        2,
        3
    ),
    length: define(
        'length(value)',
        'Length of text, a list or bytes, or the number of keys of an object.',
        ([v]) => (isNil(v) ? 0 : Array.isArray(v) || typeof v === 'string' || v instanceof Uint8Array ? v.length : isPlainObject(v) ? Object.keys(v).length : 0),
        1,
        1
    ),
    urlEncode: define('urlEncode(text)', 'Percent-encode a URL component.', ([v]) => encodeURIComponent(asString(v)), 1, 1),
    urlDecode: define('urlDecode(text)', 'Decode a percent-encoded URL component.', ([v]) => decodeURIComponent(asString(v)), 1, 1),
    base64: define('base64(textOrBytes)', 'Base64-encode UTF-8 text, or bytes (a binary response body) as they are.', ([v]) => toBase64(asBytes(v)), 1, 1),
    base64url: define('base64url(textOrBytes)', 'Unpadded base64url-encode UTF-8 text, or bytes as they are.', ([v]) => toBase64Url(asBytes(v)), 1, 1),
    fromBase64: define('fromBase64(text)', 'Decode base64 or base64url to UTF-8 text.', ([v]) => (isNil(v) ? v : fromUtf8(fromBase64(asString(v)))), 1, 1),
    byteLength: define('byteLength(base64OrBytes)', 'Bytes in base64 or bytes.', ([v]) => byteLength(v), 1, 1),
    chunks: define('chunks(base64OrBytes, size)', 'Byte ranges of `size` (a multiple of 3): [{base64, start, end, total}].', ([v, size], ctx) => chunks(ctx, v, size), 2, 2),

    // ── lists ───────────────────────────────────────────────────────────
    map: define('map(list, fn)', 'Transform each item: map(items, i => i.id) or map(items, "id").', async ([v, fn], ctx) => mapList(ctx, asList(ctx, v), fn), 2, 2),
    filter: define(
        'filter(list, fn)',
        'Keep items the function returns truthy for.',
        async ([v, fn], ctx) => {
            const out: unknown[] = [];
            const list = asList(ctx, v);
            for (let i = 0; i < list.length; i++) if (await ctx.invoke(fn, list[i], i)) out.push(list[i]);
            return out;
        },
        2,
        2
    ),
    find: define(
        'find(list, fn)',
        'First item the function returns truthy for, or undefined.',
        async ([v, fn], ctx) => {
            const list = asList(ctx, v);
            for (let i = 0; i < list.length; i++) if (await ctx.invoke(fn, list[i], i)) return list[i];
            return undefined;
        },
        2,
        2
    ),
    some: define(
        'some(list, fn)',
        'True when any item matches.',
        async ([v, fn], ctx) => {
            const list = asList(ctx, v);
            for (let i = 0; i < list.length; i++) if (await ctx.invoke(fn, list[i], i)) return true;
            return false;
        },
        2,
        2
    ),
    every: define(
        'every(list, fn)',
        'True when every item matches.',
        async ([v, fn], ctx) => {
            const list = asList(ctx, v);
            for (let i = 0; i < list.length; i++) if (!(await ctx.invoke(fn, list[i], i))) return false;
            return true;
        },
        2,
        2
    ),
    flatMap: define(
        'flatMap(list, fn)',
        'Map, then flatten one level.',
        async ([v, fn], ctx) => (await mapList(ctx, asList(ctx, v), fn)).flatMap((x) => (Array.isArray(x) ? x : [x])),
        2,
        2
    ),
    sortBy: define(
        'sortBy(list, fn, direction?)',
        'Stable sort by a key function or path; direction "asc" (default) or "desc".',
        async ([v, fn, dir], ctx) => {
            const list = asList(ctx, v);
            const keyed = await Promise.all(list.map(async (item, i) => ({ item, i, key: await ctx.invoke(fn, item, i) })));
            const sign = dir === 'desc' ? -1 : 1;
            keyed.sort((a, b) => {
                const ka = a.key as never;
                const kb = b.key as never;
                if (ka === kb) return a.i - b.i;
                if (isNil(ka)) return 1;
                if (isNil(kb)) return -1;
                return (ka < kb ? -1 : ka > kb ? 1 : a.i - b.i) * sign;
            });
            return keyed.map((k) => k.item);
        },
        2,
        3
    ),
    groupBy: define(
        'groupBy(list, fn)',
        'Group items into an object keyed by the function result.',
        async ([v, fn], ctx) => {
            const out: Record<string, unknown[]> = {};
            const list = asList(ctx, v);
            for (let i = 0; i < list.length; i++) {
                const key = asString(await ctx.invoke(fn, list[i], i));
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') ctx.fail(`"${key}" cannot be a group key`);
                (out[key] ??= []).push(list[i]);
            }
            return out;
        },
        2,
        2
    ),
    first: define('first(list)', 'First item.', ([v], ctx) => asList(ctx, v)[0], 1, 1),
    last: define('last(list)', 'Last item.', ([v], ctx) => asList(ctx, v).at(-1), 1, 1),
    slice: define(
        'slice(list, start, end?)',
        'A sub-list by index.',
        ([v, s, e], ctx) => asList(ctx, v).slice(asNumber(ctx, s), isNil(e) ? undefined : asNumber(ctx, e)),
        2,
        3
    ),
    concat: define('concat(list, ...lists)', 'Concatenate lists.', ([v, ...rest], ctx) => asList(ctx, v).concat(...rest.map((r) => asList(ctx, r))), 1),
    reverse: define('reverse(list)', 'Reverse a list (copy).', ([v], ctx) => [...asList(ctx, v)].reverse(), 1, 1),
    unique: define(
        'unique(list)',
        'Remove deep-equal duplicates, keeping first occurrences.',
        ([v], ctx) => {
            const out: unknown[] = [];
            for (const x of asList(ctx, v)) if (!out.some((y) => deepEqual(x, y))) out.push(x);
            return out;
        },
        1,
        1
    ),
    flatten: define('flatten(list)', 'Flatten one level.', ([v], ctx) => asList(ctx, v).flatMap((x) => (Array.isArray(x) ? x : [x])), 1, 1),
    compact: define('compact(list)', 'Drop null, undefined and "" items.', ([v], ctx) => asList(ctx, v).filter((x) => !isNil(x) && x !== ''), 1, 1),
    range: define(
        'range(start, end)',
        'Integers from start (inclusive) to end (exclusive). At most 10 000.',
        ([s, e], ctx) => {
            const start = asNumber(ctx, s);
            const end = asNumber(ctx, e);
            if (end - start > 10_000) ctx.fail('range is limited to 10 000 items');
            const out: number[] = [];
            for (let i = start; i < end; i++) out.push(i);
            return out;
        },
        2,
        2
    ),
    sum: define('sum(list)', 'Sum of numbers.', ([v], ctx) => asList(ctx, v).reduce<number>((n, x) => n + asNumber(ctx, x), 0), 1, 1),
    min: define('min(list)', 'Smallest number, or undefined when empty.', ([v], ctx) => { const l = asList(ctx, v).map((x) => asNumber(ctx, x)); return l.length ? Math.min(...l) : undefined; }, 1, 1),
    max: define('max(list)', 'Largest number, or undefined when empty.', ([v], ctx) => { const l = asList(ctx, v).map((x) => asNumber(ctx, x)); return l.length ? Math.max(...l) : undefined; }, 1, 1),

    // ── objects ─────────────────────────────────────────────────────────
    keys: define('keys(object)', 'Own keys.', ([v]) => (isPlainObject(v) ? Object.keys(v) : []), 1, 1),
    values: define('values(object)', 'Own values.', ([v]) => (isPlainObject(v) ? Object.values(v) : []), 1, 1),
    entries: define('entries(object)', 'List of {key, value}.', ([v]) => (isPlainObject(v) ? Object.entries(v).map(([key, value]) => ({ key, value })) : []), 1, 1),
    fromEntries: define(
        'fromEntries(list)',
        'Object from a list of {key, value} or [key, value].',
        ([v], ctx) => {
            const out: Record<string, unknown> = {};
            for (const e of asList(ctx, v)) {
                const [k, val] = Array.isArray(e) ? [e[0], e[1]] : [getMember(e, 'key'), getMember(e, 'value')];
                const key = asString(k);
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') ctx.fail(`"${key}" cannot be an object key`);
                out[key] = val;
            }
            return out;
        },
        1,
        1
    ),
    merge: define(
        'merge(...objects)',
        'Shallow merge, later keys win. Null arguments are skipped.',
        ([...objs], ctx) => {
            const out: Record<string, unknown> = {};
            for (const o of objs) {
                if (isNil(o)) continue;
                if (!isPlainObject(o)) return ctx.fail(`expected objects, got ${describeType(o)}`);
                for (const k of Object.keys(o)) if (k !== '__proto__') out[k] = o[k];
            }
            return out;
        },
        1
    ),
    pick: define(
        'pick(object, ...keys)',
        'Keep only the given keys (as arguments or one list).',
        ([o, ...keys]) => {
            const wanted = (keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys).map(asString);
            const out: Record<string, unknown> = {};
            if (!isPlainObject(o)) return out;
            for (const k of wanted) if (Object.hasOwn(o, k)) out[k] = o[k];
            return out;
        },
        1
    ),
    omit: define(
        'omit(object, ...keys)',
        'Drop the given keys (as arguments or one list).',
        ([o, ...keys]) => {
            const dropped = new Set((keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys).map(asString));
            const out: Record<string, unknown> = {};
            if (!isPlainObject(o)) return out;
            for (const k of Object.keys(o)) if (!dropped.has(k)) out[k] = o[k];
            return out;
        },
        1
    ),
    get: define(
        'get(value, path, fallback?)',
        'Read a dotted path; fallback when missing.',
        ([v, path, fallback]) => {
            let target: unknown = v;
            for (const part of asString(path).split('.')) target = getMember(target, part);
            return target === undefined ? fallback : target;
        },
        2,
        3
    ),
    compactObject: define(
        'compactObject(object)',
        'Drop keys whose value is null, undefined or "".',
        ([v]) => {
            const out: Record<string, unknown> = {};
            if (!isPlainObject(v)) return out;
            for (const k of Object.keys(v)) if (!isNil(v[k]) && v[k] !== '') out[k] = v[k];
            return out;
        },
        1,
        1
    ),

    // ── numbers ─────────────────────────────────────────────────────────
    round: define(
        'round(number, digits?)',
        'Round half away from zero.',
        ([v, d], ctx) => {
            const f = 10 ** (isNil(d) ? 0 : asNumber(ctx, d));
            const n = asNumber(ctx, v);
            return (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
        },
        1,
        2
    ),
    floor: define('floor(number)', 'Round down.', ([v], ctx) => Math.floor(asNumber(ctx, v)), 1, 1),
    ceil: define('ceil(number)', 'Round up.', ([v], ctx) => Math.ceil(asNumber(ctx, v)), 1, 1),
    abs: define('abs(number)', 'Absolute value.', ([v], ctx) => Math.abs(asNumber(ctx, v)), 1, 1),

    // ── dates ───────────────────────────────────────────────────────────
    now: define('now()', 'The current time as an ISO-8601 string.', (_, ctx) => new Date(ctx.now()).toISOString(), 0, 0),
    date: define('date(value)', 'Normalize a date (ISO text, epoch seconds or millis) to ISO-8601.', ([v], ctx) => (isNil(v) ? v : toDate(ctx, v).toISOString()), 1, 1),
    addTime: define(
        'addTime(date, amount, unit)',
        'Shift a date; unit is ms, s, m, h, d or w (or the spelled-out names).',
        ([v, amount, unit], ctx) => {
            const ms = UNIT_MS[asString(unit)];
            if (ms === undefined) ctx.fail(`unknown unit "${asString(unit)}"`);
            return new Date(toDate(ctx, v).getTime() + asNumber(ctx, amount) * ms!).toISOString();
        },
        3,
        3
    ),
    formatDate: define(
        'formatDate(date, format)',
        'Format as "iso", "date" (YYYY-MM-DD), "unix" (seconds) or "unixMs".',
        ([v, format], ctx) => {
            if (isNil(v)) return v;
            const d = toDate(ctx, v);
            switch (format ?? 'iso') {
                case 'iso':
                    return d.toISOString();
                case 'date':
                    return d.toISOString().slice(0, 10);
                case 'unix':
                    return Math.floor(d.getTime() / 1000);
                case 'unixMs':
                    return d.getTime();
                default:
                    return ctx.fail(`unknown format "${asString(format)}" (iso, date, unix, unixMs)`);
            }
        },
        1,
        2
    ),
    unix: define('unix(date?)', 'Epoch seconds of a date (default: now).', ([v], ctx) => Math.floor((isNil(v) ? ctx.now() : toDate(ctx, v).getTime()) / 1000), 0, 1),

    // ── messages & trees ────────────────────────────────────────────────
    mime: define(
        'mime(message)',
        'An RFC 5322 email: {from, to, cc, bcc, replyTo, subject, text, html, attachments: [{filename, contentType, base64}], inReplyTo, references, messageId, date, headers}.',
        ([v], ctx) => {
            if (!isPlainObject(v)) return ctx.fail('expects a message object');
            return buildMime(v as MimeMessage);
        },
        1,
        1
    ),
    flattenTree: define(
        'flattenTree(tree, childrenKey?)',
        'Every node of a tree, depth first, root included (default childrenKey "parts").',
        ([v, key]) => flattenTree(v, isNil(key) ? 'parts' : asString(key)),
        1,
        2
    ),

    // ── crypto ──────────────────────────────────────────────────────────
    uuid: define('uuid()', 'A random v4 UUID.', () => crypto.randomUUID(), 0, 0),
    sha256: define('sha256(text, encoding?)', 'SHA-256 digest; encoding hex (default), base64 or base64url.', async ([v, enc], ctx) => encodeBytes(ctx, await digest('SHA-256', asString(v)), enc), 1, 2),
    hash: define(
        'hash(text, algorithm, encoding?)',
        'Digest with sha1, sha256, sha384 or sha512.',
        async ([v, alg, enc], ctx) => {
            const algorithm = DIGESTS[asString(alg).toLowerCase().replace('-', '')];
            if (!algorithm) ctx.fail(`unknown algorithm "${asString(alg)}"`);
            return encodeBytes(ctx, await digest(algorithm!, asString(v)), enc);
        },
        2,
        3
    ),
    hmac: define(
        'hmac(text, key, algorithm?, encoding?)',
        'HMAC signature; algorithm sha256 (default), sha1, sha384 or sha512.',
        async ([v, key, alg, enc], ctx) => {
            const algorithm = DIGESTS[asString(alg ?? 'sha256').toLowerCase().replace('-', '')];
            if (!algorithm) ctx.fail(`unknown algorithm "${asString(alg)}"`);
            return encodeBytes(ctx, await hmac(algorithm!, asString(key), asString(v)), enc);
        },
        2,
        4
    ),
    signJwt: define(
        'signJwt(claims, key, algorithm?, header?)',
        'Sign a compact JWT. HS* take a shared secret, RS*/ES* a PEM private key. Default RS256.',
        async ([claims, key, alg, header], ctx) => {
            if (!isPlainObject(claims)) ctx.fail('claims must be an object');
            const algorithm = (isNil(alg) ? 'RS256' : asString(alg)) as JwtAlgorithm;
            if (!JWT_ALGORITHMS.includes(algorithm)) ctx.fail(`unsupported algorithm "${algorithm}"`);
            if (!isNil(header) && !isPlainObject(header)) ctx.fail('header must be an object');
            return signJwt(claims as Record<string, unknown>, asString(key), algorithm, (header ?? {}) as Record<string, unknown>);
        },
        2,
        4
    )
};

/** Build a registry: the standard library plus (and possibly overriding) `extra`. */
export function createFunctionRegistry(...extra: (Record<string, ExprFunction> | FunctionRegistry | undefined)[]): Map<string, ExprFunction> {
    const registry = new Map<string, ExprFunction>(Object.entries(STANDARD_FUNCTIONS));
    for (const set of extra) {
        if (!set) continue;
        const entries = set instanceof Map ? set.entries() : Object.entries(set);
        for (const [name, fn] of entries) {
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error(`invalid function name "${name}"`);
            registry.set(name, fn);
        }
    }
    return registry;
}

export const standardRegistry: FunctionRegistry = createFunctionRegistry();
