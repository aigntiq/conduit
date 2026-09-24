# @aigntiq/conduit

**Declarative, pluggable connectors.** Describe a third-party API once as
data — auth, operations, request and response mapping — and call it from any
host framework.

```sh
pnpm add @aigntiq/conduit
```

```ts
import { createConduit } from '@aigntiq/conduit';
import { fileSource, createNodeHandler } from '@aigntiq/conduit/node';

const conduit = createConduit({
    sources: fileSource('./connectors'),
    secret: process.env.CONDUIT_SECRET!,
    redirectUri: 'https://app.example/conduit/auth/callback',
    clients: { 'acme-crm': { id: '…', secret: '…' } }
});

app.use(createNodeHandler(conduit, { resolveOwner: (req) => req.session?.userId }));

const { output } = await conduit.execute({
    connector: 'acme-crm',
    operation: 'create-contact',
    account: accountId,
    inputs: { email: 'ada@example.com' }
});
```

| Entry | |
|---|---|
| `@aigntiq/conduit` | spec types, validation, `createConduit`, ports + in-memory defaults, plugins, errors — runs on any WinterCG runtime |
| `@aigntiq/conduit/expr` | the `{{ }}` expression language, standalone |
| `@aigntiq/conduit/schema` | the `conduit/1` JSON Schema (also shipped as `schema/conduit-1.schema.json`), and `toolDefinitions` / `toolSchema` to expose operations as tools |
| `@aigntiq/conduit/oauth` | PKCE, sealed state and token helpers, standalone |
| `@aigntiq/conduit/server` | `createFetchHandler` — `Request → Response` for Hono, Bun, Deno, Workers, Next.js |
| `@aigntiq/conduit/builder` | author connectors in TypeScript — typed inputs and templates, compiled to JSON; typed `execute` via `CatalogOf` |
| `@aigntiq/conduit/node` | `createNodeHandler` (Express/Connect) and `fileSource` |
| `@aigntiq/conduit/testing` | conformance suites for your own `AccountStore`, `TransientStore` and `LockProvider`, for any test runner |

No runtime dependencies. Node `^20.19.0 || >=22.12.0`, or any runtime with
`fetch` and WebCrypto.

Docs: [architecture](https://github.com/aigntiq/conduit/blob/main/docs/architecture.md) ·
[spec reference](https://github.com/aigntiq/conduit/blob/main/docs/spec-reference.md) ·
[expressions](https://github.com/aigntiq/conduit/blob/main/docs/expressions.md) ·
[writing a connector](https://github.com/aigntiq/conduit/blob/main/docs/writing-a-connector.md) ·
[integrating](https://github.com/aigntiq/conduit/blob/main/docs/integrating.md)

MIT © Andreas Ekdahl
