/**
 * `@aigntiq/conduit/builder` — author connectors in TypeScript. Every builder
 * returns plain `conduit/1` JSON; types carry from the declared inputs into
 * the templates (a misspelled input is a compile error) and out to typed
 * `execute` calls.
 *
 *     import { action, connector, email, $ } from '@aigntiq/conduit/builder';
 *
 *     export default connector({
 *         id: 'acme', name: 'Acme', version: '1.0.0',
 *         http: { baseUrl: 'https://api.acme.example' },
 *         operations: [
 *             action('get-contact', {
 *                 label: 'Get contact',
 *                 inputs: { id: string() },
 *                 request: ({ inputs }) => ({ url: $`/contacts/${inputs.id}` })
 *             })
 *         ]
 *     });
 */
export { $, expr, ref, isRef, toTemplate, type Ref, type AnyRef, type Expr } from './refs';
export {
    string,
    text,
    richtext,
    email,
    url,
    date,
    datetime,
    secret,
    select,
    number,
    integer,
    boolean,
    array,
    emails,
    file,
    files,
    object,
    json,
    when,
    rules,
    toInputSchema,
    type Field,
    type Fields,
    type FieldValue,
    type InferFields,
    type FileValue,
    type CommonOptions,
    type StringOptions,
    type NumberOptions,
    type ArrayOptions,
    type FileOptions,
    type DynamicOptions
} from './fields';
export {
    connector,
    action,
    search,
    options,
    pollTrigger,
    webhookTrigger,
    paging,
    auth,
    type BuiltConnector,
    type BuiltOperation,
    type OperationTypes,
    type ConnectorDef,
    type RequestDef,
    type StepDef,
    type StepScope,
    type ErrorRuleDef,
    type RequestScope,
    type ResultScope,
    type AuthScope,
    type Built
} from './connector';
export { emitTypes, operationTypes } from './emit';
