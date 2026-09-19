import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HostGuard } from '@sigx/conduit';
import { buildUrl, callbackParams, createPkce, openState, parseTokenResponse, sealState } from '@sigx/conduit/oauth';
import { Masker } from '../../src/http/perform';
import { BUILTIN_ENCODERS, joinUrl, renderRequest } from '../../src/http/request';
import { nextLink, retryAfterMs } from '../../src/http/response';
import { standardRegistry } from '@sigx/conduit/expr';

describe('oauth helpers', () => {
    it('creates S256 PKCE pairs', async () => {
        const { verifier, challenge, method } = await createPkce();
        expect(method).toBe('S256');
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    });

    it('seals and opens state, rejecting tampering and expiry', async () => {
        const key = 'k'.repeat(40);
        const state = await sealState({ o: 'owner' }, key, { ttlMs: 1000, now: 0 });
        expect(await openState(state, key, { now: 999 })).toMatchObject({ o: 'owner', exp: 1000 });
        await expect(openState(state, key, { now: 1000 })).rejects.toThrow(/expired/);
        await expect(openState(state, 'x'.repeat(40), { now: 0 })).rejects.toThrow(/signature/);
        await expect(openState('garbage', key)).rejects.toThrow(/malformed/);
    });

    it('parses JSON and form-encoded token responses', () => {
        expect(parseTokenResponse({ access_token: 'a' })).toEqual({ access_token: 'a' });
        expect(parseTokenResponse('{"access_token":"b"}')).toEqual({ access_token: 'b' });
        expect(parseTokenResponse('access_token=c&expires_in=5', 'application/x-www-form-urlencoded')).toEqual({ access_token: 'c', expires_in: '5' });
        expect(parseTokenResponse('<html>')).toEqual({});
    });

    it('reads callback parameters from the query and the fragment', () => {
        expect(callbackParams('https://app.example/cb?code=1&state=s#extra=2')).toEqual({ code: '1', state: 's', extra: '2' });
        expect(buildUrl('https://a.example/x?keep=1', { a: 'b c', skip: undefined })).toBe('https://a.example/x?keep=1&a=b+c');
    });
});

describe('http helpers', () => {
    it('joins URLs and refuses foreign schemes', () => {
        expect(joinUrl('https://a.example/v2/', '/users')).toBe('https://a.example/v2/users');
        expect(joinUrl('https://a.example/v2', 'users')).toBe('https://a.example/v2/users');
        expect(joinUrl('https://a.example', 'https://b.example/x')).toBe('https://b.example/x');
        expect(() => joinUrl('https://a.example', 'javascript:alert(1)')).toThrow(/unsupported URL scheme/);
        expect(() => joinUrl(undefined, '/x')).toThrow(/no baseUrl/);
    });

    it('renders query arrays, drops empty values and lets auth win', async () => {
        const prepared = await renderRequest({
            spec: {
                url: '/search',
                query: { tag: ['a', 'b'], empty: '{{inputs.none}}', q: '{{inputs.q}}', obj: { x: 1 } },
                headers: { 'X-Blank': '', Authorization: 'spoofed' }
            },
            http: { baseUrl: 'https://a.example', query: { q: 'default' }, headers: { 'X-Base': '1' } },
            scope: { inputs: { q: 'hi' } },
            eval: { functions: standardRegistry },
            auth: { headers: { Authorization: 'Bearer real' }, query: {} }
        });
        expect(prepared.url.origin + prepared.url.pathname).toBe('https://a.example/search');
        expect([...prepared.url.searchParams].sort()).toEqual([['obj', '{"x":1}'], ['q', 'hi'], ['tag', 'a'], ['tag', 'b']]);
        expect(Object.fromEntries(prepared.headers)).toEqual({ authorization: 'Bearer real', 'x-base': '1' });
        expect(prepared.body).toBeUndefined();
    });

    it('encodes bodies', async () => {
        const h = new Headers();
        expect(BUILTIN_ENCODERS.form({ a: 1, b: ['x', 'y'], c: undefined }, h)).toBe('a=1&b=x&b=y');
        expect(h.get('content-type')).toBe('application/x-www-form-urlencoded');
        const form = BUILTIN_ENCODERS.multipart({ note: 'hi', file: { filename: 'a.txt', contentType: 'text/plain', content: 'abc' } }, new Headers()) as FormData;
        expect(form.get('note')).toBe('hi');
        const file = form.get('file') as File;
        expect([file.name, file.type, await file.text()]).toEqual(['a.txt', 'text/plain', 'abc']);
        expect(BUILTIN_ENCODERS.binary('AQID', new Headers())).toEqual(new Uint8Array([1, 2, 3]));
        expect(() => BUILTIN_ENCODERS.form('nope', new Headers())).toThrow(/must be an object/);
    });

    it('reads Link and Retry-After headers', () => {
        expect(nextLink({ link: '<https://a.example/p?page=2>; rel="next", <https://a.example/p?page=9>; rel="last"' })).toBe('https://a.example/p?page=2');
        expect(nextLink({ link: '<https://a.example/p?page=1>; rel="prev"' })).toBeUndefined();
        expect(retryAfterMs({ 'retry-after': '3' }, 0)).toBe(3000);
        expect(retryAfterMs({ 'retry-after': new Date(10_000).toUTCString() }, 4_000)).toBe(6000);
        expect(retryAfterMs({}, 0)).toBeUndefined();
    });

    it('guards hosts by exact name, wildcard and port', () => {
        const guard = new HostGuard(['api.example.com', '*.cdn.example', 'https://auth.example:8443/x']);
        expect(guard.allows(new URL('https://api.example.com/x'))).toBe(true);
        expect(guard.allows(new URL('https://img.cdn.example/x'))).toBe(true);
        expect(guard.allows(new URL('https://cdn.example/x'))).toBe(false);
        expect(guard.allows(new URL('https://auth.example:8443/t'))).toBe(true);
        expect(guard.allows(new URL('https://evil.example/api.example.com'))).toBe(false);
        expect(guard.allows(new URL('ftp://api.example.com/'))).toBe(false);
        expect(new HostGuard(['*']).allows(new URL('https://anything.example'))).toBe(true);
    });

    it('masks secret params and values', () => {
        const mask = new Masker().addParam('appid').addValue('super-secret-token');
        expect(mask.url(new URL('https://a.example/x?appid=123&q=super-secret-token&access_token=zzz'))).toBe(
            'https://a.example/x?appid=***&q=***&access_token=***'
        );
        expect(mask.text('failed with super-secret-token')).toBe('failed with ***');
    });
});
