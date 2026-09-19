/**
 * Response classification: turns every response into success or a
 * classified failure, from the spec's `errors` rules and then the defaults.
 */
import type { ErrorKind } from '../errors';
import { display, type EvalOptions, type Scope } from '../expr/evaluate';
import { renderTemplate } from '../expr/template';
import type { ErrorRule } from '../spec/types';
import type { ResponseView } from './response';

export interface Failure {
    kind: ErrorKind;
    message: string;
    retryable: boolean;
    /** A rule said `retryable: true` explicitly — retry even if the kind is not in `retry.on`. */
    forced?: boolean;
    status?: number;
}

export function defaultKind(status: number): ErrorKind | undefined {
    if (status < 400) return undefined;
    switch (status) {
        case 400:
        case 422:
            return 'validation';
        case 401:
            return 'auth';
        case 403:
            return 'forbidden';
        case 404:
            return 'notFound';
        case 409:
            return 'conflict';
        case 408:
            return 'transient';
        case 429:
            return 'rateLimited';
    }
    return status >= 500 ? 'transient' : 'fatal';
}

export const isRetryableKind = (kind: ErrorKind) => kind === 'transient' || kind === 'rateLimited';

/** A short, safe summary of an error body — never the whole thing. */
function remoteMessage(body: unknown): string | undefined {
    if (typeof body === 'string') return body.trim().slice(0, 200) || undefined;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const b = body as Record<string, unknown>;
        for (const key of ['error_description', 'message', 'error', 'detail', 'title']) {
            const v = b[key];
            if (typeof v === 'string' && v) return v.slice(0, 200);
            if (v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string') {
                return String((v as { message: string }).message).slice(0, 200);
            }
        }
    }
    return undefined;
}

export async function classify(view: ResponseView, rules: readonly ErrorRule[], scope: Scope, options: EvalOptions): Promise<Failure | undefined> {
    const withResponse = { ...scope, response: view };
    for (const rule of rules) {
        if (await renderTemplate(rule.when, withResponse, options)) {
            const message = rule.message === undefined ? undefined : display(await renderTemplate(rule.message, withResponse, options));
            return {
                kind: rule.error,
                message: message || `request failed with status ${view.status}`,
                retryable: rule.retryable ?? isRetryableKind(rule.error),
                forced: rule.retryable === true,
                status: view.status
            };
        }
    }
    const kind = defaultKind(view.status);
    if (!kind) return undefined;
    const detail = remoteMessage(view.body);
    return {
        kind,
        message: `request failed with status ${view.status}${detail ? `: ${detail}` : ''}`,
        retryable: isRetryableKind(kind),
        status: view.status
    };
}
