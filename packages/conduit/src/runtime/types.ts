/** Public runtime types. */
import type { TraceEntry } from '../http/perform';
import type { AccountStatus } from '../ports/types';
import type { AuthType, InputSchema, JsonSchema, OperationKind } from '../spec/types';

/** An account as hosts see it — never includes credentials. */
export interface AccountInfo {
    id: string;
    owner: string;
    connector: string;
    method: string;
    status: AccountStatus;
    externalId?: string;
    displayName?: string;
    data?: Record<string, unknown>;
    /** Epoch ms the current access credential expires, if it does. */
    expiresAt?: number;
    createdAt: number;
    updatedAt: number;
}

/** Per operation id: its inputs and output types. */
export type OperationTypesMap = Record<string, { inputs: Record<string, unknown>; output: unknown }>;

/**
 * Per connector id: its operations' types. The default is untyped;
 * `createConduit<CatalogOf<typeof gmail | typeof acme>>()` makes `execute`
 * check connector ids, operation ids, inputs and outputs.
 */
export type Catalog = Record<string, OperationTypesMap>;

/** Build a catalog from builder-authored (or emitted) connector types. */
export type CatalogOf<C> = {
    [K in C as K extends { readonly id: infer Id extends string } ? Id : never]: K extends { readonly '~types'?: infer Ops } ? NonNullable<Ops> : never;
};

type InputsOf<I> = Record<string, never> extends I ? { inputs?: I } : { inputs: I };

interface ExecuteBase<K extends string, O extends string> {
    connector: K;
    operation: O;
    /** Account id. Required unless the operation declares `auth: false` or the connector has no auth. */
    account?: string;
    /** When given, the account must belong to this owner. */
    owner?: string;
    /** Extra `env` values for this call, merged over the host's. */
    env?: Record<string, unknown>;
    signal?: AbortSignal;
    /**
     * Pagination control for `search`/`options`. Default `all` (follow up to
     * `maxPages`). `page` fetches one page starting at `cursor` and returns
     * `next` to resume from.
     */
    paging?: { mode?: 'all' | 'page'; cursor?: unknown; maxPages?: number };
}

export type ExecuteRequest<
    Cat extends Catalog = Catalog,
    K extends keyof Cat & string = keyof Cat & string,
    O extends keyof Cat[K] & string = keyof Cat[K] & string
> = ExecuteBase<K, O> & InputsOf<Cat[K][O]['inputs']>;

export interface ExecuteResult<Out = unknown> {
    output: Out;
    /** In `page` mode: where the next page starts, or undefined at the end. */
    next?: unknown;
    pages?: number;
    trace: TraceEntry[];
}

export interface OptionItem {
    label: string;
    value: unknown;
    [extra: string]: unknown;
}

export interface ConnectorSummary {
    id: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    categories?: string[];
}

export interface AuthMethodDescription {
    id: string;
    type: AuthType;
    label: string;
    description?: string;
    /** What the owner must enter to connect (or before the redirect). */
    inputs: InputSchema;
    /** True when connecting goes through a browser redirect (`auth.begin` returns a URL). */
    redirect: boolean;
}

export interface OperationDescription {
    id: string;
    kind: OperationKind;
    label: string;
    description?: string;
    inputs?: InputSchema;
    outputs?: JsonSchema;
    /** Auth method ids, or false when no credentials are used. */
    auth: string[] | false;
    hidden: boolean;
    tags?: string[];
    /** Catalog grouping, e.g. "Messages". */
    group?: string;
    /** Deletes or irreversibly changes data — confirm before running. */
    destructive?: boolean;
    /** Only reads — safe to run without confirmation. */
    readOnly?: boolean;
    helpUrl?: string;
}

export interface ConnectorDescription extends ConnectorSummary {
    auth: AuthMethodDescription[];
    operations: OperationDescription[];
}
