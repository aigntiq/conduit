# @sigx/conduit

**Declarative, pluggable connectors.** Describe a third-party API once as
data — auth, operations, request and response mapping — and call it from any
host framework.

```sh
pnpm add @sigx/conduit
```

```ts
import { createConduit } from '@sigx/conduit';
import { fileSource, createNodeHandler } from '@sigx/conduit/node';

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
| `@sigx/conduit` | spec types, validation, `createConduit`, ports + in-memory defaults, plugins, errors — runs on any WinterCG runtime |
| `@sigx/conduit/expr` | the `{{ }}` expression language, standalone |
| `@sigx/conduit/schema` | the `conduit/1` JSON Schema (also shipped as `schema/conduit-1.schema.json`) |
| `@sigx/conduit/oauth` | PKCE, sealed state and token helpers, standalone |
| `@sigx/conduit/server` | `createFetchHandler` — `Request → Response` for Hono, Bun, Deno, Workers, Next.js |
| `@sigx/conduit/builder` | author connectors in TypeScript — typed inputs and templates, compiled to JSON; typed `execute` via `CatalogOf` |
| `@sigx/conduit/node` | `createNodeHandler` (Express/Connect) and `fileSource` |

No runtime dependencies. Node `^20.19.0 || >=22.12.0`, or any runtime with
`fetch` and WebCrypto.

Docs: [architecture](https://github.com/signalxjs/conduit/blob/main/docs/architecture.md) ·
[spec reference](https://github.com/signalxjs/conduit/blob/main/docs/spec-reference.md) ·
[expressions](https://github.com/signalxjs/conduit/blob/main/docs/expressions.md) ·
[writing a connector](https://github.com/signalxjs/conduit/blob/main/docs/writing-a-connector.md) ·
[integrating](https://github.com/signalxjs/conduit/blob/main/docs/integrating.md)

MIT © Andreas Ekdahl
