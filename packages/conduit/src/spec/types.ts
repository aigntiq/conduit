/**
 * The `conduit/1` connector specification, as TypeScript types.
 *
 * A **connector** describes one third-party API: how to authenticate
 * (`auth`), what can be done with it (`operations`), and how every request is
 * built and every response mapped. All dynamic values are **templates** —
 * JSON values whose strings may contain `{{ expression }}` — evaluated
 * against a scope that depends on where the template sits (see
 * `docs/spec-reference.md#scope`).
 *
 * The canonical machine-readable form is the JSON Schema exported from
 * `@aigntiq/conduit/schema`; these types and that schema describe the same shape.
 */
import type { ErrorKind } from '../errors';
import type { JwtAlgorithm } from '../util/crypto';

export const SPEC_VERSION = 'conduit/1' as const;

/**
 * A JSON value whose strings may contain `{{ }}` expressions. A string that
 * is exactly one expression evaluates to that expression's raw value.
 */
export type Template = unknown;

/** A template string, e.g. `"{{ response.status == 404 }}"`. */
export type TemplateString = string;

export interface ConnectorSpec {
    /** Always `"conduit/1"`. */
    spec: typeof SPEC_VERSION;
    /** Stable identifier: lower-case letters, digits and dashes. */
    id: string;
    name: string;
    /** The connector's own version (semver). */
    version: string;
    description?: string;
    /** URL or `data:` URI. `fileSource` inlines a relative path as a data URI. */
    icon?: string;
    homepage?: string;
    categories?: string[];
    /** Brand colour for UIs, `#rrggbb`. */
    brandColor?: string;
    helpUrl?: string;
    /** Static, non-secret configuration, readable as `{{ config.x }}`. */
    config?: Record<string, unknown>;
    /** Defaults applied to every request this connector makes. */
    http?: HttpDefaults;
    /** Reusable expression functions, callable from any template in this connector. */
    functions?: Record<string, ConnectorFunction>;
    /** Ways to authenticate. Absent or empty: the API needs no credentials. */
    auth?: AuthMethod[];
    operations: OperationSpec[];
}

export interface ConnectorFunction {
    params: string[];
    /** A bare expression (no `{{ }}`) over the params. */
    body: string;
    description?: string;
}

// ── HTTP ────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface HttpDefaults {
    /** Base URL that relative request URLs are resolved against. A template. */
    baseUrl?: TemplateString;
    headers?: Record<string, Template>;
    query?: Record<string, Template>;
    /** Per-attempt timeout. Default 30 000. */
    timeoutMs?: number;
    retry?: RetryPolicy;
    /** Classification rules checked (after the operation's own) on every response. */
    errors?: ErrorRule[];
    /**
     * Hosts requests may go to besides the `baseUrl` host and the hosts of
     * declared auth endpoints. `*.example.com` matches subdomains.
     */
    allowHosts?: string[];
}

export interface RetryPolicy {
    /** Total attempts including the first. Default 3; 1 disables retries. */
    attempts?: number;
    /** Default 500. */
    initialDelayMs?: number;
    /** Default 30 000. Also caps an honoured `Retry-After`. */
    maxDelayMs?: number;
    /** Exponential factor. Default 2. */
    factor?: number;
    /** Which classified failures retry. Default `["rateLimited", "transient"]`. */
    on?: ErrorKind[];
}

export interface ErrorRule {
    /** Scope: `response` plus the request scope. Truthy → this rule applies. */
    when: TemplateString;
    error: ErrorKind;
    /** Message template. Default: a generic message with the status. */
    message?: TemplateString;
    /** Override whether this failure is retried. */
    retryable?: boolean;
    /** Attribute a `validation` failure to this input, so forms can show it on the field. */
    field?: string;
}

export type RequestEncoding = 'json' | 'form' | 'multipart' | 'text' | 'binary';
export type ResponseType = 'auto' | 'json' | 'text' | 'binary';

export interface RequestSpec {
    /** Default `GET`. May be a template. */
    method?: HttpMethod | TemplateString;
    /** Relative URLs resolve against `http.baseUrl`. */
    url: TemplateString;
    /** An object of params (array values repeat the key), or a template producing one. */
    query?: Record<string, Template> | TemplateString;
    headers?: Record<string, Template>;
    body?: Template;
    /** How `body` is sent. Default `json`. Plugins may register more encodings. */
    encoding?: RequestEncoding | (string & {});
    /** How the response body is read. Default `auto` (by `Content-Type`). */
    responseType?: ResponseType;
    timeoutMs?: number;
    /** Apply the account's credentials. Default true. */
    auth?: boolean;
}

/** A named request that runs before the main one; its result is `steps.<name>`. */
export interface StepSpec extends RequestSpec {
    name: string;
    /** Skip the step unless truthy. */
    when?: TemplateString;
    /** What `steps.<name>` holds. Default: the response body. Scope adds `response`. */
    output?: Template;
    /**
     * Run the step once per item of this list (operation steps only). `when`,
     * the request and `output` also see `each` (the item) and `index`;
     * `steps.<name>` becomes the list of outputs (`null` where `when` skipped).
     */
    forEach?: TemplateString;
    /** The most items `forEach` may take. Default 100. */
    maxIterations?: number;
}

// ── Inputs ──────────────────────────────────────────────────────────────

export type InputType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

/** A JSON Schema (2020-12) subset, plus `x-` UI hints. */
/** The closed widget vocabulary renderers implement. See docs/ui-hints.md. */
export const WIDGETS = [
    'text',
    'textarea',
    'richtext',
    'markdown',
    'code',
    'password',
    'number',
    'toggle',
    'select',
    'multiselect',
    'combobox',
    'date',
    'datetime',
    'email',
    'url',
    'emails',
    'file',
    'json',
    'keyvalue',
    'list',
    'fieldset',
    'hidden'
] as const;
export type Widget = (typeof WIDGETS)[number];

/**
 * A condition over sibling inputs. Every key must hold (AND):
 * `{ mode: 'advanced' }`, `{ mode: { in: ['a', 'b'] } }`,
 * `{ threadId: { notEmpty: true } }`, `{ cc: { empty: true } }`.
 */
export type Condition = Record<string, unknown>;

/** A labelled choice (standard JSON Schema `oneOf` + `const` + `title`). */
export interface Choice {
    const: unknown;
    title?: string;
    description?: string;
}

/** A JSON Schema (2020-12) subset, plus `x-` UI hints. See docs/ui-hints.md. */
export interface InputProperty {
    type: InputType;
    title?: string;
    description?: string;
    default?: unknown;
    examples?: unknown[];
    readOnly?: boolean;
    deprecated?: boolean;
    enum?: unknown[];
    /** Labelled choices. Use instead of `enum` when values need display names. */
    oneOf?: Choice[];
    format?: string;
    items?: InputProperty;
    properties?: Record<string, InputProperty>;
    required?: string[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
    /** Masked in UIs and traces; stored sealed when it is an auth input. */
    'x-secret'?: boolean;
    /** How to render. Default: inferred from type and format. */
    'x-widget'?: Widget;
    'x-placeholder'?: string;
    /** Section the field belongs to. */
    'x-group'?: string;
    /** Sort key within its group; ties keep declaration order. */
    'x-order'?: number;
    /** Collapsed under "Advanced". */
    'x-advanced'?: boolean;
    /** Show (and validate, and send) only when this holds. */
    'x-visibleWhen'?: Condition;
    /** Required only when this holds. */
    'x-requiredWhen'?: Condition;
    /** Dynamic choices, from an `options` operation of this connector. */
    'x-options'?: {
        operation: string;
        /** Inputs for the options operation — templates over this form's `inputs`. */
        inputs?: Record<string, Template>;
        /** Fields whose change reloads the choices. */
        dependsOn?: string[];
        /** The options operation input that receives what the user types (searchable combobox). */
        search?: string;
    };
    /** `file` fields: accepted types (`image/*,.pdf`) and size cap. */
    'x-accept'?: string;
    'x-maxBytes'?: number;
    /** `code` fields: the language. */
    'x-language'?: string;
    /** Per-keyword message overrides: `{ pattern: "Must look like ABC-123" }`. */
    'x-errorMessage'?: Record<string, string>;
}

/** A cross-field rule, evaluated against `inputs`. */
export interface InputRule {
    /** Template; the inputs are valid when it is truthy. */
    check: TemplateString;
    message: string;
    /** Fields the message belongs to (UIs highlight them). */
    fields?: string[];
}

export interface InputSchema {
    type: 'object';
    properties: Record<string, InputProperty>;
    required?: string[];
    'x-rules'?: InputRule[];
}

export type JsonSchema = Record<string, unknown>;

// ── Auth ────────────────────────────────────────────────────────────────

/** Where credentials go on each request. Scope: `auth`, `account`, `config`, `env`. */
export interface ApplySpec {
    headers?: Record<string, Template>;
    query?: Record<string, Template>;
}

/** Who the account is — fetched after connecting. */
export interface IdentitySpec {
    /** Request to make with the new credentials. Omit to map from the token response alone. */
    request?: RequestSpec;
    /** Stable external id. Scope adds `response`. */
    id?: TemplateString;
    /** Human display name. */
    name?: TemplateString;
    /** Extra non-secret data kept on the account, readable as `account.data`. */
    data?: Template;
}

interface AuthMethodBase {
    id: string;
    label?: string;
    description?: string;
    /** Fields the owner provides when connecting. Each type has sensible defaults. */
    inputs?: InputSchema;
    /** Override where credentials go on requests. */
    apply?: ApplySpec;
    /** A request that succeeds only when the credentials work. */
    test?: RequestSpec;
    identity?: IdentitySpec;
    /** Refresh this many seconds before expiry. Default 60. */
    refreshSkewSec?: number;
    /** Markdown instructions for whoever sets this up (register an app, redirect URI, scopes, …). */
    setup?: string;
    helpUrl?: string;
}

/** How a token endpoint response maps onto credentials. Scope: `response` (the token response). */
export interface TokenMapping {
    accessToken?: TemplateString;
    refreshToken?: TemplateString;
    /** Seconds until expiry. */
    expiresIn?: TemplateString;
    /** Absolute expiry (ISO or epoch). Wins over `expiresIn`. */
    expiresAt?: TemplateString;
    tokenType?: TemplateString;
    scope?: TemplateString;
    /** Extra values stored with the credentials, readable as `auth.<key>`. */
    data?: Template;
}

export interface OAuth2Method extends AuthMethodBase {
    type: 'oauth2';
    /** Default `authorization_code`. */
    grant?: 'authorization_code' | 'client_credentials';
    /** Required for `authorization_code`. */
    authorizeUrl?: TemplateString;
    tokenUrl: TemplateString;
    /** Default: `tokenUrl`. */
    refreshUrl?: TemplateString;
    revokeUrl?: TemplateString;
    scopes?: string[];
    /** Default `" "`. */
    scopeSeparator?: string;
    /** Use PKCE (S256). Default true for `authorization_code`. */
    pkce?: boolean;
    /** How the client authenticates to the token endpoint. Default `body`. */
    clientAuth?: 'body' | 'basic';
    /** Extra authorize-URL parameters. */
    authorizeParams?: Record<string, Template>;
    /** Extra token-request parameters. */
    tokenParams?: Record<string, Template>;
    token?: TokenMapping;
    /**
     * Where the OAuth client comes from. Default: the host's client resolver,
     * falling back to `inputs.clientId` / `inputs.clientSecret`.
     */
    client?: { id?: TemplateString; secret?: TemplateString };
}

export interface ApiKeyMethod extends AuthMethodBase {
    type: 'apiKey';
    /** Default `header`. */
    in?: 'header' | 'query';
    /** Header or query parameter name. */
    name: string;
    /** Prepended to the value, e.g. `"Token "`. */
    prefix?: string;
    /** Default `"{{auth.apiKey}}"`. */
    value?: TemplateString;
}

export interface BasicMethod extends AuthMethodBase {
    type: 'basic';
}

export interface BearerMethod extends AuthMethodBase {
    type: 'bearer';
}

export interface JwtMethod extends AuthMethodBase {
    type: 'jwt';
    jwt: {
        algorithm: JwtAlgorithm;
        /** Secret (HS family) or PEM private key (RS and ES families). Scope: `auth`, `config`, `env`. */
        key: TemplateString;
        /** Claims. `iat`/`exp` are added unless present. Scope adds `now` (epoch seconds). */
        claims: Template;
        header?: Template;
        /** Token lifetime in seconds. Default 600. */
        lifetimeSec?: number;
    };
    /** Trade the signed JWT for an access token. Without it the JWT itself is the bearer token. */
    exchange?: { request: RequestSpec; token?: TokenMapping };
}

export interface CustomMethod extends AuthMethodBase {
    type: 'custom';
    /** Requests that mint credentials. Scope: `inputs` (connect inputs), `config`, `env`, `steps`. */
    steps?: StepSpec[];
    /** What to store as credentials, readable as `auth.*`. Default: the connect inputs. */
    credentials?: Template;
    /** Seconds until the minted credentials expire; they are re-minted then. */
    expiresIn?: TemplateString;
    apply: ApplySpec;
}

export type AuthMethod = OAuth2Method | ApiKeyMethod | BasicMethod | BearerMethod | JwtMethod | CustomMethod;
export type AuthType = AuthMethod['type'];

// ── Operations ──────────────────────────────────────────────────────────

export type OperationKind = 'action' | 'search' | 'options' | 'trigger';

interface OperationBase {
    /** Unique within the connector. `fileSource` defaults it to the file name. */
    id: string;
    label: string;
    description?: string;
    /** Auth method ids this operation works with. Default: any. `false`: no credentials. */
    auth?: string[] | false;
    inputs?: InputSchema;
    outputs?: JsonSchema;
    steps?: StepSpec[];
    output?: Template;
    errors?: ErrorRule[];
    /** Override the connector retry policy. `false` disables retries. */
    retry?: RetryPolicy | false;
    /** Hide from catalogs (still callable). `options` operations are hidden by default. */
    hidden?: boolean;
    tags?: string[];
    /** Catalog grouping, e.g. "Messages", "Labels". */
    group?: string;
    /** Deletes or irreversibly changes data — UIs ask for confirmation. */
    destructive?: boolean;
    /**
     * Has no side effects: it only reads. Hosts may run it without asking.
     * Absent means unknown, not "writes". Cannot be combined with `destructive`.
     */
    readOnly?: boolean;
    helpUrl?: string;
}

export interface ActionOperation extends OperationBase {
    kind: 'action';
    request: RequestSpec;
}

export interface PaginateSpec {
    style: 'cursor' | 'offset' | 'page' | 'nextUrl' | 'linkHeader';
    /** The items of one page. Scope adds `response`, `page`. */
    items: TemplateString;
    /** `cursor`: the next cursor. `nextUrl`: the next page URL. */
    next?: TemplateString;
    /** Stop unless truthy. Default: the page had items (and a `next`, where one applies). */
    hasMore?: TemplateString;
    /** Query parameter carrying the cursor / offset / page number. */
    param?: string;
    /** Items requested per page, sent as `pageSizeParam`. */
    pageSize?: number;
    pageSizeParam?: string;
    /** First offset (default 0) or page number (default 1). */
    start?: number;
    /** Default 10. */
    maxPages?: number;
    maxItems?: number;
}

export interface SearchOperation extends OperationBase {
    kind: 'search';
    request: RequestSpec;
    paginate?: PaginateSpec;
}

export interface OptionsOperation extends OperationBase {
    kind: 'options';
    request: RequestSpec;
    paginate?: PaginateSpec;
}

export type VerifySpec =
    | {
          type: 'hmac';
          /** Header carrying the signature. */
          header: string;
          /** Default `sha256`. */
          algorithm?: 'sha1' | 'sha256' | 'sha512';
          /** Default `hex`. */
          encoding?: 'hex' | 'base64';
          /** Stripped from the header value, e.g. `"sha256="`. */
          prefix?: string;
          /** Default `"{{subscription.secret}}"`. */
          secret?: TemplateString;
          /** What is signed. Default: the raw body. Scope: `request`, `subscription`. */
          payload?: TemplateString;
          /** Reject deliveries whose timestamp header is older than `toleranceSec`. */
          timestampHeader?: string;
          toleranceSec?: number;
      }
    | { type: 'token'; header: string; value?: TemplateString }
    | { type: 'custom'; valid: TemplateString };

export interface WebhookTrigger {
    type: 'webhook';
    /** Register the callback. Scope: `inputs`, `auth`, `subscription` (`callbackUrl`, `secret`). */
    subscribe?: RequestSpec & { output?: Template };
    /** Scope adds `subscription.data` (what `subscribe.output` returned). */
    unsubscribe?: RequestSpec;
    renew?: { everyMinutes: number; request: RequestSpec };
    verify?: VerifySpec;
    /** Answer a delivery directly (e.g. a validation challenge) instead of emitting events. */
    handshake?: { when: TemplateString; respond: { status?: number; headers?: Record<string, Template>; body?: Template } };
    /** Emit only when truthy. Scope: `request`, `inputs`, `subscription`. */
    filter?: TemplateString;
    /** Event payload(s). A list emits one event per item. */
    event: Template;
    dedupeKey?: TemplateString;
}

export interface PollTrigger {
    type: 'poll';
    /** Default 300. */
    intervalSec?: number;
    /** Scope adds `state.cursor` (what `cursor` returned last time). */
    request: RequestSpec;
    items: TemplateString;
    cursor?: TemplateString;
    /** Identifies an item across polls so it is emitted once. */
    dedupeKey: TemplateString;
    event?: Template;
}

export interface TriggerOperation extends OperationBase {
    kind: 'trigger';
    trigger: WebhookTrigger | PollTrigger;
}

export type OperationSpec = ActionOperation | SearchOperation | OptionsOperation | TriggerOperation;

/** Identity function that gives a TypeScript-authored connector full typing. */
export function defineConnector<const T extends ConnectorSpec>(spec: T): T {
    return spec;
}
