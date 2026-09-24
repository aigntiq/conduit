# Integrating Conduit

A host does three things:

1. Creates one `Conduit` instance.
2. Mounts its HTTP surface, so browsers can connect accounts, finish OAuth and load dynamic options.
3. Calls `conduit.execute` from its own code.

## 1. Create the instance

```ts
import { createConduit } from '@aigntiq/conduit';
import { fileSource } from '@aigntiq/conduit/node';

export const conduit = createConduit({
    sources: fileSource('./connectors'),
    secret: process.env.CONDUIT_SECRET!,          // ≥ 32 random characters
    redirectUri: 'https://app.example/conduit/auth/callback',
    clients: {
        'acme-crm': { id: process.env.ACME_CLIENT_ID!, secret: process.env.ACME_CLIENT_SECRET }
    },
    // production: durable, shared stores
    // accounts: pgAccounts(db), transient: redisTransient(redis), locks: redisLocks(redis),
    // cipher: kmsCipher(...),
});
```

| Option | |
|---|---|
| `sources` | one or more `ConnectorSource`s; earlier wins on duplicate ids |
| `secret` | signs OAuth state; derives the credential key unless `cipher` is given |
| `accounts`, `transient`, `locks`, `cipher` | ports — see [architecture](architecture.md#ports) |
| `clients` | OAuth clients: `{ [connector or "connector/method"]: { id, secret } }` or a resolver function |
| `redirectUri` | default OAuth redirect (your callback route) |
| `config` | per-connector overrides of `config`, e.g. a sandbox `baseUrl` |
| `env` | values templates may read as `env` — nothing leaks from `process.env` |
| `allowHosts` | extra hosts for every connector |
| `plugins`, `middleware` | extension points |
| `http` | a `fetch` replacement (proxies, testing) |

## 2. Mount the HTTP surface

### Fetch runtimes: Hono, Bun, Deno, Workers, Next.js

```ts
import { createFetchHandler } from '@aigntiq/conduit/server';

const conduitHandler = createFetchHandler(conduit, {
    basePath: '/conduit',
    resolveOwner: async (request) => (await getSession(request))?.userId,
});

app.all('/conduit/*', (c) => conduitHandler(c.req.raw));        // Hono
export const GET = conduitHandler, POST = conduitHandler;       // Next.js route handler
```

### Express, Connect, Node `http`

```ts
import { createNodeHandler } from '@aigntiq/conduit/node';

app.use(createNodeHandler(conduit, {
    resolveOwner: (req) => req.session?.userId,
}));
```

A body parser in front of it is fine. Paths the handler does not serve go to `next()`.

### Routes

All paths are relative to `basePath`. All require an owner except the callback.

| Route | |
|---|---|
| `GET /connectors` | catalog |
| `GET /connectors/:id` | full description (`conduit.connectors.describe(id)`): auth methods (with inputs), operations (with inputs/outputs and the `group`, `destructive` and `readOnly` hints) |
| `GET /accounts?connector=` | the owner's accounts |
| `POST /auth/:connector/:method/start` | `{ inputs?, returnTo?, account? }` → `{ type: "redirect", url }` or `{ type: "connected", account }` |
| `GET /auth/:connector/:method/start?returnTo=` | same as a plain link: 302 to the provider |
| `GET /auth/callback` | the OAuth redirect URI. Goes to `returnTo` (same-site paths only) with `?conduit_account=`, or to `callbackFallback`, or answers with a page that `postMessage`s `{type: "conduit:auth", ok, account}` to its opener |
| `POST /accounts` | `{ connector, method, inputs, account? }` — non-redirect methods (API key, basic, bearer, client credentials, JWT, custom) |
| `POST /accounts/:id/test` | runs the method's `test` |
| `POST /accounts/:id/refresh` | renews now |
| `DELETE /accounts/:id` | revokes at the provider (best effort) and deletes |
| `POST /options/:connector/:operation` | `{ account, inputs }` → `{ options: [{label, value}] }` |
| `POST /execute` | only with `exposeExecute: true` |

Plugin routes (`registry.route`) are served under the same base path.

Errors are JSON, `{ error: { code, message, … } }`:

| Status | When |
|---|---|
| 400 | invalid inputs (with `issues`) or body |
| 401 | no owner |
| 404 | unknown connector, operation or account (including another owner's) |
| 409 | the account needs reconnecting (`needsReauth: true`) |
| 415 | a non-JSON body |
| 429 | the provider rate-limited (with `Retry-After`) |
| 502 | the provider failed (`kind` says how) |

### Popup sign-in in the browser

```ts
const { url } = await post('/conduit/auth/acme-crm/oauth/start', {});
const popup = window.open(url, 'conduit', 'width=500,height=700');
window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data?.type === 'conduit:auth') refreshAccounts();
});
```

## 3. Call operations

```ts
const { output } = await conduit.execute({
    connector: 'acme-crm',
    operation: 'create-contact',
    account: accountId,
    owner: userId,          // enforce ownership
    inputs: { email: 'ada@example.com' },
});
```

Failures are typed. Branch on the class or on `code`:

```ts
import { ConduitAuthError, ConduitRequestError, ConduitValidationError } from '@aigntiq/conduit';

try { … } catch (e) {
    if (e instanceof ConduitAuthError && e.needsReauth) promptReconnect(e.accountId);
    else if (e instanceof ConduitValidationError) showFieldErrors(e.issues);
    else if (e instanceof ConduitRequestError && e.retryable) retryLater();
    else throw e;
}
```

Paging one page at a time:

```ts
let cursor;
do {
    const page = await conduit.execute({ connector, operation: 'list-contacts', account, paging: { mode: 'page', cursor } });
    render(page.output);
    cursor = page.next;
} while (cursor !== undefined);
```

## 4. Expose operations as tools

To hand a connector's operations to a model, an agent framework or an MCP
server, build tool definitions from its description:

```ts
import { toolDefinitions } from '@aigntiq/conduit/schema';

const tools = toolDefinitions(await conduit.connectors.describe('acme-crm'));
// [{ name: 'create-contact', operation: 'create-contact', description: 'Create contact. …',
//    inputSchema: { type: 'object', … }, annotations: {} },
//  { name: 'list-contacts', …, annotations: { readOnly: true } }, …]
```

- One definition per `action` and `search` operation. `options` operations feed
  forms and triggers are delivered, so neither becomes a tool. Hidden operations
  are left out unless you pass `{ includeHidden: true }`.
- `inputSchema` is plain JSON Schema: the inputs without their `x-` UI hints
  (`toolSchema(inputs)` does just that step).
- `annotations` come from the spec: `readOnly` when the operation declares it
  (a `search` reads unless it says `readOnly: false`), `destructive` when it
  declares that. Use them to pick an approval policy — run reads, confirm
  destructive calls.
- Names are the bare operation ids. Prefix them when several connectors share a
  tool namespace, and run each call with `conduit.execute`, mapping its typed
  errors to messages your callers understand.

## 5. Test your own ports

A store, lock or transient adapter you write for `accounts`, `transient` or
`locks` should pass the same conformance suites as the built-in ones. They
ship as `@aigntiq/conduit/testing` and depend on no test runner: each suite is
data — a name and named cases whose `run()` rejects with a `ConformanceError`
on a failure — and `registerConformance` hands them to your runner's
`describe` and `it`.

```ts
import { describe, it } from 'vitest'; // or 'node:test', or Jest/Mocha globals
import {
    accountStoreConformance,
    lockProviderConformance,
    registerConformance,
    transientStoreConformance
} from '@aigntiq/conduit/testing';

registerConformance(
    [
        accountStoreConformance('pg', () => pgAccounts(freshDb())),
        transientStoreConformance('redis', (clock) => redisTransient(redis, { now: () => clock.now })),
        lockProviderConformance('redis', () => redisLocks(redis))
    ],
    { describe, it }
);
```

| Export | |
|---|---|
| `accountStoreConformance(name, factory)` | CRUD, listing by owner and connector, duplicate ids rejected, compare-and-set `update`, results are copies. `factory` returns an empty store each call |
| `transientStoreConformance(name, factory)` | take-once values that expire. `factory(clock)` gets a `{ now }` object the store must read the time from, so the suite can move it |
| `lockProviderConformance(name, factory)` | work on one key runs one at a time and a failure releases the lock; different keys do not wait |
| `registerConformance(suites, { describe, it })` | one `describe` per suite, one `it` per case |
| `ConformanceSuite`, `ConformanceCase`, `ConformanceError`, `TestRegistrar` | the types |

Without a runner, loop over `suite.cases` and `await c.run()`. The entry is
runtime-neutral (no `node:` imports), so the suites also run inside a Worker.

## Runnable examples

- [`examples/express`](../examples/express) — Express, with a server-side route that calls `execute`.
- [`examples/hono`](../examples/hono) — Hono, the same code that runs on Workers.

Both have end-to-end tests that run the full OAuth round trip against the mock provider.
