import { describe, expect, it } from 'vitest';
import { createConduit, definePlugin, memorySource, type ConnectorSpec } from '@sigx/conduit';
import { createFetchHandler, safeReturnPath } from '@sigx/conduit/server';

const SECRET = 'handler-test-secret-that-is-long-enough';

const spec: ConnectorSpec = {
    spec: 'conduit/1',
    id: 'svc',
    name: 'Svc',
    version: '1.0.0',
    http: { baseUrl: 'https://api.svc.example', retry: { attempts: 1 } },
    auth: [
        { id: 'o', type: 'oauth2', authorizeUrl: 'https://login.svc.example/authorize', tokenUrl: 'https://login.svc.example/token' },
        { id: 't', type: 'bearer' }
    ],
    operations: [{ id: 'ping', kind: 'action', label: 'Ping', request: { url: '/ping' } }]
};

const setup = (http: (r: Request) => Promise<Response> = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) => {
    const plugin = definePlugin({
        name: 'status',
        setup: (r) => r.route({ method: 'GET', path: '/status/:what', handle: (_req, ctx) => Response.json({ what: ctx.params.what, owner: ctx.owner ?? null }) })
    });
    const conduit = createConduit({
        sources: memorySource([spec]),
        secret: SECRET,
        http,
        plugins: [plugin],
        redirectUri: 'https://app.example/conduit/auth/callback',
        clients: { svc: { id: 'cid', secret: 'cs' } }
    });
    return { conduit, handler: (options: Partial<Parameters<typeof createFetchHandler>[1]> = {}) => createFetchHandler(conduit, { resolveOwner: (r) => r.headers.get('x-user') ?? undefined, exposeExecute: true, ...options }) };
};

const post = (path: string, body: unknown, user = 'u1') =>
    new Request(`https://app.example${path}`, { method: 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('safeReturnPath', () => {
    it.each([
        ['/settings', '/settings'],
        ['/a?b=c#d', '/a?b=c#d'],
        ['//evil.example', undefined],
        ['/\\evil.example', undefined],
        ['https://evil.example', undefined],
        ['javascript:alert(1)', undefined],
        ['/ok\r\nSet-Cookie: x', undefined],
        [42, undefined]
    ])('%s → %s', (input, expected) => {
        expect(safeReturnPath(input)).toBe(expected);
    });
});

describe('createFetchHandler', () => {
    it('serves plugin routes, passing the owner through', async () => {
        const { handler } = setup();
        const res = await handler()(new Request('https://app.example/conduit/status/ready', { headers: { 'x-user': 'u9' } }));
        expect(await res.json()).toEqual({ what: 'ready', owner: 'u9' });
    });

    it('supports a custom base path and leaves other paths alone', async () => {
        const { handler } = setup();
        const h = handler({ basePath: '/api/integrations/' });
        expect((await h(new Request('https://app.example/api/integrations/connectors', { headers: { 'x-user': 'u' } }))).status).toBe(200);
        expect(await h.route(new Request('https://app.example/conduit/connectors'))).toBeUndefined();
        expect((await h(new Request('https://app.example/elsewhere'))).status).toBe(404);
    });

    it('redirects the callback to the fallback when there is no returnTo, with the result in the query', async () => {
        const { handler } = setup(async (r) =>
            r.url.endsWith('/token')
                ? Response.json({ access_token: 'at', expires_in: 3600 })
                : new Response('{}', { headers: { 'content-type': 'application/json' } })
        );
        const h = handler({ callbackFallback: '/integrations?tab=1' });
        const start = (await (await h(post('/conduit/auth/svc/o/start', {}))).json()) as { url: string };
        const state = new URL(start.url).searchParams.get('state')!;
        const res = await h(new Request(`https://app.example/conduit/auth/callback?code=abc&state=${encodeURIComponent(state)}`));
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toMatch(/^\/integrations\?tab=1&conduit_account=acc_/);

        const failed = await h(new Request('https://app.example/conduit/auth/callback?code=abc&state=bad.state'));
        expect(failed.headers.get('location')).toBe('/integrations?tab=1&conduit_error=auth_failed');
    });

    it('maps a rejected account to 409 needsReauth and rate limits to 429', async () => {
        let mode = 'unauthorized';
        const { conduit, handler } = setup(async () =>
            mode === 'unauthorized'
                ? new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
                : new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } })
        );
        const account = await conduit.auth.connect({ connector: 'svc', method: 't', owner: 'u1', inputs: { token: 'tok' } });
        const h = handler();
        const rejected = await h(post('/conduit/execute', { connector: 'svc', operation: 'ping', account: account.id }));
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: { code: 'auth_failed', needsReauth: true, account: account.id } });

        mode = 'limited';
        const limited = await h(post('/conduit/execute', { connector: 'svc', operation: 'ping', account: account.id }));
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('7');
    });

    it('refuses a plain start link for methods that connect without a redirect', async () => {
        const { handler } = setup();
        const res = await handler()(new Request('https://app.example/conduit/auth/svc/t/start', { headers: { 'x-user': 'u' } }));
        expect(res.status).toBe(400);
    });

    it('rejects malformed bodies', async () => {
        const { handler } = setup();
        const res = await handler()(
            new Request('https://app.example/conduit/accounts', { method: 'POST', headers: { 'x-user': 'u', 'content-type': 'application/json' }, body: '[1]' })
        );
        expect(res.status).toBe(400);
        const missing = await handler()(post('/conduit/accounts', { method: 't' }));
        expect(await missing.json()).toMatchObject({ error: { message: '"connector" is required' } });
    });
});
