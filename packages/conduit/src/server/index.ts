/**
 * `@sigx/conduit/server` — Conduit's HTTP surface as a WinterCG handler:
 * `(Request) => Promise<Response>`. It runs as is on Hono, Bun, Deno,
 * Cloudflare Workers and Next.js route handlers; `@sigx/conduit/node`
 * bridges it to Express/Connect.
 *
 * The host owns identity: `resolveOwner(request)` is the only auth hook.
 * Every route except the OAuth callback requires an owner, and every
 * account operation is scoped to it.
 */
import { ConduitAuthError, ConduitError, ConduitRateLimitError, ConduitRequestError, ConduitSpecError, ConduitValidationError, isConduitError } from '../errors';
import type { Conduit } from '../runtime/conduit';
import type { ConduitRoute } from '../runtime/plugins';

export interface FetchHandlerOptions {
    /** Mount path. Default `/conduit`. */
    basePath?: string;
    /** Who is calling. Return undefined for "not signed in" (→ 401). */
    resolveOwner: (request: Request) => string | undefined | Promise<string | undefined>;
    /** Allow `POST {base}/execute`. Default false — most hosts call `conduit.execute` server-side. */
    exposeExecute?: boolean;
    /** Include the (masked) request trace in execute responses. Default false. */
    exposeTrace?: boolean;
    /**
     * Where the OAuth callback sends the browser when `returnTo` is missing
     * or not a safe same-site path. Default: a small page that notifies
     * `window.opener` (for popup flows) and closes.
     */
    callbackFallback?: string;
    /** Error hook for logging; the response is still produced. */
    onError?: (error: unknown, request: Request) => void;
}

export type ConduitFetchHandler = ((request: Request) => Promise<Response>) & {
    /** Like the handler, but resolves `undefined` for paths it does not serve. */
    route(request: Request): Promise<Response | undefined>;
};

class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string
    ) {
        super(message);
    }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

/** Only same-site relative paths are followed after the callback — never an open redirect. */
export function safeReturnPath(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
    if (/[\r\n]/.test(value)) return undefined;
    return value;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function callbackPage(result: { ok: boolean; account?: string; error?: string }): Response {
    // The message goes to the opener on THIS origin only.
    const payload = JSON.stringify({ type: 'conduit:auth', ...result }).replace(/</g, '\\u003c');
    const text = result.ok ? 'Connected. You can close this window.' : `Connection failed: ${escapeHtml(result.error ?? 'unknown error')}`;
    const html = `<!doctype html><meta charset="utf-8"><title>Conduit</title><p>${text}</p><script>try{if(window.opener){window.opener.postMessage(${payload},location.origin);window.close()}}catch(e){}</script>`;
    return new Response(html, {
        status: result.ok ? 200 : 400,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'"
        }
    });
}

function toErrorResponse(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: { code: error.code, message: error.message } });
    if (error instanceof ConduitValidationError) return json(400, { error: { code: error.code, message: error.message, issues: error.issues } });
    if (error instanceof ConduitAuthError) {
        return json(error.needsReauth ? 409 : 401, { error: { code: error.code, message: error.message, needsReauth: error.needsReauth, account: error.accountId } });
    }
    if (error instanceof ConduitRateLimitError) {
        const headers: Record<string, string> = error.retryAfterMs === undefined ? {} : { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) };
        return json(429, { error: { code: error.code, message: error.message } }, headers);
    }
    if (error instanceof ConduitRequestError) {
        return json(502, { error: { code: error.code, kind: error.kind, status: error.status, message: error.message } });
    }
    if (error instanceof ConduitSpecError) return json(500, { error: { code: error.code, message: 'the connector is invalid' } });
    if (isConduitError(error)) {
        const status = error.code.endsWith('_unknown') ? 404 : /^(account_required|account_mismatch|operation_kind|operation_not_callable|auth_redirect_required|body_invalid)$/.test(error.code) ? 400 : 500;
        return json(status, { error: { code: error.code, message: status === 500 ? 'internal error' : error.message } });
    }
    return json(500, { error: { code: 'internal', message: 'internal error' } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
    // JSON only: a cross-site HTML form cannot send this content type
    // without a CORS preflight, which closes the simple CSRF path.
    const type = request.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'send application/json');
    let body: unknown;
    try {
        const text = await request.text();
        body = text ? JSON.parse(text) : {};
    } catch {
        throw new HttpError(400, 'body_invalid', 'the body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body_invalid', 'the body must be a JSON object');
    return body as Record<string, unknown>;
}

const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !v) throw new HttpError(400, 'body_invalid', `"${name}" is required`);
    return v;
};
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const optObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

interface Match {
    params: Record<string, string>;
}

function matchPath(pattern: string, path: string): Match | undefined {
    const p = pattern.split('/').filter(Boolean);
    const s = path.split('/').filter(Boolean);
    if (p.length !== s.length) return undefined;
    const params: Record<string, string> = {};
    for (let i = 0; i < p.length; i++) {
        const seg = p[i]!;
        if (seg.startsWith(':')) {
            try {
                params[seg.slice(1)] = decodeURIComponent(s[i]!);
            } catch {
                return undefined;
            }
        } else if (seg !== s[i]) return undefined;
    }
    return { params };
}

type Handler = (request: Request, params: Record<string, string>, owner: string, url: URL) => Promise<Response>;

export function createFetchHandler(conduit: Conduit, options: FetchHandlerOptions): ConduitFetchHandler {
    const base = `/${(options.basePath ?? '/conduit').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');

    const owned = (method: string, path: string, handle: Handler) => ({ method, path, handle });

    const routes = [
        owned('GET', '/connectors', async () => json(200, { connectors: await conduit.connectors.list() })),
        owned('GET', '/connectors/:id', async (_r, p) => json(200, await conduit.connectors.describe(p.id!))),
        owned('GET', '/accounts', async (_r, _p, owner, url) =>
            json(200, { accounts: await conduit.accounts.list({ owner, connector: url.searchParams.get('connector') ?? undefined }) })
        ),
        owned('POST', '/accounts', async (r, _p, owner) => {
            const body = await readJson(r);
            const account = await conduit.auth.connect({
                connector: str(body.connector, 'connector'),
                method: str(body.method, 'method'),
                owner,
                inputs: optObj(body.inputs),
                account: optStr(body.account)
            });
            return json(201, { account });
        }),
        owned('POST', '/accounts/:id/test', async (_r, p, owner) => {
            const result = await conduit.auth.test(p.id!, owner);
            return json(200, result.ok ? { ok: true } : { ok: false, error: { code: result.error.code, message: result.error.message } });
        }),
        owned('POST', '/accounts/:id/refresh', async (_r, p, owner) => json(200, { account: await conduit.auth.refresh(p.id!, owner) })),
        owned('DELETE', '/accounts/:id', async (_r, p, owner) => {
            await conduit.auth.revoke(p.id!, owner);
            return new Response(null, { status: 204 });
        }),
        owned('POST', '/auth/:connector/:method/start', async (r, p, owner) => {
            const body = await readJson(r);
            const result = await conduit.auth.begin({
                connector: p.connector!,
                method: p.method!,
                owner,
                inputs: optObj(body.inputs),
                returnTo: safeReturnPath(body.returnTo),
                account: optStr(body.account),
                scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined
            });
            return json(200, result.type === 'redirect' ? { type: 'redirect', url: result.url } : result);
        }),
        owned('GET', '/auth/:connector/:method/start', async (_r, p, owner, url) => {
            // A plain link: <a href="/conduit/auth/acme/oauth/start?returnTo=/settings">
            const result = await conduit.auth.begin({
                connector: p.connector!,
                method: p.method!,
                owner,
                returnTo: safeReturnPath(url.searchParams.get('returnTo')),
                account: url.searchParams.get('account') ?? undefined
            });
            if (result.type !== 'redirect') throw new HttpError(400, 'auth_redirect_unavailable', 'this auth method connects without a redirect — POST to /accounts');
            return new Response(null, { status: 302, headers: { location: result.url, 'cache-control': 'no-store' } });
        }),
        owned('POST', '/options/:connector/:operation', async (r, p, owner) => {
            const body = await readJson(r);
            const options = await conduit.options({
                connector: p.connector!,
                operation: p.operation!,
                owner,
                account: optStr(body.account),
                inputs: optObj(body.inputs)
            });
            return json(200, { options });
        })
    ];

    if (options.exposeExecute) {
        routes.push(
            owned('POST', '/execute', async (r, _p, owner) => {
                const body = await readJson(r);
                const paging = optObj(body.paging);
                const result = await conduit.execute({
                    connector: str(body.connector, 'connector'),
                    operation: str(body.operation, 'operation'),
                    owner,
                    account: optStr(body.account),
                    inputs: optObj(body.inputs),
                    paging: paging
                        ? {
                              mode: paging.mode === 'page' ? 'page' : 'all',
                              cursor: paging.cursor,
                              maxPages: typeof paging.maxPages === 'number' ? paging.maxPages : undefined
                          }
                        : undefined,
                    signal: r.signal
                });
                const out: Record<string, unknown> = { output: result.output };
                if (result.next !== undefined) out.next = result.next;
                if (result.pages !== undefined) out.pages = result.pages;
                if (options.exposeTrace) out.trace = result.trace;
                return json(200, out);
            })
        );
    }

    async function callback(url: URL): Promise<Response> {
        try {
            const { account, returnTo } = await conduit.auth.complete({ callbackUrl: url.toString() });
            const target = safeReturnPath(returnTo) ?? options.callbackFallback;
            if (target) {
                const sep = target.includes('?') ? '&' : '?';
                return new Response(null, { status: 302, headers: { location: `${target}${sep}conduit_account=${encodeURIComponent(account.id)}`, 'cache-control': 'no-store' } });
            }
            return callbackPage({ ok: true, account: account.id });
        } catch (e) {
            const code = e instanceof ConduitError ? e.code : 'internal';
            const message = e instanceof ConduitError ? e.message : 'internal error';
            const fallback = options.callbackFallback;
            if (fallback) {
                const sep = fallback.includes('?') ? '&' : '?';
                return new Response(null, { status: 302, headers: { location: `${fallback}${sep}conduit_error=${encodeURIComponent(code)}`, 'cache-control': 'no-store' } });
            }
            return callbackPage({ ok: false, error: message });
        }
    }

    const pluginRoutes: readonly ConduitRoute[] = conduit.routes;

    async function route(request: Request): Promise<Response | undefined> {
        const url = new URL(request.url);
        if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return undefined;
        const path = url.pathname.slice(base.length) || '/';
        const method = request.method.toUpperCase();

        try {
            if (method === 'GET' && path === '/auth/callback') return await callback(url);

            let found: { handle: Handler; params: Record<string, string> } | { plugin: ConduitRoute; params: Record<string, string> } | undefined;
            let pathMatched = false;
            for (const r of routes) {
                const m = matchPath(r.path, path);
                if (!m) continue;
                pathMatched = true;
                if (r.method === method) {
                    found = { handle: r.handle, params: m.params };
                    break;
                }
            }
            if (!found) {
                for (const r of pluginRoutes) {
                    const m = matchPath(r.path, path);
                    if (!m) continue;
                    pathMatched = true;
                    if (r.method.toUpperCase() === method) {
                        found = { plugin: r, params: m.params };
                        break;
                    }
                }
            }
            if (!found) return pathMatched ? json(405, { error: { code: 'method_not_allowed', message: `${method} is not allowed here` } }) : undefined;

            const owner = await options.resolveOwner(request);
            if ('plugin' in found) return await found.plugin.handle(request, { params: found.params, owner });
            if (!owner) throw new HttpError(401, 'unauthenticated', 'sign in first');
            return await found.handle(request, found.params, owner, url);
        } catch (e) {
            options.onError?.(e, request);
            return toErrorResponse(e);
        }
    }

    const handler = (async (request: Request) =>
        (await route(request)) ?? json(404, { error: { code: 'not_found', message: 'no such route' } })) as ConduitFetchHandler;
    handler.route = route;
    return handler;
}
