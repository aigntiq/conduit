/**
 * `@aigntiq/conduit/expr` — the Conduit expression language.
 *
 * Usable on its own: nothing here knows about connectors, HTTP or auth.
 */
export type * from './ast';
export { tokenize, type Token, type TokenType } from './lexer';
export { parseExpression } from './parser';
export {
    Lambda,
    deepEqual,
    display,
    getMember,
    isPlainObject,
    type CallContext,
    type EvalOptions,
    type ExprFunction,
    type FunctionRegistry,
    type Scope
} from './evaluate';
export {
    compileExpression,
    compileTemplate,
    evaluateExpression,
    findExpressions,
    isTemplateString,
    renderTemplate,
    type CompiledTemplate,
    type ExpressionSegment,
    type TemplateSpan
} from './template';
export { STANDARD_FUNCTIONS, createFunctionRegistry, standardRegistry } from './stdlib';
export {
    analyzeExpression,
    analyzeTemplate,
    analyzeTemplateString,
    type AnalyzeOptions,
    type ExpressionAnalysis,
    type ExpressionIssue,
    type LocatedIssue
} from './analyze';
export { ConduitExpressionError } from '../errors';
