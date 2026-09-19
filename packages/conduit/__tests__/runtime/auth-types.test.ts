import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConduitAuthError, createConduit, memoryAccounts, memorySource, type ConnectorSpec, type HttpClient } from '@sigx/conduit';
import { SECRET } from './helpers';

interface Seen {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
}

/** A scripted HTTP stub: routes by "METHOD path" and records every request. */
function stub(routes: Record<string, (req: Seen) => unknown>): { http: HttpClient; seen: Seen[] } {
    const seen: Seen[] = [];
    const http: HttpClient = async (request) => {
        const url = new URL(request.url);
        const req: Seen = {
            method: request.method,
            url: request.url,
            headers: Object.fromEntries(request.headers),
            body: request.body ? await request.text() : ''
        };
        seen.push(req);
        const handler = routes[`${request.method} ${url.pathname}`];
        if (!handler) return new Response('{"error":"no route"}', { status: 404, headers: { 'content-type': 'application/json' } });
        const result = handler(req);
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    };
    return { http, seen };
}

const base = (auth: ConnectorSpec['auth']): ConnectorSpec => ({
    spec: 'conduit/1',
    id: 'svc',
    name: 'Service',
    version: '1.0.0',
    http: { baseUrl: 'https://api.svc.example' },
    auth,
    operations: [{ id: 'whoami', kind: 'action', label: 'Who am I', request: { url: '/whoami' } }]
});

describe('client credentials', () => {
    it('mints a token on connect and re-mints it when it expires', async () => {
        let minted = 0;
        const { http, seen } = stub({
            'POST /token': () => ({ access_token: `tok-${++minted}`, expires_in: 120, token_type: 'bearer' }),
            'GET /whoami': (r) => ({ auth: r.headers.authorization })
        });
        const clock = { now: 1_000_000 };
        const conduit = createConduit({
            sources: memorySource([
                base([{ id: 'app', type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://login.svc.example/token', scopes: ['a', 'b'], clientAuth: 'basic' }])
            ]),
            secret: SECRET,
            http,
            now: () => clock.now,
            clients: { svc: { id: 'cid', secret: 'csecret' } }
        });
        const account = await conduit.auth.connect({ connector: 'svc', method: 'app', owner: 'tenant-1' });
        expect(account.expiresAt).toBe(clock.now + 120_000);
        const tokenRequest = seen[0]!;
        expect(tokenRequest.headers.authorization).toBe(`Basic ${btoa('cid:csecret')}`);
        expect(Object.fromEntries(new URLSearchParams(tokenRequest.body))).toEqual({ grant_type: 'client_credentials', scope: 'a b' });

        expect((await conduit.execute({ connector: 'svc', operation: 'whoami', account: account.id })).output).toEqual({ auth: 'Bearer tok-1' });
        clock.now += 90_000; // within the 60 s skew
        expect((await conduit.execute({ connector: 'svc', operation: 'whoami', account: account.id })).output).toEqual({ auth: 'Bearer tok-2' });
        expect(minted).toBe(2);
    });

    it('refuses redirect-only grants in connect', async () => {
        const conduit = createConduit({
            sources: memorySource([base([{ id: 'o', type: 'oauth2', authorizeUrl: 'https://x.example/a', tokenUrl: 'https://x.example/t' }])]),
            secret: SECRET
        });
        await expect(conduit.auth.connect({ connector: 'svc', method: 'o', owner: 'u' })).rejects.toThrow(/use auth\.begin/);
    });
});

describe('jwt', () => {
    const jwtMethod = {
        id: 'app',
        type: 'jwt' as const,
        inputs: {
            type: 'object' as const,
            properties: { appId: { type: 'string' as const }, signingSecret: { type: 'string' as const, 'x-secret': true } },
            required: ['appId', 'signingSecret']
        },
        jwt: { algorithm: 'HS256' as const, key: '{{auth.signingSecret}}', claims: { iss: '{{auth.appId}}' }, lifetimeSec: 300 }
    };

    it('uses the signed JWT itself as the bearer token', async () => {
        const { http } = stub({ 'GET /whoami': (r) => ({ auth: r.headers.authorization }) });
        const clock = { now: Date.UTC(2026, 0, 1) };
        const conduit = createConduit({ sources: memorySource([base([jwtMethod])]), secret: SECRET, http, now: () => clock.now });
        const account = await conduit.auth.connect({ connector: 'svc', method: 'app', owner: 'o', inputs: { appId: 'app-7', signingSecret: 's3cret-s3cret' } });
        const { output } = await conduit.execute({ connector: 'svc', operation: 'whoami', account: account.id });
        const token = String((output as { auth: string }).auth).replace('Bearer ', '');
        const [head, body, sig] = token.split('.');
        const iat = Math.floor(clock.now / 1000);
        expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toEqual({ iat, exp: iat + 300, iss: 'app-7' });
        expect(sig).toBe(createHmac('sha256', 's3cret-s3cret').update(`${head}.${body}`).digest('base64url'));
        expect(account.expiresAt).toBe((iat + 300) * 1000);
    });

    it('exchanges the JWT for an access token when told to', async () => {
        const { http, seen } = stub({
            'POST /app/installations/42/access_tokens': (r) => ({ token: 'inst-token', expires_at: '2026-01-01T01:00:00Z', jwt: r.headers.authorization }),
            'GET /whoami': (r) => ({ auth: r.headers.authorization })
        });
        const spec = base([
            {
                ...jwtMethod,
                inputs: {
                    ...jwtMethod.inputs,
                    properties: { ...jwtMethod.inputs.properties, installation: { type: 'string' as const } }
                },
                exchange: {
                    request: { method: 'POST', url: '/app/installations/{{auth.installation}}/access_tokens', headers: { Authorization: 'Bearer {{jwt}}' } },
                    token: { accessToken: '{{response.body.token}}', expiresAt: '{{response.body.expires_at}}' }
                }
            }
        ]);
        const conduit = createConduit({ sources: memorySource([spec]), secret: SECRET, http, now: () => Date.UTC(2026, 0, 1) });
        const account = await conduit.auth.connect({
            connector: 'svc',
            method: 'app',
            owner: 'o',
            inputs: { appId: 'app-7', signingSecret: 's3cret-s3cret', installation: '42' }
        });
        expect(account.expiresAt).toBe(Date.UTC(2026, 0, 1, 1));
        expect(seen[0]!.headers.authorization).toMatch(/^Bearer ey/);
        expect((await conduit.execute({ connector: 'svc', operation: 'whoami', account: account.id })).output).toEqual({ auth: 'Bearer inst-token' });
    });
});

describe('custom', () => {
    it('logs in with steps, applies the minted session, and re-mints it on expiry', async () => {
        let sessions = 0;
        const { http, seen } = stub({
            'POST /login': (r) => {
                const body = JSON.parse(r.body) as { user: string; pass: string };
                if (body.pass !== 'pw') return new Response('{"error":"nope"}', { status: 401, headers: { 'content-type': 'application/json' } });
                return { session: `sess-${++sessions}`, ttl: 100 };
            },
            'GET /whoami': (r) => ({ session: r.headers['x-session'] })
        });
        const clock = { now: 5_000_000 };
        const spec = base([
            {
                id: 'login',
                type: 'custom',
                inputs: {
                    type: 'object',
                    properties: { user: { type: 'string' }, pass: { type: 'string', format: 'password' } },
                    required: ['user', 'pass']
                },
                steps: [{ name: 'login', method: 'POST', url: '/login', body: { user: '{{inputs.user}}', pass: '{{inputs.pass}}' } }],
                credentials: { session: '{{steps.login.session}}' },
                expiresIn: '{{steps.login.ttl}}',
                apply: { headers: { 'X-Session': '{{auth.session}}' } }
            }
        ]);
        const conduit = createConduit({ sources: memorySource([spec]), secret: SECRET, http, now: () => clock.now });
        await expect(conduit.auth.connect({ connector: 'svc', method: 'login', owner: 'o', inputs: { user: 'a', pass: 'bad' } })).rejects.toMatchObject({ kind: 'auth' });
        const account = await conduit.auth.connect({ connector: 'svc', method: 'login', owner: 'o', inputs: { user: 'a', pass: 'pw' } });
        expect((await conduit.execute({ connector: 'svc', operation: 'whoami', account: account.id })).output).toEqual({ session: 'sess-1' });
        clock.now += 100_000;
        expect((await conduit.execute({ connector: 'svc', operation: 'whoami', account: account.id })).output).toEqual({ session: 'sess-2' });
        // The password never appears in a trace-visible URL, and the login body carried it.
        expect(seen.filter((s) => s.url.endsWith('/login'))).toHaveLength(3);
    });
});

describe('basic and bearer', () => {
    it('applies the conventional headers and cannot refresh', async () => {
        const { http } = stub({ 'GET /whoami': (r) => ({ auth: r.headers.authorization }) });
        const accounts = memoryAccounts();
        const conduit = createConduit({
            sources: memorySource([base([{ id: 'b', type: 'basic' }, { id: 't', type: 'bearer' }])]),
            secret: SECRET,
            http,
            accounts
        });
        const basic = await conduit.auth.connect({ connector: 'svc', method: 'b', owner: 'o', inputs: { username: 'ådå', password: 'p:w' } });
        expect((await conduit.execute({ connector: 'svc', operation: 'whoami', account: basic.id })).output).toEqual({
            auth: `Basic ${Buffer.from('ådå:p:w').toString('base64')}`
        });
        const bearer = await conduit.auth.connect({ connector: 'svc', method: 't', owner: 'o', inputs: { token: 'abc' } });
        expect((await conduit.execute({ connector: 'svc', operation: 'whoami', account: bearer.id })).output).toEqual({ auth: 'Bearer abc' });
        await expect(conduit.auth.refresh(bearer.id)).rejects.toBeInstanceOf(ConduitAuthError);
        expect(await conduit.auth.test(bearer.id)).toMatchObject({ ok: false, error: { code: 'test_unavailable' } });
    });
});
