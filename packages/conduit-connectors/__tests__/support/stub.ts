/**
 * Replay-test harness for connectors: a scripted stand-in for a provider's
 * OAuth and API endpoints that records every request, plus `connect()`, which
 * runs a real OAuth grant against it.
 */
import { createConduit, type CatalogOf, type HttpClient } from '@aigntiq/conduit';
import { connectorCatalog, type Connectors } from '@aigntiq/conduit-connectors';

export const SECRET = 'connector-replay-tests-secret-long-enough';
export const REDIRECT = 'https://app.example/conduit/auth/callback';

export interface Seen {
    method: string;
    url: URL;
    body: string;
    headers: Headers;
}

/** One API request, as a route sees it. */
export interface Call extends Seen {
    /** The URL path with the API's `prefix` removed. */
    path: string;
    /** `"<METHOD> <path>"` — what to `switch` on. */
    route: string;
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface ScriptedHttpOptions {
    /** `host/path` of the token endpoint, e.g. `oauth2.googleapis.com/token`. */
    tokenEndpoint: string;
    /** `host/path` of the revoke endpoint, if the provider has one. */
    revokeEndpoint?: string;
    /** The access token the token endpoint issues and the API requires. */
    accessToken: string;
    /** Hosts the API serves; any other host gets a 500. */
    hosts: readonly string[];
    /** Path prefix stripped before routing, e.g. `/gmail/v1`. */
    prefix?: string;
    /** Answer an authorized API call; `undefined` falls through to a 404. */
    routes: (call: Call) => Response | undefined | Promise<Response | undefined>;
}

export function scriptedHttp(options: ScriptedHttpOptions) {
    const seen: Seen[] = [];
    const http: HttpClient = async (request) => {
        const url = new URL(request.url);
        const body = request.body ? await request.text() : '';
        const call = { method: request.method, url, body, headers: request.headers };
        seen.push(call);
        const endpoint = `${url.host}${url.pathname}`;

        if (request.method === 'POST' && endpoint === options.tokenEndpoint) {
            return json({ access_token: options.accessToken, refresh_token: 'refresh-token', expires_in: 3599, token_type: 'Bearer' });
        }
        if (request.method === 'POST' && endpoint === options.revokeEndpoint) return json({});
        if (!options.hosts.includes(url.host)) return json({ error: { message: 'unexpected host' } }, 500);
        if (request.headers.get('authorization') !== `Bearer ${options.accessToken}`) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);

        const path = options.prefix && url.pathname.startsWith(options.prefix) ? url.pathname.slice(options.prefix.length) : url.pathname;
        const answer = await options.routes({ ...call, path, route: `${request.method} ${path}` });
        return answer ?? json({ error: { message: `no route ${request.method} ${path}` } }, 404);
    };
    return { http, seen };
}

export type ConnectorId = Connectors['id'];

/** A Conduit over the package's catalog, talking to `http`, with an account connected through `method`. */
export async function connect(connector: ConnectorId, http: HttpClient, options: { client?: { id: string; secret: string }; method?: string; owner?: string } = {}) {
    const conduit = createConduit<CatalogOf<Connectors>>({
        sources: connectorCatalog({ include: [connector] }),
        secret: SECRET,
        http,
        redirectUri: REDIRECT,
        clients: { [connector]: options.client ?? { id: 'client-id', secret: 'client-secret' } }
    });
    const begun = await conduit.auth.begin({ connector, method: options.method ?? 'oauth', owner: options.owner ?? 'u1' });
    if (begun.type !== 'redirect') throw new Error('expected a redirect');
    const { account } = await conduit.auth.complete({ params: { state: begun.state, code: 'auth-code' } });
    return { conduit, account: account.id, authorizeUrl: new URL(begun.url) };
}

/** The last recorded request matching `method` and a path pattern. */
export function last(seen: readonly Seen[], method: string, path: RegExp): Seen {
    const hit = [...seen].reverse().find((s) => s.method === method && path.test(s.url.pathname));
    if (!hit) throw new Error(`no ${method} ${path} request was made`);
    return hit;
}
