/**
 * Conduit's error model.
 *
 * Every error the runtime throws on purpose is a `ConduitError` with a stable
 * `code`, so hosts can branch on `err.code` (or `isConduitError`) without
 * string-matching messages. Errors that describe a remote failure carry the
 * classified `kind` — the same vocabulary a connector's `errors` rules use.
 */

/** How a failed remote call is classified. */
export type ErrorKind =
    | 'auth'
    | 'forbidden'
    | 'notFound'
    | 'rateLimited'
    | 'validation'
    | 'conflict'
    | 'transient'
    | 'fatal';

export interface ConduitErrorOptions {
    cause?: unknown;
    details?: Record<string, unknown>;
}

export class ConduitError extends Error {
    /** Stable, machine-readable error code. */
    readonly code: string;
    readonly details: Record<string, unknown> | undefined;

    constructor(code: string, message: string, options: ConduitErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'ConduitError';
        this.code = code;
        this.details = options.details;
    }
}

/** A connector spec is malformed or references something that does not exist. */
export class ConduitSpecError extends ConduitError {
    readonly diagnostics: readonly Diagnostic[];

    constructor(message: string, diagnostics: readonly Diagnostic[] = [], options: ConduitErrorOptions = {}) {
        super('spec_invalid', message, options);
        this.name = 'ConduitSpecError';
        this.diagnostics = diagnostics;
    }
}

/** An expression failed to parse or evaluate. */
export class ConduitExpressionError extends ConduitError {
    /** The expression source (without the `{{ }}` delimiters). */
    readonly source: string;
    /** Offset into `source` where the problem was detected, when known. */
    readonly position: number | undefined;

    constructor(message: string, source: string, position?: number, options: ConduitErrorOptions = {}) {
        super('expression_error', message, options);
        this.name = 'ConduitExpressionError';
        this.source = source;
        this.position = position;
    }
}

/** Caller-supplied inputs do not satisfy the operation's (or auth method's) input schema. */
export class ConduitValidationError extends ConduitError {
    readonly issues: readonly InputIssue[];

    constructor(message: string, issues: readonly InputIssue[], options: ConduitErrorOptions = {}) {
        super('inputs_invalid', message, options);
        this.name = 'ConduitValidationError';
        this.issues = issues;
    }
}

/** A remote call failed. `kind` is the classification; `status` the HTTP status, if any. */
export class ConduitRequestError extends ConduitError {
    readonly kind: ErrorKind;
    readonly status: number | undefined;
    readonly retryable: boolean;
    /** The parsed response body, when there was one. May contain remote detail. */
    readonly body: unknown;
    /** Set when an error rule attributed the failure to an input (`field`). */
    readonly issues: readonly InputIssue[] | undefined;

    constructor(
        kind: ErrorKind,
        message: string,
        init: { status?: number; retryable?: boolean; body?: unknown; issues?: InputIssue[] } & ConduitErrorOptions = {}
    ) {
        super(`request_${kind}`, message, init);
        this.name = 'ConduitRequestError';
        this.kind = kind;
        this.status = init.status;
        this.retryable = init.retryable ?? (kind === 'transient' || kind === 'rateLimited');
        this.body = init.body;
        this.issues = init.issues;
    }
}

/** The remote refused to proceed until the caller slows down. */
export class ConduitRateLimitError extends ConduitRequestError {
    /** Milliseconds the remote asked us to wait, when it said. */
    readonly retryAfterMs: number | undefined;

    constructor(message: string, init: { status?: number; body?: unknown; retryAfterMs?: number } & ConduitErrorOptions = {}) {
        super('rateLimited', message, { ...init, retryable: true });
        this.name = 'ConduitRateLimitError';
        this.retryAfterMs = init.retryAfterMs;
    }
}

/**
 * The account cannot authenticate. When `needsReauth` is true, no amount of
 * retrying or refreshing will help — the owner has to connect again.
 */
export class ConduitAuthError extends ConduitError {
    readonly needsReauth: boolean;
    readonly accountId: string | undefined;

    constructor(message: string, init: { needsReauth?: boolean; accountId?: string } & ConduitErrorOptions = {}) {
        super('auth_failed', message, init);
        this.name = 'ConduitAuthError';
        this.needsReauth = init.needsReauth ?? true;
        this.accountId = init.accountId;
    }
}

/** A located problem in a connector spec. */
export interface Diagnostic {
    /** JSON-pointer-ish path into the spec, e.g. `operations[2].request.url`. */
    path: string;
    code: string;
    message: string;
    severity: 'error' | 'warning';
}

/** A located problem in caller-supplied inputs. */
export interface InputIssue {
    path: string;
    message: string;
    /** Machine-readable reason: `required`, `format`, `minLength`, `rule`, `remote`, … */
    code?: string;
    params?: Record<string, unknown>;
}

export function isConduitError(value: unknown): value is ConduitError {
    return value instanceof ConduitError;
}
