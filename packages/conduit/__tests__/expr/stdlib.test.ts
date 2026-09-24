import { generateKeyPairSync, createVerify, verify as nodeVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STANDARD_FUNCTIONS, evaluateExpression, standardRegistry } from '@aigntiq/conduit/expr';

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const run = (source: string, scope: Record<string, unknown> = {}) =>
    evaluateExpression(source, scope, { functions: standardRegistry, now: () => NOW });

describe('standard library', () => {
    it.each([
        // values & types
        ['default(null, 1)', 1],
        ["default('', 1)", 1],
        ['default(0, 1)', 0],
        ['ifEmpty([], "x")', 'x'],
        ['ifEmpty({}, "x")', 'x'],
        ['ifEmpty([1], "x")', [1]],
        ['isEmpty("")', true],
        ['type([])', 'array'],
        ['type(null)', 'null'],
        ['string({a: 1})', '{"a":1}'],
        ["number('4.5')", 4.5],
        ["number('abc')", null],
        ["boolean('false')", false],
        ["boolean('yes')", true],
        ['json({a: [1]})', '{"a":[1]}'],
        ['parseJson(\'{"a":1}\')', { a: 1 }],
        ['equals({a: [1]}, {a: [1]})', true],
        // text
        ["upper('ab')", 'AB'],
        ["lower('AB')", 'ab'],
        ["trim('  x ')", 'x'],
        ["split('a,b')", ['a', 'b']],
        ["split('a b', ' ')", ['a', 'b']],
        ["split('', ',')", []],
        ["join(['a', 1, null], '|')", 'a|1|'],
        ["replace('a.b.c', '.', '/')", 'a/b/c'],
        ["startsWith('hello', 'he')", true],
        ["endsWith('hello', 'lo')", true],
        ["contains('hello', 'ell')", true],
        ['contains([{a: 1}], {a: 1})', true],
        ["contains({k: 1}, 'k')", true],
        ["substring('hello', 1, 3)", 'el'],
        ["padStart('7', 3, '0')", '007'],
        ["length('abc')", 3],
        ['length({a: 1, b: 2})', 2],
        ['length(null)', 0],
        ["urlEncode('a b&c')", 'a%20b%26c'],
        ["urlDecode('a%20b')", 'a b'],
        ["base64('héllo')", 'aMOpbGxv'],
        ["base64url('??>')", 'Pz8-'],
        ["fromBase64('aMOpbGxv')", 'héllo'],
        ["fromBase64('Pz8-')", '??>'],
        // lists
        ['first([1, 2])', 1],
        ['last([1, 2])', 2],
        ['first(null)', undefined],
        ['slice([1, 2, 3], 1)', [2, 3]],
        ['concat([1], [2], [3])', [1, 2, 3]],
        ['reverse([1, 2])', [2, 1]],
        ['unique([1, {a: 1}, 1, {a: 1}])', [1, { a: 1 }]],
        ['flatten([[1], 2, [3, [4]]])', [1, 2, 3, [4]]],
        ["compact([0, null, '', 'x'])", [0, 'x']],
        ['range(2, 5)', [2, 3, 4]],
        ['sum([1, 2, 3])', 6],
        ['min([3, 1, 2])', 1],
        ['max([3, 1, 2])', 3],
        ['max([])', undefined],
        ['some([1, 2], x => x > 1)', true],
        ['every([1, 2], x => x > 1)', false],
        ['flatMap([1, 2], x => [x, x])', [1, 1, 2, 2]],
        ["groupBy([{t: 'a'}, {t: 'b'}, {t: 'a'}], 't') | keys", ['a', 'b']],
        ["sortBy([{n: 2}, {n: null}, {n: 1}], 'n') | map('n')", [1, 2, null]],
        // objects
        ['keys({a: 1, b: 2})', ['a', 'b']],
        ['values({a: 1, b: 2})', [1, 2]],
        ['entries({a: 1})', [{ key: 'a', value: 1 }]],
        ["fromEntries([['a', 1], {key: 'b', value: 2}])", { a: 1, b: 2 }],
        ['merge({a: 1}, null, {b: 2, a: 3})', { a: 3, b: 2 }],
        ["pick({a: 1, b: 2, c: 3}, 'a', 'c')", { a: 1, c: 3 }],
        ["pick({a: 1, b: 2}, ['b'])", { b: 2 }],
        ["omit({a: 1, b: 2}, 'a')", { b: 2 }],
        ["get({a: {b: [5]}}, 'a.b.0')", 5],
        ["get({}, 'a.b', 'dflt')", 'dflt'],
        ["compactObject({a: null, b: '', c: 0})", { c: 0 }],
        // numbers
        ['round(2.345, 2)', 2.35],
        ['round(-2.5)', -3],
        ['floor(2.7)', 2],
        ['ceil(2.1)', 3],
        ['abs(-4)', 4],
        // dates
        ['now()', '2026-01-02T03:04:05.000Z'],
        ["date('2026-01-02T03:04:05Z')", '2026-01-02T03:04:05.000Z'],
        ["date('1767323045')", '2026-01-02T03:04:05.000Z'],
        ['date(1767323045000)', '2026-01-02T03:04:05.000Z'],
        ["addTime(now(), 1, 'h')", '2026-01-02T04:04:05.000Z'],
        ["addTime('2026-01-02T00:00:00Z', -2, 'days')", '2025-12-31T00:00:00.000Z'],
        ["formatDate(now(), 'date')", '2026-01-02'],
        ["formatDate(now(), 'unix')", 1767323045],
        ['unix()', 1767323045],
        // crypto
        ["sha256('abc')", 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ["hash('abc', 'sha1')", 'a9993e364706816aba3e25717850c26c9cd0d89d'],
        [
            "hmac('The quick brown fox jumps over the lazy dog', 'key')",
            'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
        ],
        ["hmac('msg', 'key', 'sha256', 'base64')", 'LZPLwb4We8sWN6SiPL/wGnh48MUO6DOVTqUiG7G4xig=']
    ])('%s → %j', async (source, expected) => {
        expect(await run(source)).toEqual(expected);
    });

    it('produces v4 UUIDs', async () => {
        expect(await run('uuid()')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it.each([
        ["addTime(now(), 1, 'fortnight')", /unknown unit/],
        ["date('not a date')", /as a date/],
        ["parseJson('{')", /not valid JSON/],
        ['join(5)', /expected a list/],
        ["hash('x', 'md5')", /unknown algorithm/],
        ["formatDate(now(), 'weird')", /unknown format/],
        ['range(0, 20000)', /limited/],
        ["fromEntries([['__proto__', 1]])", /cannot be an object key/]
    ])('%s fails with %s', async (source, message) => {
        await expect(run(source)).rejects.toThrow(message);
    });

    it('documents every function with a signature', () => {
        for (const [name, fn] of Object.entries(STANDARD_FUNCTIONS)) {
            expect(fn.signature, name).toMatch(new RegExp(`^${name}\\(`));
            expect(fn.description, name).toBeTruthy();
        }
    });
});

describe('signJwt', () => {
    it('matches the well-known HS256 vector', async () => {
        const token = await run("signJwt({sub: '1234567890', name: 'John Doe', iat: 1516239022}, 'your-256-bit-secret', 'HS256')");
        expect(token).toBe(
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
        );
    });

    it.each(['pkcs8', 'pkcs1'] as const)('signs RS256 with a %s PEM key that verifies', async (type) => {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pem = privateKey.export({ type, format: 'pem' }).toString();
        const token = String(await run("signJwt({iss: 'app-1'}, key, 'RS256', {kid: 'k1'})", { key: pem }));
        const [head, body, sig] = token.split('.');
        expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
        expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toEqual({ iss: 'app-1' });
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${head}.${body}`);
        expect(verifier.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    });

    it('signs ES256 in JWS (raw r||s) form', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const token = String(await run("signJwt({a: 1}, key, 'ES256')", { key: pem }));
        const [head, body, sig] = token.split('.');
        const raw = Buffer.from(sig!, 'base64url');
        expect(raw.length).toBe(64);
        const ok = nodeVerify(
            'sha256',
            Buffer.from(`${head}.${body}`),
            { key: publicKey, dsaEncoding: 'ieee-p1363' },
            raw
        );
        expect(ok).toBe(true);
    });

    it('accepts PEM keys with escaped newlines (as stored in env vars)', async () => {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n');
        await expect(run("signJwt({a: 1}, key)", { key: pem })).resolves.toMatch(/^ey/);
    });

    it('rejects unsupported algorithms and non-PEM keys', async () => {
        await expect(run("signJwt({}, 'k', 'none')")).rejects.toThrow(/unsupported algorithm/);
        await expect(run("signJwt({}, 'not-a-pem', 'RS256')")).rejects.toThrow(/PEM/);
    });
});

describe('bytes (binary response bodies)', () => {
    const bytes = new Uint8Array([0, 255, 1, 0xfe, 0x3f]);

    it('base64 and base64url encode the raw bytes, not their text', async () => {
        expect(await run('base64(b)', { b: bytes })).toBe(Buffer.from(bytes).toString('base64'));
        expect(await run('b | base64url', { b: bytes })).toBe(Buffer.from(bytes).toString('base64url'));
        expect(await run("base64(b) | fromBase64 | length", { b: new TextEncoder().encode('héllo') })).toBe(5);
    });

    it('length is the byte count', async () => {
        expect(await run('length(b)', { b: bytes })).toBe(5);
        expect(await run('length(b)', { b: new Uint8Array() })).toBe(0);
    });
});
