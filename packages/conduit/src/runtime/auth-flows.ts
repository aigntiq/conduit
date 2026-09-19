/**
 * Credential lifecycles per auth type: minting, exchanging, refreshing,
 * identifying, testing and revoking. Every network call goes through the
 * kernel's `send`, i.e. the one request executor.
 */
import { ConduitAuthError, ConduitError, ConduitRequestError } from '../errors';
import { display } from '../expr/evaluate';
import { renderTemplate } from '../expr/template';
import { parseTokenResponse } from '../oauth';
import type { Credentials, OAuthClient } from '../ports/types';
import type { AuthMethod, CustomMethod, JwtMethod, OAuth2Method, TokenMapping } from '../spec/types';
import { signJwt } from '../util/crypto';
import { authScope, send, type CallContext, type Kernel } from './kernel';

type Scope = Record<string, unknown>;

/** A token endpoint's reply, as mappings read it: `response.body.access_token`. */
export interface TokenResponse {
    status: number;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

export function baseAuthScope(k: Kernel, ctx: CallContext, values: Record<string, unknown>, extra: Scope = {}): Scope {
    return { inputs: values, config: ctx.loaded.config, env: k.env, ...extra };
}

async function render(k: Kernel, ctx: CallContext, value: unknown, scope: Scope): Promise<unknown> {
    return renderTemplate(value, scope, { functions: ctx.loaded.functions, now: k.now });
}

/** Allow the host of an auth endpoint URL for this call. */
function allowEndpoint(ctx: CallContext, url: string): CallContext {
    try {
        return { ...ctx, guard: ctx.guard.with([new URL(url).host]) };
    } catch {
        throw new ConduitError('url_invalid', `auth endpoint "${url}" is not an absolute URL`);
    }
}

/** Auth requests the spec declares with an absolute URL are its own endpoints: allow their host. */
async function allowDeclared(k: Kernel, ctx: CallContext, urlTemplate: string, scope: Scope): Promise<CallContext> {
    const url = display(await render(k, ctx, urlTemplate, scope));
    return /^https?:\/\//i.test(url) ? allowEndpoint(ctx, url) : ctx;
}

export async function resolveClient(k: Kernel, ctx: CallContext, method: OAuth2Method, owner: string | undefined, values: Record<string, unknown>): Promise<OAuthClient> {
    const scope = baseAuthScope(k, ctx, values);
    if (method.client?.id) {
        const id = display(await render(k, ctx, method.client.id, scope));
        const secret = method.client.secret === undefined ? undefined : display(await render(k, ctx, method.client.secret, scope));
        if (id) return { id, secret: secret || undefined };
    }
    const fromHost = await k.clients({ connector: ctx.loaded.spec.id, method: method.id, owner });
    if (fromHost?.id) return fromHost;
    if (typeof values.clientId === 'string' && values.clientId) {
        return { id: values.clientId, secret: typeof values.clientSecret === 'string' ? values.clientSecret : undefined };
    }
    throw new ConduitError('oauth_client_missing', `no OAuth client configured for ${ctx.loaded.spec.id}/${method.id}`);
}

/** POST to a token endpoint and return the parsed token response. */
async function tokenCall(
    k: Kernel,
    ctx: CallContext,
    method: OAuth2Method,
    urlTemplate: string,
    params: Record<string, unknown>,
    client: OAuthClient,
    scope: Scope,
    purpose: string
): Promise<TokenResponse> {
    const url = display(await render(k, ctx, urlTemplate, scope));
    const call = allowEndpoint(ctx, url);
    call.mask.addValue(client.secret);
    const extraParams = (await render(k, ctx, method.tokenParams, scope)) as Record<string, unknown> | undefined;
    const body: Record<string, unknown> = { ...params, ...extraParams };
    const headers: Record<string, string> = { Accept: 'application/json' };
    if ((method.clientAuth ?? 'body') === 'basic') {
        const pair = `${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret ?? '')}`;
        headers.Authorization = `Basic ${btoa(pair)}`;
    } else {
        body.client_id = client.id;
        if (client.secret) body.client_secret = client.secret;
    }
    // The URL is already rendered; mark it literal so a `{{` inside it is not re-read.
    const view = await send(k, { ...call, rules: [], onUnauthorized: undefined }, {
        label: purpose,
        purpose,
        spec: { method: 'POST', url: '{{ endpoint }}', encoding: 'form', auth: false },
        scope: { endpoint: url },
        applyCredentials: false,
        useHttpDefaults: false,
        extraAuth: { headers, query: {} },
        // Pre-rendered: these values are secrets and codes, never templates.
        rawBody: body
    });
    const parsed = parseTokenResponse(view.body, view.headers['content-type']);
    if (typeof parsed.error === 'string' && !parsed.access_token) {
        throw new ConduitRequestError('auth', `token endpoint refused: ${parsed.error}${parsed.error_description ? ` — ${String(parsed.error_description)}` : ''}`, {
            status: view.status,
            retryable: false
        });
    }
    return { status: view.status, headers: view.headers, body: parsed };
}

function toEpochMs(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number') return Math.abs(value) < 1e11 ? value * 1000 : value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return toEpochMs(Number(value));
    const t = Date.parse(String(value));
    return Number.isNaN(t) ? undefined : t;
}

/** Map a token response onto credentials. */
export async function mapToken(
    k: Kernel,
    ctx: CallContext,
    mapping: TokenMapping | undefined,
    response: TokenResponse,
    scope: Scope,
    previous?: Credentials
): Promise<Omit<Credentials, 'values'>> {
    const s = { ...scope, response, auth: authScope(previous) };
    const pick = async (template: string | undefined, fallback: unknown) => (template === undefined ? fallback : render(k, ctx, template, s));
    const accessToken = await pick(mapping?.accessToken, response.body.access_token);
    if (accessToken === undefined || accessToken === null || accessToken === '') {
        throw new ConduitRequestError('auth', 'the token response has no access token', { retryable: false });
    }
    const refreshToken = await pick(mapping?.refreshToken, response.body.refresh_token);
    const expiresIn = await pick(mapping?.expiresIn, response.body.expires_in);
    const expiresAtRaw = mapping?.expiresAt === undefined ? undefined : await render(k, ctx, mapping.expiresAt, s);
    const tokenType = await pick(mapping?.tokenType, response.body.token_type);
    const scopeValue = await pick(mapping?.scope, response.body.scope);
    const data = mapping?.data === undefined ? undefined : ((await render(k, ctx, mapping.data, s)) as Record<string, unknown>);

    const seconds = expiresIn === undefined || expiresIn === null || expiresIn === '' ? undefined : Number(expiresIn);
    const expiresAt = toEpochMs(expiresAtRaw) ?? (seconds !== undefined && Number.isFinite(seconds) ? k.now() + seconds * 1000 : undefined);
    return {
        accessToken: String(accessToken),
        // Providers often omit the refresh token on refresh — keep the old one.
        refreshToken: refreshToken ? String(refreshToken) : previous?.refreshToken,
        tokenType: tokenType ? String(tokenType) : undefined,
        scope: scopeValue ? String(scopeValue) : previous?.scope,
        expiresAt,
        extra: { ...previous?.extra, ...data }
    };
}

export async function exchangeCode(
    k: Kernel,
    ctx: CallContext,
    method: OAuth2Method,
    input: { code: string; redirectUri: string; verifier?: string; client: OAuthClient; values: Record<string, unknown> }
): Promise<{ credentials: Credentials; tokenResponse: Record<string, unknown> }> {
    const scope = baseAuthScope(k, ctx, input.values, {
        oauth: { code: input.code, redirectUri: input.redirectUri },
        client: { id: input.client.id, secret: input.client.secret }
    });
    const response = await tokenCall(
        k,
        ctx,
        method,
        method.tokenUrl,
        {
            grant_type: 'authorization_code',
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.verifier
        },
        input.client,
        scope,
        'token'
    );
    const mapped = await mapToken(k, ctx, method.token, response, scope);
    return { credentials: { values: input.values, ...mapped }, tokenResponse: response.body };
}

async function clientCredentialsGrant(k: Kernel, ctx: CallContext, method: OAuth2Method, values: Record<string, unknown>, client: OAuthClient, previous?: Credentials) {
    const scope = baseAuthScope(k, ctx, values, { client: { id: client.id, secret: client.secret }, oauth: {} });
    const response = await tokenCall(
        k,
        ctx,
        method,
        method.tokenUrl,
        {
            grant_type: 'client_credentials',
            scope: method.scopes?.length ? method.scopes.join(method.scopeSeparator ?? ' ') : undefined
        },
        client,
        scope,
        'token'
    );
    const mapped = await mapToken(k, ctx, method.token, response, scope, previous);
    return { credentials: { values, ...mapped, refreshToken: undefined }, tokenResponse: response.body };
}

async function refreshGrant(k: Kernel, ctx: CallContext, method: OAuth2Method, credentials: Credentials, client: OAuthClient): Promise<Credentials> {
    const scope = baseAuthScope(k, ctx, credentials.values, {
        client: { id: client.id, secret: client.secret },
        oauth: {},
        auth: authScope(credentials)
    });
    const response = await tokenCall(
        k,
        ctx,
        method,
        method.refreshUrl ?? method.tokenUrl,
        { grant_type: 'refresh_token', refresh_token: credentials.refreshToken },
        client,
        scope,
        'refresh'
    );
    return { values: credentials.values, ...(await mapToken(k, ctx, method.token, response, scope, credentials)) };
}

async function mintJwt(k: Kernel, ctx: CallContext, method: JwtMethod, values: Record<string, unknown>, previous?: Credentials) {
    const nowSec = Math.floor(k.now() / 1000);
    const lifetime = method.jwt.lifetimeSec ?? 600;
    const scope = { auth: { ...values, ...previous?.extra }, config: ctx.loaded.config, env: k.env, now: nowSec };
    const key = display(await render(k, ctx, method.jwt.key, scope));
    if (!key) throw new ConduitError('jwt_key_missing', `auth method "${method.id}" rendered an empty signing key`);
    ctx.mask.addValue(key);
    const claims = { iat: nowSec, exp: nowSec + lifetime, ...((await render(k, ctx, method.jwt.claims, scope)) as Record<string, unknown>) };
    const header = (await render(k, ctx, method.jwt.header, scope)) as Record<string, unknown> | undefined;
    const jwt = await signJwt(claims, key, method.jwt.algorithm, header ?? {});
    ctx.mask.addValue(jwt);

    if (!method.exchange) {
        const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
        return { credentials: { values, accessToken: jwt, expiresAt: exp, extra: previous?.extra }, tokenResponse: {} };
    }
    const exchangeScope = { ...scope, jwt, inputs: values };
    const exchangeCtx = await allowDeclared(k, ctx, method.exchange.request.url, exchangeScope);
    const view = await send(k, { ...exchangeCtx, rules: [], onUnauthorized: undefined }, {
        label: 'jwt exchange',
        purpose: 'token',
        spec: { ...method.exchange.request, auth: false },
        scope: exchangeScope,
        applyCredentials: false
    });
    const response: TokenResponse = { status: view.status, headers: view.headers, body: parseTokenResponse(view.body, view.headers['content-type']) };
    const mapped = await mapToken(k, ctx, method.exchange.token, response, exchangeScope, previous);
    return { credentials: { values, ...mapped }, tokenResponse: response.body };
}

async function mintCustom(k: Kernel, ctx: CallContext, method: CustomMethod, values: Record<string, unknown>) {
    const steps: Record<string, unknown> = {};
    for (const step of method.steps ?? []) {
        const scope = baseAuthScope(k, ctx, values, { steps });
        if (step.when !== undefined && !(await render(k, ctx, step.when, scope))) continue;
        const stepCtx = await allowDeclared(k, ctx, step.url, scope);
        const view = await send(k, { ...stepCtx, onUnauthorized: undefined }, {
            label: `auth step ${step.name}`,
            purpose: 'token',
            spec: { ...step, auth: false },
            scope,
            applyCredentials: false
        });
        steps[step.name] = step.output === undefined ? view.body : await render(k, ctx, step.output, { ...scope, response: view });
    }
    const scope = baseAuthScope(k, ctx, values, { steps });
    const extra = method.credentials === undefined ? {} : ((await render(k, ctx, method.credentials, scope)) as Record<string, unknown>);
    for (const v of Object.values(extra ?? {})) ctx.mask.addValue(v);
    const expiresIn = method.expiresIn === undefined ? undefined : Number(await render(k, ctx, method.expiresIn, scope));
    return {
        credentials: {
            values,
            extra: extra ?? {},
            expiresAt: expiresIn !== undefined && Number.isFinite(expiresIn) ? k.now() + expiresIn * 1000 : undefined
        },
        tokenResponse: { steps }
    };
}

/** Mint credentials for a method that connects without a browser redirect. */
export async function mint(
    k: Kernel,
    ctx: CallContext,
    method: AuthMethod,
    values: Record<string, unknown>,
    owner: string | undefined
): Promise<{ credentials: Credentials; tokenResponse: Record<string, unknown> }> {
    switch (method.type) {
        case 'apiKey':
        case 'basic':
        case 'bearer':
            return { credentials: { values }, tokenResponse: {} };
        case 'oauth2':
            if ((method.grant ?? 'authorization_code') === 'authorization_code') {
                throw new ConduitError('auth_redirect_required', `auth method "${method.id}" connects through a redirect — use auth.begin`);
            }
            return clientCredentialsGrant(k, ctx, method, values, await resolveClient(k, ctx, method, owner, values));
        case 'jwt':
            return mintJwt(k, ctx, method, values);
        case 'custom':
            return mintCustom(k, ctx, method, values);
    }
}

/** Whether these credentials can be renewed without the owner. */
export function canRefresh(method: AuthMethod, credentials: Credentials): boolean {
    switch (method.type) {
        case 'oauth2':
            return (method.grant ?? 'authorization_code') === 'client_credentials' || !!credentials.refreshToken;
        case 'jwt':
            return true;
        case 'custom':
            return !!method.steps?.length || method.expiresIn !== undefined;
        default:
            return false;
    }
}

/** Renew credentials. Callers hold the account lock. */
export async function refresh(k: Kernel, ctx: CallContext, method: AuthMethod, credentials: Credentials, owner: string): Promise<Credentials> {
    switch (method.type) {
        case 'oauth2': {
            const client = await resolveClient(k, ctx, method, owner, credentials.values);
            if ((method.grant ?? 'authorization_code') === 'client_credentials') {
                return (await clientCredentialsGrant(k, ctx, method, credentials.values, client, credentials)).credentials;
            }
            return refreshGrant(k, ctx, method, credentials, client);
        }
        case 'jwt':
            return (await mintJwt(k, ctx, method, credentials.values, credentials)).credentials;
        case 'custom':
            return (await mintCustom(k, ctx, method, credentials.values)).credentials;
        default:
            throw new ConduitAuthError(`auth method "${method.id}" cannot be refreshed`, { needsReauth: true });
    }
}

export interface Identity {
    externalId?: string;
    displayName?: string;
    data?: Record<string, unknown>;
}

export async function identify(k: Kernel, ctx: CallContext, method: AuthMethod, tokenResponse: Record<string, unknown>): Promise<Identity> {
    const identity = method.identity;
    if (!identity) return {};
    const values = ctx.credentials?.values ?? {};
    const scope: Scope = { inputs: values, config: ctx.loaded.config, env: k.env, token: tokenResponse };
    let response: unknown;
    if (identity.request) {
        response = await send(k, { ...ctx, onUnauthorized: undefined }, { label: 'identity', purpose: 'identity', spec: identity.request, scope });
    }
    const mapScope = { ...scope, auth: authScope(ctx.credentials), response };
    const id = identity.id === undefined ? undefined : await render(k, ctx, identity.id, mapScope);
    const name = identity.name === undefined ? undefined : await render(k, ctx, identity.name, mapScope);
    const data = identity.data === undefined ? undefined : await render(k, ctx, identity.data, mapScope);
    return {
        externalId: id === undefined || id === null || id === '' ? undefined : display(id),
        displayName: name === undefined || name === null || name === '' ? undefined : display(name),
        data: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
    };
}

/** Run the method's `test` request. Throws on failure. No-op without one. */
export async function testCredentials(k: Kernel, ctx: CallContext, method: AuthMethod, account?: Scope): Promise<boolean> {
    if (!method.test) return false;
    const scope: Scope = { inputs: ctx.credentials?.values ?? {}, config: ctx.loaded.config, env: k.env, account };
    await send(k, ctx, { label: 'test', purpose: 'test', spec: method.test, scope });
    return true;
}

/** Best-effort remote revocation (RFC 7009). Failures are swallowed — the account is removed either way. */
export async function revokeRemote(k: Kernel, ctx: CallContext, method: AuthMethod, credentials: Credentials, owner: string): Promise<void> {
    if (method.type !== 'oauth2' || !method.revokeUrl) return;
    const token = credentials.refreshToken ?? credentials.accessToken;
    if (!token) return;
    try {
        const client = await resolveClient(k, ctx, method, owner, credentials.values);
        const scope = baseAuthScope(k, ctx, credentials.values, { client: { id: client.id }, oauth: {}, auth: authScope(credentials) });
        const once = { ...ctx, retry: { attempts: 1, initialDelayMs: 0, maxDelayMs: 0, factor: 1, on: [] } };
        await tokenCall(k, once, method, method.revokeUrl, {
            token,
            token_type_hint: credentials.refreshToken ? 'refresh_token' : 'access_token'
        }, client, scope, 'revoke');
    } catch {
        // best effort
    }
}
