/**
 * `@sigx/conduit` — declarative, pluggable connectors.
 *
 * This entry is isomorphic: it runs on any WinterCG runtime (fetch +
 * WebCrypto) and imports nothing from Node.
 */
export * from './spec';
export {
    ConduitError,
    ConduitSpecError,
    ConduitExpressionError,
    ConduitValidationError,
    ConduitRequestError,
    ConduitRateLimitError,
    ConduitAuthError,
    isConduitError,
    type ErrorKind,
    type Diagnostic,
    type InputIssue,
    type ConduitErrorOptions
} from './errors';
