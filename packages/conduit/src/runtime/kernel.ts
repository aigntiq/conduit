/**
 * The kernel: every runtime service in one object, threaded through the
 * auth flows, the account service and the executor. Internal.
 */
import type { FunctionRegistry, Scope } from '../expr/evaluate';
import { renderTemplate } from '../expr/template';
import { classify } from '../http/classify';
import type { HostGuard } from '../http/guard';
import { Masker, performRequest, resolveRetry, type HttpRuntime, type ResolvedRetry, type TraceEntry } from '../http/perform';
import { renderRequest, type AppliedAuth } from '../http/request';
import type { ResponseView } from '../http/response';
import type { AccountStore, ClientResolver, Credentials, LockProvider, SecretCipher, StoredAccount, TransientStore } from '../ports/types';
import { authInputs, secretInputNames } from '../spec/inputs';
import type { AuthMethod, ErrorRule, RequestSpec } from '../spec/types';
import type { PluginHost } from './plugins';
import type { ConnectorRegistry, LoadedConnector } from './registry';

export interface Kernel {
    registry: ConnectorRegistry;
    accounts: AccountStore;
    transient: TransientStore;
    locks: LockProvider;
    cipher: SecretCipher;
    stateKey: Promise<CryptoKey>;
    clients: ClientResolver;
    plugins: PluginHost;
    http: HttpRuntime;
    env: Record<string, unknown>;
    now: () => number;
    redirectUri: string | undefined;
}

/** The non-secret view of an account that templates read as `account`. */
export function accountScope(account: StoredAccount | undefined): Record<string, unknown> | undefined {
    if (!account) return undefined;
    return {
        id: account.id,
        owner: account.owner,
        connector: account.connector,
        method: account.method,
        externalId: account.externalId,
        displayName: account.displayName,
        data: account.data ?? {}
    };
}

/** What templates read as `auth`. */
export function authScope(credentials: Credentials | undefined): Record<string, unknown> {
    if (!credentials) return {};
    return {
        ...credentials.values,
        ...credentials.extra,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        tokenType: credentials.tokenType,
        scope: credentials.scope,
        expiresAt: credentials.expiresAt
    };
}

/** Where credentials go on a request: the method's `apply`, or its type's default. */
export async function applyAuth(method: AuthMethod | undefined, credentials: Credentials | undefined, scope: Scope, functions: FunctionRegistry): Promise<AppliedAuth> {
    const out: AppliedAuth = { headers: {}, query: {} };
    if (!method || !credentials) return out;
    const opts = { functions };
    const toStrings = (v: unknown) => {
        const r: Record<string, string> = {};
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null && x !== '') r[k] = String(x);
        return r;
    };
    if (method.apply) {
        out.headers = toStrings(await renderTemplate(method.apply.headers, scope, opts));
        out.query = toStrings(await renderTemplate(method.apply.query, scope, opts));
        return out;
    }
    const auth = authScope(credentials);
    switch (method.type) {
        case 'oauth2':
        case 'jwt':
            if (credentials.accessToken) out.headers.Authorization = `Bearer ${credentials.accessToken}`;
            break;
        case 'bearer':
            if (auth.token) out.headers.Authorization = `Bearer ${String(auth.token)}`;
            break;
        case 'basic': {
            const pair = `${String(auth.username ?? '')}:${String(auth.password ?? '')}`;
            const bytes = new TextEncoder().encode(pair);
            let bin = '';
            for (const b of bytes) bin += String.fromCharCode(b);
            out.headers.Authorization = `Basic ${btoa(bin)}`;
            break;
        }
        case 'apiKey': {
            const raw = method.value === undefined ? auth.apiKey : await renderTemplate(method.value, scope, opts);
            if (raw === undefined || raw === null || raw === '') break;
            const value = `${method.prefix ?? ''}${String(raw)}`;
            if ((method.in ?? 'header') === 'query') out.query[method.name] = value;
            else out.headers[method.name] = value;
            break;
        }
        case 'custom':
            break;
    }
    return out;
}

/** A masker primed with an account's secret values and the method's parameter names. */
export function maskerFor(method: AuthMethod | undefined, credentials: Credentials | undefined): Masker {
    const mask = new Masker();
    if (method?.type === 'apiKey' && (method.in ?? 'header') === 'query') mask.addParam(method.name);
    if (!credentials) return mask;
    mask.addValue(credentials.accessToken).addValue(credentials.refreshToken);
    const secretNames = method ? secretInputNames(authInputs(method)) : [];
    for (const name of secretNames) mask.addValue(credentials.values[name]);
    return mask;
}

export interface CallContext {
    loaded: LoadedConnector;
    guard: HostGuard;
    method?: AuthMethod;
    credentials?: Credentials;
    info: { connector: string; operation?: string; account?: string };
    trace?: TraceEntry[];
    signal?: AbortSignal;
    mask: Masker;
    retry?: ResolvedRetry;
    rules?: readonly ErrorRule[];
    onUnauthorized?: () => Promise<boolean>;
}

export interface SendOptions {
    label: string;
    purpose: string;
    spec: RequestSpec;
    /** Scope minus `auth` — the current credentials are merged in per attempt. */
    scope: Record<string, unknown>;
    /** Apply the account's credentials (and the request's own `auth` flag). Default true. */
    applyCredentials?: boolean;
    urlOverride?: string;
    extraQuery?: Record<string, unknown>;
    /** Extra headers/query from outside the spec (e.g. token-endpoint client auth). */
    extraAuth?: AppliedAuth;
    /** Override the connector http defaults (auth endpoints skip `http.headers`/`query`). */
    useHttpDefaults?: boolean;
    /** A body that is already data, sent without template rendering. */
    rawBody?: Record<string, unknown>;
}

/** Render and send one request through the shared executor. */
export async function send(k: Kernel, ctx: CallContext, options: SendOptions): Promise<ResponseView> {
    const { loaded } = ctx;
    const evalOpts = { functions: loaded.functions, now: k.now };
    const http = options.useHttpDefaults === false ? { baseUrl: loaded.spec.http?.baseUrl, timeoutMs: loaded.spec.http?.timeoutMs } : loaded.spec.http;
    const connectorRules = options.useHttpDefaults === false ? [] : (loaded.spec.http?.errors ?? []);
    const rules = [...(ctx.rules ?? []), ...connectorRules];
    // Current credentials win (they change when a 401 triggers a renewal);
    // flows that run before an account exists supply their own `auth`.
    const scopeNow = () => ({ ...options.scope, auth: ctx.credentials ? authScope(ctx.credentials) : (options.scope.auth ?? {}) });

    // The rendered baseUrl is the connector's own declaration of where it
    // talks to, so its host is allowed for this call.
    let guard = ctx.guard;
    if (http?.baseUrl) {
        const base = await renderTemplate(http.baseUrl, scopeNow(), evalOpts);
        try {
            guard = guard.with([new URL(String(base)).host]);
        } catch {
            // an unusable baseUrl surfaces when the request is built
        }
    }

    return performRequest(
        { ...k.http, middleware: [...k.plugins.middleware, ...k.http.middleware] },
        {
            label: options.label,
            info: { ...ctx.info, purpose: options.purpose },
            guard,
            mask: ctx.mask,
            trace: ctx.trace,
            signal: ctx.signal,
            retry: ctx.retry ?? resolveRetry(loaded.spec.http?.retry),
            onUnauthorized: options.applyCredentials === false ? undefined : ctx.onUnauthorized,
            build: async () => {
                const scope = scopeNow();
                const credentialsOn = options.applyCredentials !== false && options.spec.auth !== false;
                const applied = credentialsOn ? await applyAuth(ctx.method, ctx.credentials, scope, loaded.functions) : { headers: {}, query: {} };
                if (options.extraAuth) {
                    Object.assign(applied.headers, options.extraAuth.headers);
                    Object.assign(applied.query, options.extraAuth.query);
                }
                return renderRequest({
                    spec: options.spec,
                    http,
                    scope,
                    eval: evalOpts,
                    auth: applied,
                    encoders: k.plugins.encoders,
                    urlOverride: options.urlOverride,
                    extraQuery: options.extraQuery,
                    rawBody: options.rawBody ? { value: options.rawBody } : undefined
                });
            },
            classify: (view) => classify(view, rules, scopeNow(), evalOpts)
        }
    );
}
