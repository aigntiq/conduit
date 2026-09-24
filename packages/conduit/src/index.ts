/**
 * `@aigntiq/conduit` — declarative, pluggable connectors.
 *
 * This entry is isomorphic: it runs on any WinterCG runtime (fetch +
 * WebCrypto) and imports nothing from Node.
 */
export * from './spec';
export * from './runtime';
export * from './ports';
export { HostGuard } from './http/guard';
export type { RequestMiddleware, RequestInfo, TraceEntry } from './http/perform';
export type { BodyEncoder } from './http/request';
export type { ResponseView } from './http/response';
export {
    ConduitError,
    ConduitSpecError,
    ConduitExpressionError,
    ConduitValidationError,
    ConduitRequestError,
    ConduitRateLimitError,
    ConduitAuthError,
    ConduitPolicyError,
    isConduitError,
    type ErrorKind,
    type Diagnostic,
    type InputIssue,
    type ConduitErrorOptions
} from './errors';
