/**
 * `mockProvider()` — a real local HTTP server playing an OAuth 2.0
 * authorization server plus the (fictional) Acme CRM and Weather APIs used by
 * the fixture connectors. Tests drive Conduit against it end to end, over
 * real sockets.
 *
 * Alias-only inside this workspace (never published).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: string;
}

interface Failure {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    times: number;
}

export interface MockProviderOptions {
    clientId?: string;
    clientSecret?: string;
    /** Lifetime of issued access tokens, in seconds. Default 3600. */
    expiresIn?: number;
    /** Whether refreshes rotate the refresh token. Default true. */
    rotateRefreshTokens?: boolean;
    /** Artificial latency for the token endpoint, ms. */
    tokenDelayMs?: number;
}

export interface Contact {
    id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    owner_id?: string;
    tags?: string[];
    created_at: string;
}

export interface MockProvider {
    readonly url: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly requests: RecordedRequest[];
    /** Per grant type, how many token requests succeeded. */
    readonly grants: Record<string, number>;
    readonly contacts: Contact[];
    /** Accepted API keys (for the `key` auth method). */
    readonly apiKeys: Set<string>;
    /** Fail the next `times` requests whose path starts with `pathPrefix`. */
    failNext(pathPrefix: string, failure: Omit<Failure, 'times'> & { times?: number }): void;
    /** Invalidate every issued access token (refresh tokens stay valid). */
    expireAccessTokens(): void;
    /** Invalidate every refresh token too. */
    revokeAll(): void;
    setExpiresIn(seconds: number): void;
    /** Simulate the owner approving the consent screen: follow `authorizeUrl` and return the callback URL. */
    approve(authorizeUrl: string): Promise<string>;
    /** Sign a webhook body the way Acme does. */
    sign(body: string, secret: string): string;
    close(): Promise<void>;
}

const OWNERS = [
    { id: 'u1', name: 'Grace' },
    { id: 'u2', name: 'Linus' }
];

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    const isText = typeof body === 'string';
    res.writeHead(status, { 'content-type': isText ? 'text/plain' : 'application/json', ...headers });
    res.end(body === undefined ? '' : isText ? body : JSON.stringify(body));
}

export async function mockProvider(options: MockProviderOptions = {}): Promise<MockProvider> {
    const clientId = options.clientId ?? 'client-123';
    const clientSecret = options.clientSecret ?? 'secret-456';
    let expiresIn = options.expiresIn ?? 3600;
    const requests: RecordedRequest[] = [];
    const grants: Record<string, number> = {};
    const failures: { prefix: string; failure: Failure }[] = [];
    const codes = new Map<string, { redirectUri: string; challenge?: string; method?: string; scope: string }>();
    let access = new Map<string, { scope: string; user: string }>();
    let refresh = new Map<string, { scope: string; user: string }>();
    const contacts: Contact[] = Array.from({ length: 5 }, (_, i) => ({
        id: `c${i + 1}`,
        email: `Person${i + 1}@Example.com`,
        first_name: `First${i + 1}`,
        last_name: `Last${i + 1}`,
        owner_id: i % 2 ? 'u2' : 'u1',
        created_at: `2026-0${(i % 9) + 1}-01T00:00:00Z`
    }));
    const apiKeys = new Set<string>(['key-abcdefgh']);
    const hooks = new Map<string, { url: string; secret: string }>();
    const token = () => randomBytes(18).toString('base64url');

    const issue = (scope: string, user: string, withRefresh: boolean) => {
        const accessToken = `at_${token()}`;
        access.set(accessToken, { scope, user });
        const body: Record<string, unknown> = { access_token: accessToken, token_type: 'bearer', expires_in: expiresIn, scope };
        if (withRefresh) {
            const refreshToken = `rt_${token()}`;
            refresh.set(refreshToken, { scope, user });
            body.refresh_token = refreshToken;
        }
        return body;
    };

    const clientOk = (req: IncomingMessage, form: URLSearchParams) => {
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        if (basic) {
            const [id, secret] = Buffer.from(basic[1]!, 'base64').toString().split(':').map(decodeURIComponent);
            return id === clientId && secret === clientSecret;
        }
        return form.get('client_id') === clientId && form.get('client_secret') === clientSecret;
    };

    const authenticate = (req: IncomingMessage): { user: string } | undefined => {
        const header = req.headers.authorization ?? '';
        const bearer = /^Bearer (.+)$/.exec(header);
        if (bearer && access.has(bearer[1]!)) return access.get(bearer[1]!);
        const key = /^Token (.+)$/.exec(header);
        if (key && apiKeys.has(key[1]!)) return { user: 'key-user' };
        return undefined;
    };

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const body = await readBody(req);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        requests.push({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });

        const failureIndex = failures.findIndex((f) => url.pathname.startsWith(f.prefix));
        if (failureIndex !== -1) {
            const { failure } = failures[failureIndex]!;
            if (--failure.times <= 0) failures.splice(failureIndex, 1);
            return send(res, failure.status, failure.body ?? { error: 'injected' }, failure.headers);
        }

        const path = url.pathname;
        try {
            // ── OAuth ─────────────────────────────────────────────────
            if (path === '/oauth/authorize' && req.method === 'GET') {
                const q = url.searchParams;
                if (q.get('client_id') !== clientId) return send(res, 400, { error: 'invalid_client' });
                const code = `code_${token()}`;
                codes.set(code, {
                    redirectUri: q.get('redirect_uri') ?? '',
                    challenge: q.get('code_challenge') ?? undefined,
                    method: q.get('code_challenge_method') ?? undefined,
                    scope: q.get('scope') ?? ''
                });
                const target = new URL(q.get('redirect_uri')!);
                target.searchParams.set('code', code);
                target.searchParams.set('state', q.get('state') ?? '');
                return send(res, 302, '', { location: target.toString() });
            }
            if (path === '/oauth/token' && req.method === 'POST') {
                if (options.tokenDelayMs) await new Promise((r) => setTimeout(r, options.tokenDelayMs));
                const form = new URLSearchParams(body);
                if (!clientOk(req, form)) return send(res, 401, { error: 'invalid_client' });
                const grant = form.get('grant_type');
                if (grant === 'authorization_code') {
                    const entry = codes.get(form.get('code') ?? '');
                    codes.delete(form.get('code') ?? '');
                    if (!entry || entry.redirectUri !== form.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
                    if (entry.challenge) {
                        const verifier = form.get('code_verifier') ?? '';
                        const computed = createHash('sha256').update(verifier).digest('base64url');
                        if (computed !== entry.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
                    }
                    grants[grant] = (grants[grant] ?? 0) + 1;
                    return send(res, 200, issue(entry.scope, 'u-oauth', true));
                }
                if (grant === 'refresh_token') {
                    const old = form.get('refresh_token') ?? '';
                    const entry = refresh.get(old);
                    if (!entry) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token is invalid' });
                    const rotate = options.rotateRefreshTokens ?? true;
                    if (rotate) refresh.delete(old);
                    grants[grant] = (grants[grant] ?? 0) + 1;
                    const issued = issue(entry.scope, entry.user, rotate);
                    return send(res, 200, issued);
                }
                if (grant === 'client_credentials') {
                    grants[grant] = (grants[grant] ?? 0) + 1;
                    return send(res, 200, issue(form.get('scope') ?? '', 'u-app', false));
                }
                return send(res, 400, { error: 'unsupported_grant_type' });
            }
            if (path === '/oauth/revoke' && req.method === 'POST') {
                const form = new URLSearchParams(body);
                refresh.delete(form.get('token') ?? '');
                access.delete(form.get('token') ?? '');
                grants.revoke = (grants.revoke ?? 0) + 1;
                return send(res, 200);
            }

            // ── Weather (query-string key) ────────────────────────────
            if (path === '/weather/status') return send(res, 200, '  all good \n');
            if (path === '/weather/forecast') {
                if (url.searchParams.get('appid') !== 'wx-key-123456') return send(res, 401, { message: 'bad key' });
                const count = Number(url.searchParams.get('cnt') ?? 1);
                return send(res, 200, {
                    list: Array.from({ length: count }, (_, i) => ({ dt: 1767225600 + i * 86400, temp: 20.04 + i }))
                });
            }

            // ── Acme CRM ──────────────────────────────────────────────
            if (!path.startsWith('/v2/')) return send(res, 404, { error: 'not found' });
            const who = authenticate(req);
            if (!who) return send(res, 401, { error: 'unauthorized' });
            const route = path.slice(3);

            if (route === '/me') return send(res, 200, { id: who.user, email: `${who.user}@acme.example`, region: 'eu' });
            if (route === '/owners') return send(res, 200, { owners: OWNERS });
            const ownerMatch = /^\/owners\/(.+)$/.exec(route);
            if (ownerMatch) {
                const owner = OWNERS.find((o) => o.id === ownerMatch[1]);
                return owner ? send(res, 200, owner) : send(res, 404, { error: 'no owner' });
            }
            if (route === '/contacts' && req.method === 'GET') {
                const q = (url.searchParams.get('q') ?? '').toLowerCase();
                const matching = contacts.filter((c) => !q || c.email.toLowerCase().includes(q));
                const limit = Number(url.searchParams.get('limit') ?? 100);
                const start = Number(url.searchParams.get('cursor') ?? 0);
                const page = matching.slice(start, start + limit);
                const next = start + limit < matching.length ? String(start + limit) : null;
                return send(res, 200, { data: page, meta: { next_cursor: next } });
            }
            if (route === '/contacts' && req.method === 'POST') {
                const input = JSON.parse(body || '{}') as Partial<Contact>;
                if (!input.email) return send(res, 422, { message: 'email is required' });
                if (contacts.some((c) => c.email.toLowerCase() === input.email!.toLowerCase())) return send(res, 409, { message: 'duplicate' });
                if (input.email.endsWith('@soft-fail.example')) return send(res, 200, { ok: false, error: 'mailbox rejected' });
                const contact: Contact = { ...input, id: `c${contacts.length + 1}`, email: input.email, created_at: '2026-09-01T00:00:00Z' };
                contacts.push(contact);
                return send(res, 201, contact);
            }
            const contactMatch = /^\/contacts\/(.+)$/.exec(route);
            if (contactMatch) {
                const contact = contacts.find((c) => c.id === decodeURIComponent(contactMatch[1]!));
                return contact ? send(res, 200, contact) : send(res, 404, { message: 'no such contact' });
            }
            if (route === '/webhooks' && req.method === 'POST') {
                const input = JSON.parse(body || '{}') as { url: string; secret: string };
                const id = `wh_${token()}`;
                hooks.set(id, { url: input.url, secret: input.secret });
                return send(res, 201, { id });
            }
            const hookMatch = /^\/webhooks\/(.+)$/.exec(route);
            if (hookMatch && req.method === 'DELETE') return send(res, hooks.delete(hookMatch[1]!) ? 204 : 404);
            return send(res, 404, { error: 'not found' });
        } catch (e) {
            return send(res, 500, { error: String(e) });
        }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    return {
        url: base,
        clientId,
        clientSecret,
        requests,
        grants,
        contacts,
        apiKeys,
        failNext(prefix, failure) {
            failures.push({ prefix, failure: { ...failure, times: failure.times ?? 1 } });
        },
        expireAccessTokens() {
            access = new Map();
        },
        revokeAll() {
            access = new Map();
            refresh = new Map();
        },
        setExpiresIn(seconds) {
            expiresIn = seconds;
        },
        async approve(authorizeUrl) {
            const res = await fetch(authorizeUrl, { redirect: 'manual' });
            const location = res.headers.get('location');
            if (res.status !== 302 || !location) throw new Error(`authorize did not redirect (status ${res.status}): ${await res.text()}`);
            return location;
        },
        sign(payload, secret) {
            return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
        },
        close() {
            return new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            });
        }
    };
}
