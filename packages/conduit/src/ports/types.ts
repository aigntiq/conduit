/**
 * Ports — the interfaces through which Conduit reaches everything
 * host-specific. Core ships an in-memory or default implementation of each
 * (`./memory.ts`, `./cipher.ts`); real backends ship as `@sigx/conduit-*`
 * adapter packages and must pass the conformance suites in `./testing`.
 */

/**
 * A connected account, as stored. `credentials` is SEALED — an opaque string
 * produced by the `SecretCipher` — so a store never holds a usable secret.
 */
export interface StoredAccount {
    id: string;
    /** Opaque owner key chosen by the host: a user, tenant, workspace… */
    owner: string;
    connector: string;
    /** Auth method id within the connector. */
    method: string;
    status: AccountStatus;
    externalId?: string;
    displayName?: string;
    /** Non-secret data captured by the method's `identity.data`. */
    data?: Record<string, unknown>;
    /** Sealed `Credentials`. */
    credentials: string;
    /** When the current access credential expires (epoch ms), if it does. */
    expiresAt?: number;
    createdAt: number;
    updatedAt: number;
    /** Incremented on every write; `AccountStore.update` compares it. */
    version: number;
}

export type AccountStatus = 'active' | 'needsReauth';

export interface AccountFilter {
    owner?: string;
    connector?: string;
}

export interface AccountStore {
    get(id: string): Promise<StoredAccount | undefined>;
    list(filter?: AccountFilter): Promise<StoredAccount[]>;
    /** Insert a new account. Rejects if the id exists. */
    create(account: StoredAccount): Promise<void>;
    /**
     * Replace an account iff its stored `version` equals `expectedVersion`
     * (compare-and-set). Returns false on a version mismatch or a missing
     * account — never throws for either.
     */
    update(account: StoredAccount, expectedVersion: number): Promise<boolean>;
    delete(id: string): Promise<boolean>;
}

/** Short-lived, single-use values: OAuth state and PKCE verifiers. */
export interface TransientStore {
    put(key: string, value: string, ttlMs: number): Promise<void>;
    /** Read AND delete. Expired values read as undefined. */
    take(key: string): Promise<string | undefined>;
}

/**
 * Mutual exclusion per key — used so a token is refreshed exactly once even
 * when many calls (or many processes, with a distributed provider) race.
 */
export interface LockProvider {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Encrypts credentials at rest. Swap in a KMS-backed cipher in production. */
export interface SecretCipher {
    seal(plaintext: string): Promise<string>;
    open(sealed: string): Promise<string>;
}

/** A `fetch`-compatible function. */
export type HttpClient = (request: Request) => Promise<Response>;

/** Decrypted credentials — only ever held in memory, for the duration of a call. */
export interface Credentials {
    /** What the owner entered when connecting (API keys, usernames, …). */
    values: Record<string, unknown>;
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    scope?: string;
    /** Epoch ms. */
    expiresAt?: number;
    /** Extra values from a token mapping's `data`, readable as `auth.<key>`. */
    extra?: Record<string, unknown>;
}

/** An OAuth client registration. */
export interface OAuthClient {
    id: string;
    secret?: string;
}

export interface ClientLookup {
    connector: string;
    method: string;
    owner?: string;
}

export type ClientResolver = (lookup: ClientLookup) => OAuthClient | undefined | Promise<OAuthClient | undefined>;
