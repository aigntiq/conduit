/**
 * Connector, auth and operation builders. Every builder returns plain
 * `conduit/1` JSON; the TypeScript types of each operation's inputs and
 * output ride along as a phantom `~types` property (never present at
 * runtime) so `createConduit<CatalogOf<…>>()` can type `execute`.
 */
import type {
    ApiKeyMethod,
    AuthMethod,
    BasicMethod,
    BearerMethod,
    ConnectorFunction,
    ConnectorSpec,
    CustomMethod,
    ErrorRule,
    HttpDefaults,
    InputRule,
    JwtMethod,
    OAuth2Method,
    OperationSpec,
    PaginateSpec,
    PollTrigger,
    RequestSpec,
    RetryPolicy,
    StepSpec,
    WebhookTrigger
} from '../spec/types';
import { SPEC_VERSION } from '../spec/types';
import { toInputSchema, type Field, type Fields, type InferFields } from './fields';
import { isRef, ref, toTemplate, toTemplateString, type AnyRef, type Ref } from './refs';

// ── Scopes ──────────────────────────────────────────────────────────────

/** What request templates can read. */
export interface RequestScope<I> {
    inputs: Ref<I>;
    auth: AnyRef;
    account: AnyRef;
    config: AnyRef;
    env: AnyRef;
    steps: AnyRef;
    page: AnyRef;
}

/** What response-side templates (output, errors, paging, step output) can read. */
export interface ResultScope<I> extends RequestScope<I> {
    response: AnyRef;
    items: AnyRef;
}

/** Every root, untyped — for auth definitions, whose scopes vary by field. */
export interface AuthScope {
    inputs: AnyRef;
    auth: AnyRef;
    account: AnyRef;
    config: AnyRef;
    env: AnyRef;
    oauth: AnyRef;
    client: AnyRef;
    response: AnyRef;
    token: AnyRef;
    steps: AnyRef;
    jwt: AnyRef;
    now: AnyRef;
}

const ROOTS = ['inputs', 'auth', 'account', 'config', 'env', 'steps', 'page', 'response', 'items', 'oauth', 'client', 'token', 'jwt', 'now', 'request', 'subscription', 'state', 'item'];

function scope(): Record<string, unknown> {
    return Object.fromEntries(ROOTS.map((r) => [r, ref(r)]));
}

/** A value, or a function of the scope producing it. */
export type Built<T, S> = T | ((scope: S) => T);

function build<T, S>(value: Built<T, S> | undefined): T | undefined {
    if (value === undefined) return undefined;
    // Refs are proxies over a function: never call one as a scope builder.
    return typeof value === 'function' && !isRef(value) ? (value as (s: S) => T)(scope() as S) : (value as T);
}

/** A template-ish value: a string, a ref, an expr, or JSON containing them. */
type T = string | number | boolean | null | object;

/**
 * A spec type whose template-string fields (typed exactly `string`) also
 * accept refs and expressions. Literal unions (`'validation' | …`) stay strict.
 */
export type Templated<X> = string extends X
    ? X | T
    : X extends readonly (infer I)[]
      ? readonly Templated<I>[]
      : X extends object
        ? { [K in keyof X]: Templated<X[K]> }
        : X;

export interface RequestDef {
    method?: RequestSpec['method'];
    url: T;
    query?: T;
    headers?: Record<string, T>;
    body?: T;
    encoding?: RequestSpec['encoding'];
    responseType?: RequestSpec['responseType'];
    timeoutMs?: number;
    auth?: boolean;
}

export interface StepDef extends RequestDef {
    name: string;
    when?: T;
    output?: T;
}

export interface ErrorRuleDef {
    when: T;
    error: ErrorRule['error'];
    message?: T;
    retryable?: boolean;
    field?: string;
}

function compileRequest(def: RequestDef): RequestSpec {
    const out = toTemplate({ ...def, url: undefined }) as RequestSpec;
    out.url = toTemplateString(def.url);
    return out;
}

function compileStep(def: StepDef): StepSpec {
    const { when, output, ...request } = def;
    const step = { ...compileRequest(request), name: def.name } as StepSpec;
    if (when !== undefined) step.when = toTemplateString(when);
    if (output !== undefined) step.output = toTemplate(output);
    return step;
}

function compileErrors(defs: ErrorRuleDef[] | undefined): ErrorRule[] | undefined {
    return defs?.map((d) => {
        const rule: ErrorRule = { when: toTemplateString(d.when), error: d.error };
        if (d.message !== undefined) rule.message = toTemplateString(d.message);
        if (d.retryable !== undefined) rule.retryable = d.retryable;
        if (d.field !== undefined) rule.field = d.field;
        return rule;
    });
}

// ── Operations ──────────────────────────────────────────────────────────

export interface OperationTypes<I, O> {
    inputs: I;
    output: O;
}

export interface BuiltOperation<Id extends string = string, I = unknown, O = unknown> {
    readonly id: Id;
    readonly spec: OperationSpec;
    readonly '~types'?: OperationTypes<I, O>;
}

interface OperationCommon<F extends Fields, O> {
    label: string;
    description?: string;
    group?: string;
    destructive?: boolean;
    readOnly?: boolean;
    helpUrl?: string;
    hidden?: boolean;
    tags?: string[];
    /** Auth method ids this works with (default: any), or `false`. */
    auth?: string[] | false;
    inputs?: F;
    /** Cross-field rules; see `rules.*`. */
    rules?: InputRule[];
    /** The output's shape — documents it and types `execute`. */
    outputs?: Field<O, boolean>;
    steps?: Built<StepDef[], ResultScope<InferFields<F>>>;
    output?: Built<T, ResultScope<InferFields<F>>>;
    errors?: Built<ErrorRuleDef[], ResultScope<InferFields<F>>>;
    retry?: RetryPolicy | false;
}

interface RequestOperationDef<F extends Fields, O> extends OperationCommon<F, O> {
    request: Built<RequestDef, RequestScope<InferFields<F>>>;
}

interface PagedOperationDef<F extends Fields, O> extends RequestOperationDef<F, O> {
    paginate?: Built<PaginateSpec, ResultScope<InferFields<F>>>;
}

function compileCommon<F extends Fields, O>(id: string, kind: OperationSpec['kind'], def: OperationCommon<F, O>): Record<string, unknown> {
    const spec: Record<string, unknown> = { id, kind, label: def.label };
    const copy = ['description', 'group', 'destructive', 'readOnly', 'helpUrl', 'hidden', 'tags', 'auth', 'retry'] as const;
    for (const key of copy) if (def[key] !== undefined) spec[key] = def[key];
    if (def.inputs) spec.inputs = toInputSchema(def.inputs, def.rules);
    if (def.outputs) spec.outputs = def.outputs.property;
    const steps = build(def.steps);
    if (steps?.length) spec.steps = steps.map(compileStep);
    const errors = compileErrors(build(def.errors));
    if (errors?.length) spec.errors = errors;
    const output = build(def.output);
    if (output !== undefined) spec.output = toTemplate(output);
    return spec;
}

function operation<Id extends string, I, O>(id: Id, spec: Record<string, unknown>): BuiltOperation<Id, I, O> {
    return { id, spec: spec as unknown as OperationSpec };
}

type OutputOf<O> = unknown extends O ? unknown : O;

export function action<const Id extends string, F extends Fields = Record<never, never>, O = unknown>(
    id: Id,
    def: RequestOperationDef<F, O>
): BuiltOperation<Id, InferFields<F>, OutputOf<O>> {
    const spec = compileCommon(id, 'action', def);
    spec.request = compileRequest(build(def.request)!);
    return operation(id, spec);
}

export function search<const Id extends string, F extends Fields = Record<never, never>, O = unknown>(
    id: Id,
    def: PagedOperationDef<F, O>
): BuiltOperation<Id, InferFields<F>, OutputOf<O>> {
    const spec = compileCommon(id, 'search', def);
    spec.request = compileRequest(build(def.request)!);
    const paginate = build(def.paginate);
    if (paginate) spec.paginate = paginate;
    return operation(id, spec);
}

export function options<const Id extends string, F extends Fields = Record<never, never>>(
    id: Id,
    def: PagedOperationDef<F, unknown>
): BuiltOperation<Id, InferFields<F>, { label: string; value: unknown }[]> {
    const spec = compileCommon(id, 'options', def);
    spec.request = compileRequest(build(def.request)!);
    const paginate = build(def.paginate);
    if (paginate) spec.paginate = paginate;
    return operation(id, spec);
}

export interface PollTriggerDef<F extends Fields, O> extends OperationCommon<F, O> {
    intervalSec?: number;
    request: Built<RequestDef, RequestScope<InferFields<F>> & { state: AnyRef }>;
    items: Built<T, ResultScope<InferFields<F>> & { state: AnyRef }>;
    cursor?: Built<T, ResultScope<InferFields<F>> & { state: AnyRef }>;
    dedupeKey: Built<T, ResultScope<InferFields<F>> & { state: AnyRef; item: AnyRef }>;
    event?: Built<T, ResultScope<InferFields<F>> & { state: AnyRef; item: AnyRef }>;
}

export function pollTrigger<const Id extends string, F extends Fields = Record<never, never>, O = unknown>(
    id: Id,
    def: PollTriggerDef<F, O>
): BuiltOperation<Id, InferFields<F>, OutputOf<O>> {
    const spec = compileCommon(id, 'trigger', def);
    const trigger: PollTrigger = {
        type: 'poll',
        request: compileRequest(build(def.request)!),
        items: toTemplateString(build(def.items)),
        dedupeKey: toTemplateString(build(def.dedupeKey))
    };
    if (def.intervalSec !== undefined) trigger.intervalSec = def.intervalSec;
    const cursor = build(def.cursor);
    if (cursor !== undefined) trigger.cursor = toTemplateString(cursor);
    const event = build(def.event);
    if (event !== undefined) trigger.event = toTemplate(event);
    spec.trigger = trigger;
    return operation(id, spec);
}

export function webhookTrigger<const Id extends string, F extends Fields = Record<never, never>, O = unknown>(
    id: Id,
    def: OperationCommon<F, O> & { trigger: Built<Templated<Omit<WebhookTrigger, 'type'>>, AuthScope & { request: AnyRef; subscription: AnyRef }> }
): BuiltOperation<Id, InferFields<F>, OutputOf<O>> {
    const spec = compileCommon(id, 'trigger', def);
    spec.trigger = { type: 'webhook', ...(toTemplate(build(def.trigger)) as object) };
    return operation(id, spec);
}

// ── Paging, auth, connector ─────────────────────────────────────────────

type PagingDef = Omit<PaginateSpec, 'style' | 'items' | 'next' | 'hasMore'> & { items: T; next?: T; hasMore?: T };

function paginate(style: PaginateSpec['style'], def: PagingDef): PaginateSpec {
    const { items, next, hasMore, ...rest } = def;
    const spec: PaginateSpec = { style, ...rest, items: toTemplateString(items) };
    if (next !== undefined) spec.next = toTemplateString(next);
    if (hasMore !== undefined) spec.hasMore = toTemplateString(hasMore);
    return spec;
}

export const paging = {
    cursor: (def: PagingDef & { param: string; next: T }) => paginate('cursor', def),
    offset: (def: PagingDef & { param: string }) => paginate('offset', def),
    page: (def: PagingDef & { param: string }) => paginate('page', def),
    nextUrl: (def: PagingDef & { next: T }) => paginate('nextUrl', def),
    linkHeader: (def: PagingDef) => paginate('linkHeader', def)
};

type AuthDef<M extends AuthMethod> = Templated<Omit<M, 'id' | 'type' | 'inputs'>> & { inputs?: Fields };

function authMethod<M extends AuthMethod>(id: string, type: M['type'], def: Built<AuthDef<M>, AuthScope>): M {
    const { inputs, ...rest } = build(def) as { inputs?: Fields } & Record<string, unknown>;
    const method = { id, type, ...(toTemplate(rest) as object) } as M;
    if (inputs) method.inputs = toInputSchema(inputs);
    return method;
}

export const auth = {
    oauth2: (id: string, def: Built<AuthDef<OAuth2Method>, AuthScope>) => authMethod<OAuth2Method>(id, 'oauth2', def),
    apiKey: (id: string, def: Built<AuthDef<ApiKeyMethod>, AuthScope>) => authMethod<ApiKeyMethod>(id, 'apiKey', def),
    basic: (id: string, def: Built<AuthDef<BasicMethod>, AuthScope> = {}) => authMethod<BasicMethod>(id, 'basic', def),
    bearer: (id: string, def: Built<AuthDef<BearerMethod>, AuthScope> = {}) => authMethod<BearerMethod>(id, 'bearer', def),
    jwt: (id: string, def: Built<AuthDef<JwtMethod>, AuthScope>) => authMethod<JwtMethod>(id, 'jwt', def),
    custom: (id: string, def: Built<AuthDef<CustomMethod>, AuthScope>) => authMethod<CustomMethod>(id, 'custom', def)
};

type OpsTypes<Ops extends readonly BuiltOperation[]> = {
    [O in Ops[number] as O['id']]: NonNullable<O['~types']>;
};

export type BuiltConnector<Id extends string = string, Ops = Record<string, OperationTypes<unknown, unknown>>> = ConnectorSpec & {
    readonly id: Id;
    readonly '~types'?: Ops;
};

export interface ConnectorDef<Id extends string, Ops extends readonly BuiltOperation[]> {
    id: Id;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    homepage?: string;
    helpUrl?: string;
    brandColor?: string;
    categories?: string[];
    config?: Record<string, unknown>;
    http?: Built<Templated<HttpDefaults>, AuthScope>;
    functions?: Record<string, ConnectorFunction>;
    auth?: AuthMethod[];
    operations: Ops;
}

/** Assemble a connector. The result is plain `conduit/1` JSON. */
export function connector<const Id extends string, const Ops extends readonly BuiltOperation[]>(def: ConnectorDef<Id, Ops>): BuiltConnector<Id, OpsTypes<Ops>> {
    const { operations, http, auth: methods, ...meta } = def;
    const spec: Record<string, unknown> = { spec: SPEC_VERSION, ...meta };
    const h = build(http);
    if (h) spec.http = toTemplate(h);
    if (methods?.length) spec.auth = methods;
    spec.operations = operations.map((o) => o.spec);
    return spec as unknown as BuiltConnector<Id, OpsTypes<Ops>>;
}
