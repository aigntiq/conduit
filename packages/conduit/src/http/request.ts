/**
 * Rendering a `RequestSpec` into a concrete request.
 *
 * Precedence for headers and query, lowest first: the connector's `http`
 * defaults, the request's own values, then the auth method's `apply` — so a
 * spec can never accidentally shadow the credentials.
 */
import { ConduitError, ConduitRequestError, ConduitSpecError } from '../errors';
import { isPlainObject } from '../expr/evaluate';
import { renderTemplate } from '../expr/template';
import type { EvalOptions, Scope } from '../expr/evaluate';
import type { HttpDefaults, RequestEncoding, RequestSpec, ResponseType } from '../spec/types';
import { fromBase64, utf8 } from '../util/bytes';

export interface PreparedRequest {
    method: string;
    url: URL;
    headers: Headers;
    body: BodyInit | undefined;
    responseType: ResponseType;
    timeoutMs: number;
}

/** What the auth layer contributes to a request. */
export interface AppliedAuth {
    headers: Record<string, string>;
    query: Record<string, string>;
}

export interface RenderInput {
    spec: RequestSpec;
    http: HttpDefaults | undefined;
    scope: Scope;
    eval: EvalOptions;
    auth?: AppliedAuth;
    /** Encoders registered by plugins, by encoding name. */
    encoders?: ReadonlyMap<string, BodyEncoder>;
    /** Replace the URL entirely (pagination following a next-page URL). Query params from the spec are then skipped. */
    urlOverride?: string;
    /** Extra query params (pagination). Win over the spec's own. */
    extraQuery?: Record<string, unknown>;
    /**
     * A body that is already data — sent as is, never rendered. For values
     * that must not be read as templates (secrets in a token request).
     */
    rawBody?: { value: unknown };
    defaultTimeoutMs?: number;
}

/** Turns a rendered body into a fetch body, setting headers as needed. */
export type BodyEncoder = (body: unknown, headers: Headers) => BodyInit | undefined;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function queryValue(v: unknown): string | string[] | undefined {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) return v.flatMap((x) => (x === undefined || x === null ? [] : [typeof x === 'object' ? JSON.stringify(x) : String(x)]));
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function addQuery(url: URL, params: Record<string, unknown> | undefined): void {
    if (!params) return;
    for (const [key, raw] of Object.entries(params)) {
        const value = queryValue(raw);
        if (value === undefined) continue;
        url.searchParams.delete(key);
        if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
        else url.searchParams.set(key, value);
    }
}

function addHeaders(headers: Headers, values: Record<string, unknown> | undefined): void {
    if (!values) return;
    for (const [key, v] of Object.entries(values)) {
        if (v === undefined || v === null || v === '') continue;
        headers.set(key, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
}

/** Join a base URL and a relative path without doubling or losing slashes. */
export function joinUrl(base: string | undefined, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    // Any other scheme (file:, data:, javascript:, …) is refused rather than
    // silently treated as a path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
        throw new ConduitRequestError('fatal', `unsupported URL scheme in "${path.slice(0, 40)}"`, { retryable: false });
    }
    if (!base) throw new ConduitError('url_invalid', `request URL "${path}" is relative but the connector has no baseUrl`);
    if (!path) return base;
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function toBytes(v: unknown): Uint8Array | undefined {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === 'string') return fromBase64(v);
    return undefined;
}

function formPairs(body: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, raw] of Object.entries(body)) {
        const value = queryValue(raw);
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
        else params.append(key, value);
    }
    return params;
}

export const BUILTIN_ENCODERS: Record<RequestEncoding, BodyEncoder> = {
    json(body, headers) {
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        return JSON.stringify(body);
    },
    form(body, headers) {
        if (!isPlainObject(body)) throw new ConduitError('body_invalid', 'a form body must be an object');
        if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
        return formPairs(body).toString();
    },
    multipart(body) {
        // The runtime sets the boundary content-type itself.
        if (!isPlainObject(body)) throw new ConduitError('body_invalid', 'a multipart body must be an object');
        const form = new FormData();
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined || value === null) continue;
            if (value instanceof Blob) form.append(key, value);
            else if (isPlainObject(value) && ('content' in value || 'base64' in value)) {
                // A file part: { filename, contentType, content | base64 }
                const bytes = typeof value.content === 'string' ? utf8(value.content) : toBytes(value.base64 ?? value.content);
                if (!bytes) throw new ConduitError('body_invalid', `multipart field "${key}" has no content`);
                const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: String(value.contentType ?? 'application/octet-stream') });
                form.append(key, blob, String(value.filename ?? key));
            } else form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
        return form;
    },
    text(body, headers) {
        if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
        return typeof body === 'string' ? body : JSON.stringify(body);
    },
    binary(body, headers) {
        const bytes = toBytes(body);
        if (!bytes) throw new ConduitError('body_invalid', 'a binary body must be bytes or a base64 string');
        if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
        return bytes as Uint8Array<ArrayBuffer>;
    }
};

export async function renderRequest(input: RenderInput): Promise<PreparedRequest> {
    const { spec, http, scope } = input;
    const render = (v: unknown) => renderTemplate(v, scope, input.eval);

    const methodValue = spec.method === undefined ? 'GET' : await render(spec.method);
    const method = String(methodValue ?? 'GET').toUpperCase();
    if (!METHODS.has(method)) throw new ConduitSpecError(`"${method}" is not an HTTP method`);

    let url: URL;
    if (input.urlOverride) {
        url = new URL(input.urlOverride);
    } else {
        const base = http?.baseUrl === undefined ? undefined : String((await render(http.baseUrl)) ?? '');
        const path = String((await render(spec.url)) ?? '');
        const full = joinUrl(base || undefined, path);
        try {
            url = new URL(full);
        } catch {
            throw new ConduitError('url_invalid', `"${full}" is not a valid URL`);
        }
        addQuery(url, (await render(http?.query)) as Record<string, unknown> | undefined);
        const query = await render(spec.query);
        if (query !== undefined && query !== null && !isPlainObject(query)) {
            throw new ConduitError('query_invalid', 'request query must render to an object');
        }
        addQuery(url, query as Record<string, unknown> | undefined);
    }
    addQuery(url, input.extraQuery);
    addQuery(url, input.auth?.query);

    const headers = new Headers();
    addHeaders(headers, (await render(http?.headers)) as Record<string, unknown> | undefined);
    addHeaders(headers, (await render(spec.headers)) as Record<string, unknown> | undefined);
    addHeaders(headers, input.auth?.headers);

    let body: BodyInit | undefined;
    if ((spec.body !== undefined || input.rawBody) && method !== 'GET' && method !== 'HEAD') {
        const rendered = input.rawBody ? input.rawBody.value : await render(spec.body);
        if (rendered !== undefined) {
            const encoding = spec.encoding ?? 'json';
            const encoder = input.encoders?.get(encoding) ?? BUILTIN_ENCODERS[encoding as RequestEncoding];
            if (!encoder) throw new ConduitSpecError(`unknown request encoding "${encoding}"`);
            body = encoder(rendered, headers);
        }
    }

    return {
        method,
        url,
        headers,
        body,
        responseType: spec.responseType ?? 'auto',
        timeoutMs: spec.timeoutMs ?? http?.timeoutMs ?? input.defaultTimeoutMs ?? 30_000
    };
}
