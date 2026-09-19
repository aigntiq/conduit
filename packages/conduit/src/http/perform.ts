/**
 * The one request executor. Every outbound call Conduit makes — operations,
 * steps, pages, token exchanges, identity lookups, tests — goes through
 * `performRequest`, so retries, the host guard, redirects, middleware,
 * timeouts, classification and tracing behave the same everywhere.
 */
import { ConduitError, ConduitRateLimitError, ConduitRequestError, type ErrorKind } from '../errors';
import type { HttpClient } from '../ports/types';
import type { RetryPolicy } from '../spec/types';
import type { Failure } from './classify';
import type { HostGuard } from './guard';
import type { PreparedRequest } from './request';
import { readResponse, retryAfterMs, type ResponseView } from './response';

/** What a middleware knows about the call it wraps. */
export interface RequestInfo {
    connector: string;
    operation?: string;
    account?: string;
    /** `operation`, `step`, `page`, `token`, `refresh`, `identity`, `test`, `revoke`, … */
    purpose: string;
    attempt: number;
}

export type RequestMiddleware = (request: Request, next: (request: Request) => Promise<Response>, info: RequestInfo) => Promise<Response>;

export interface TraceEntry {
    label: string;
    method: string;
    /** Secret query values and known secret strings replaced with `***`. */
    url: string;
    status?: number;
    attempt: number;
    durationMs: number;
    outcome: 'ok' | 'retry' | 'refresh' | 'error';
    error?: string;
}

export interface ResolvedRetry {
    attempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    factor: number;
    on: readonly ErrorKind[];
}

export function resolveRetry(...policies: (RetryPolicy | false | undefined)[]): ResolvedRetry {
    const merged: RetryPolicy = {};
    for (const p of policies) {
        if (p === false) return { attempts: 1, initialDelayMs: 0, maxDelayMs: 0, factor: 1, on: [] };
        if (p) Object.assign(merged, p);
    }
    return {
        attempts: merged.attempts ?? 3,
        initialDelayMs: merged.initialDelayMs ?? 500,
        maxDelayMs: merged.maxDelayMs ?? 30_000,
        factor: merged.factor ?? 2,
        on: merged.on ?? ['rateLimited', 'transient']
    };
}

export interface HttpRuntime {
    fetch: HttpClient;
    middleware: readonly RequestMiddleware[];
    now: () => number;
    /** Injected for tests; default `setTimeout`. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Injected for tests; default `Math.random`. */
    random?: () => number;
}

export interface PerformInput {
    label: string;
    info: Omit<RequestInfo, 'attempt'>;
    /** Called per attempt — so a retry after a refresh picks up the new credentials. */
    build: () => Promise<PreparedRequest>;
    classify: (view: ResponseView) => Promise<Failure | undefined>;
    retry: ResolvedRetry;
    guard: HostGuard;
    /** Called once on an `auth` failure; resolve true when credentials were refreshed. */
    onUnauthorized?: () => Promise<boolean>;
    signal?: AbortSignal;
    trace?: TraceEntry[];
    mask: Masker;
}

const MAX_REDIRECTS = 5;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }
        function onAbort() {
            clearTimeout(timer);
            reject(signal!.reason);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Replaces secret values in URLs and messages. */
export class Masker {
    private readonly values: string[] = [];
    private readonly params = new Set(['access_token', 'refresh_token', 'client_secret', 'code', 'code_verifier', 'password', 'api_key', 'apikey', 'key', 'token', 'secret', 'signature', 'sig']);

    addValue(value: unknown): this {
        if (typeof value === 'string' && value.length >= 4) this.values.push(value);
        return this;
    }

    addParam(name: string): this {
        this.params.add(name.toLowerCase());
        return this;
    }

    text(input: string): string {
        let out = input;
        for (const v of this.values) out = out.split(v).join('***');
        return out;
    }

    url(url: URL): string {
        const copy = new URL(url);
        for (const key of Array.from(copy.searchParams.keys())) {
            if (this.params.has(key.toLowerCase())) copy.searchParams.set(key, '***');
        }
        return this.text(copy.toString().replace(/%2A%2A%2A/g, '***'));
    }
}

function toRequest(p: PreparedRequest, url: URL, signal: AbortSignal): Request {
    return new Request(url, { method: p.method, headers: p.headers, body: p.body, signal, redirect: 'manual' });
}

async function send(runtime: HttpRuntime, prepared: PreparedRequest, info: RequestInfo, guard: HostGuard, signal: AbortSignal): Promise<Response> {
    const chain = (index: number) => (request: Request): Promise<Response> =>
        index < runtime.middleware.length ? runtime.middleware[index]!(request, chain(index + 1), info) : runtime.fetch(request);

    let current = prepared;
    let url = prepared.url;
    for (let hop = 0; ; hop++) {
        guard.check(url);
        const response = await chain(0)(toRequest(current, url, signal));
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || response.status === 304 || !location) return response;
        if (hop >= MAX_REDIRECTS) throw new ConduitRequestError('fatal', `too many redirects (> ${MAX_REDIRECTS})`, { retryable: false });
        await response.body?.cancel().catch(() => undefined);
        const next = new URL(location, url);
        const headers = new Headers(current.headers);
        // Credentials never follow a redirect to another origin.
        if (next.origin !== url.origin) {
            headers.delete('authorization');
            headers.delete('cookie');
        }
        const keepBody = response.status === 307 || response.status === 308;
        if (!keepBody) {
            headers.delete('content-type');
            headers.delete('content-length');
        }
        current = {
            ...current,
            headers,
            method: keepBody || current.method === 'HEAD' ? current.method : 'GET',
            body: keepBody ? current.body : undefined
        };
        url = next;
    }
}

function backoff(policy: ResolvedRetry, attempt: number, random: () => number): number {
    const ceiling = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.factor ** (attempt - 1));
    return Math.round(random() * ceiling);
}

function toError(failure: Failure, view: ResponseView | undefined, retryAfter: number | undefined, cause?: unknown): ConduitRequestError {
    if (failure.kind === 'rateLimited') {
        return new ConduitRateLimitError(failure.message, { status: failure.status, body: view?.body, retryAfterMs: retryAfter, cause });
    }
    return new ConduitRequestError(failure.kind, failure.message, {
        status: failure.status,
        body: view?.body,
        retryable: failure.retryable,
        cause
    });
}

export async function performRequest(runtime: HttpRuntime, input: PerformInput): Promise<ResponseView> {
    const sleep = runtime.sleep ?? defaultSleep;
    const random = runtime.random ?? Math.random;
    let refreshed = false;

    for (let attempt = 1; ; attempt++) {
        if (input.signal?.aborted) throw new ConduitError('aborted', 'the call was aborted', { cause: input.signal.reason });
        const prepared = await input.build();
        const started = runtime.now();
        const entry: TraceEntry = {
            label: input.label,
            method: prepared.method,
            url: input.mask.url(prepared.url),
            attempt,
            durationMs: 0,
            outcome: 'ok'
        };
        input.trace?.push(entry);

        const timeout = AbortSignal.timeout(prepared.timeoutMs);
        const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

        let view: ResponseView | undefined;
        let failure: Failure | undefined;
        let cause: unknown;
        try {
            const response = await send(runtime, prepared, { ...input.info, attempt }, input.guard, signal);
            view = await readResponse(response, prepared.responseType, prepared.method);
            entry.status = view.status;
            failure = await input.classify(view);
        } catch (e) {
            if (input.signal?.aborted) {
                entry.outcome = 'error';
                entry.error = 'aborted';
                throw new ConduitError('aborted', 'the call was aborted', { cause: input.signal.reason });
            }
            if (e instanceof ConduitError) {
                entry.outcome = 'error';
                entry.error = input.mask.text(e.message);
                throw e;
            }
            cause = e;
            const timedOut = timeout.aborted;
            failure = {
                kind: 'transient',
                message: timedOut ? `request timed out after ${prepared.timeoutMs} ms` : `request failed: ${input.mask.text((e as Error).message ?? String(e))}`,
                retryable: true
            };
        } finally {
            entry.durationMs = runtime.now() - started;
        }

        if (!failure) return view!;
        entry.error = input.mask.text(failure.message);

        if (failure.kind === 'auth' && input.onUnauthorized && !refreshed) {
            refreshed = true;
            if (await input.onUnauthorized()) {
                entry.outcome = 'refresh';
                attempt--; // a refresh-and-replay is not a retry
                continue;
            }
        }

        const after = view ? retryAfterMs(view.headers, runtime.now()) : undefined;
        const retryable = failure.retryable && (failure.forced || input.retry.on.includes(failure.kind));
        if (retryable && attempt < input.retry.attempts) {
            entry.outcome = 'retry';
            const delay = Math.min(input.retry.maxDelayMs, after ?? backoff(input.retry, attempt, random));
            await sleep(delay, input.signal).catch(() => undefined);
            continue;
        }

        entry.outcome = 'error';
        throw toError(failure, view, after, cause);
    }
}
