# Architecture

Conduit turns a **connector spec** (data) into working calls against a
third-party API. It does this without knowing anything about the host that
embeds it. This page covers how the pieces fit, the invariants that keep it
safe, and where extension happens.

```
                       ┌──────────────────────── @aigntiq/conduit ────────────────────────┐
  connector specs ───► │ ConnectorSource ─► registry (validate once, config, functions)│
                       │                                                                │
  host code ─────────► │ createConduit ─► auth flows ─┐                                 │
  (execute, connect)   │                accounts ─────┼─► request executor ─► fetch ───┼──► APIs
                       │                execute ──────┘   (guard, retry, redirects,     │
  browser ───────────► │ ./server  (Request → Response)     middleware, trace)          │
  (OAuth, options)     │ ./node    (Express/Connect bridge)                              │
                       │                                                                │
                       │ ports: AccountStore · TransientStore · LockProvider ·          │
                       │        SecretCipher · HttpClient · ClientResolver             │
                       └────────────────────────────────────────────────────────────────┘
```

## Layers

| Layer | Where | Knows about |
|---|---|---|
| Expressions | `src/expr` (`./expr`) | nothing else — usable alone |
| Spec | `src/spec`, `src/schema` (`./schema`) | expressions (for validation) |
| HTTP executor | `src/http` | expressions, spec types |
| OAuth helpers | `src/oauth` (`./oauth`) | nothing else — usable alone |
| Ports | `src/ports` | nothing |
| Runtime | `src/runtime` | all of the above |
| HTTP surface | `src/server` (`./server`), `src/node` (`./node`) | the runtime's public API only |

## Invariants

These are what reviews enforce.

1. **One request executor.** `performRequest` sends every outbound call: operations, steps, pages, token exchanges, refreshes, identity lookups, tests and revocations. Retries, the host guard, redirects, middleware, timeouts, classification and tracing therefore behave the same everywhere. Never add a second path that builds or sends a request.
2. **One credential path.** Only the account service (`src/runtime/accounts.ts`) opens, seals, stores or renews credentials. Everything that needs a usable credential calls `ensureFresh`.
3. **Zero runtime dependencies, no Node in core.** Core uses `fetch` and WebCrypto only. `node:` imports are allowed only under `src/node` (test helpers such as the mock provider live outside `src`, in `test/`), and `verify:pack` fails if one leaks into a runtime-neutral entry.
4. **The host owns identity.** Conduit has no user model. An account's `owner` is an opaque string, and `resolveOwner` is the HTTP surface's only authentication hook. A mismatched owner reads exactly like a missing account, so there is no existence oracle.
5. **Specs are data.** Expressions are parsed, never evaluated as JavaScript. Member access reads only own properties, calls are limited to named registry functions, and every run has a step budget. Connector functions cannot recurse; validation rejects cycles.

## A call, end to end

`conduit.execute({ connector, operation, account, inputs })`:

1. **Resolve.** The registry returns the validated, cached connector: merged `config`, a function registry (standard + plugin + connector functions) and the static host guard. Triggers are rejected here; they are delivered, not executed.
2. **Authorize.** The account is loaded (owner-checked, connector-checked, method-checked, not `needsReauth`), and its credentials are opened with the `SecretCipher`.
3. **Renew early.** `ensureFresh` renews when the credential expires within `refreshSkewSec`. It runs under the account's lock, and the row is re-read inside the lock, so twenty concurrent callers produce one refresh. The write is compare-and-set on `version`.
4. **Inputs.** Defaults are applied, form-style values are coerced, and the result is validated against the operation's input schema. A `ConduitValidationError` is thrown before any network traffic.
5. **Steps**, in order, each skippable with `when`; results go to `steps.<name>`.
6. **Request.** Templates are rendered with headers and query layered as: `http` defaults < request < auth `apply`. The URL must pass the host guard. Middleware wraps the fetch. Redirects are followed manually: every hop is re-checked, and credentials are dropped across origins.
7. **Classify.** Operation rules, then connector rules, then defaults. A classified `auth` failure triggers one forced renewal and a replay. `rateLimited` and `transient` failures retry with jittered backoff or `Retry-After`.
8. **Paginate** (`search`/`options`): cursor, offset, page, next URL or `Link` header, up to `maxPages`/`maxItems`, or one page at a time with a resumable `next`.
9. **Map** the output. Options are normalised to `{label, value}`.
10. **Report.** Plugins' `onExecute` listeners get the outcome. The caller gets `{ output, next?, pages?, trace }`, and secrets in the trace are masked.

## Ports

| Port | Contract | Default |
|---|---|---|
| `ConnectorSource` | `list`, `get`, optional `watch(onChange)` | `memorySource`, `compositeSource`, `fileSource` (`./node`) |
| `AccountStore` | CRUD by id, `list({owner, connector})`, **compare-and-set** `update(account, expectedVersion)` | `memoryAccounts` |
| `TransientStore` | `put(key, value, ttl)`, **single-use** `take(key)` | `memoryTransient` |
| `LockProvider` | `withLock(key, fn)` — mutual exclusion per key | `inProcessLocks` |
| `SecretCipher` | `seal`/`open` strings | `webCryptoCipher` (AES-256-GCM, HKDF-derived, rotation via `previous`) |
| `HttpClient` | `fetch`-compatible | `globalThis.fetch` |
| `ClientResolver` | `({connector, method, owner}) → {id, secret}` | a map in `createConduit({ clients })` |

Multi-process deployments need a shared `AccountStore` and `TransientStore`
(the OAuth callback can land on another instance). They also need a
distributed `LockProvider` if single-flight refresh must hold across
processes. Without one, compare-and-set still guarantees no refresh is lost:
the loser adopts the winner's credentials. Adapter packages prove their
behaviour with the conformance suites published as
`@aigntiq/conduit/testing`: `accountStoreConformance`,
`transientStoreConformance` and `lockProviderConformance`. They are
runner-agnostic data, registered with `registerConformance(suites, { describe, it })`
([integrating](integrating.md#4-test-your-own-ports)).

## Plugins

```ts
definePlugin({
    name: 'metrics',
    setup(r) {
        r.addFunctions({ ... });        // expression functions for every connector
        r.addEncoding('xml', encoder);  // request.encoding: "xml"
        r.useRequest(async (req, next, info) => next(req));   // wrap every outbound request
        r.onExecute((e) => ...);        // after every execute
        r.onAccountChanged((e) => ...); // created | updated | refreshed | needsReauth | deleted
        r.route({ method: 'GET', path: '/health', handle });  // served by createFetchHandler
    }
});
```

## Security model

- **Credentials at rest** are sealed by the `SecretCipher` before they reach a store. The store sees `v1.<ciphertext>`.
- **OAuth state** is HMAC-signed with a key derived from `secret`, expires (10 minutes by default), and carries a nonce. The nonce's server-side record, which holds the PKCE verifier and the sealed connect inputs, is **taken once**, so replaying a callback fails. The owner is bound inside the signed state: a callback can only ever connect an account for the owner who started the connection.
- **PKCE** (S256) is on by default for the authorization-code grant.
- **The host guard** limits outbound requests to the rendered `baseUrl` host, the connector's auth endpoints, `http.allowHosts` and the host's `allowHosts`. It is checked on every redirect hop and every next-page URL. Non-HTTP schemes are refused.
- **Traces** mask credential values, secret inputs and well-known secret query parameters.
- **Token requests** send secrets as pre-rendered data, never through the template engine.
- **The HTTP surface** accepts JSON bodies only (no simple cross-site form posts). It follows only same-site relative `returnTo` paths (no open redirects), and its callback page posts only to its own origin. Internal errors are reported without detail.

## Designed, not yet built

The spec and types already describe these; the runtime will grow into them:

- **Triggers** — webhook subscribe/verify/renew/unsubscribe and polling with dedupe. This needs a `Scheduler` port and a `TriggerSink` for delivering events to the host.
- **`@aigntiq/conduit-cli`** — `validate`, `run`, `login` (loopback OAuth), `new`.
- **Storage adapters** — `-surreal`, `-pg`, `-redis`.
- **`@aigntiq/conduit-actors`** — cluster-wide single-flight refresh and durable renew/poll.
- **`@aigntiq/conduit-ui`** — UI components: connect button, auth form, operation form with dynamic options.
- **`@aigntiq/conduit-mcp`** — operations as MCP/AI tools.
- **`@aigntiq/conduit-openapi`** — draft a connector from an OpenAPI document.
