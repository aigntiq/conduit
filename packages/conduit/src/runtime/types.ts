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

export interface ExecuteRequest {
    connector: string;
    operation: string;
    /** Account id. Required unless the operation declares `auth: false` or the connector has no auth. */
    account?: string;
    /** When given, the account must belong to this owner. */
    owner?: string;
    inputs?: Record<string, unknown>;
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

export interface ExecuteResult {
    output: unknown;
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
}

export interface ConnectorDescription extends ConnectorSummary {
    auth: AuthMethodDescription[];
    operations: OperationDescription[];
}
