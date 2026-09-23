# Conduit

**Describe an API once, as data. Call it from any host.**

Conduit is a declarative, pluggable connector framework. A *connector* is a
small set of JSON (or TypeScript) files that describes a third-party API:

- how to authenticate — OAuth2 (authorization code + PKCE, client
  credentials), API key, basic, bearer, signed JWT, or custom steps;
- what you can do with it — *operations*: actions, paged searches, dynamic
  option lists, and triggers;
- how each request is built and each response is mapped, using `{{ }}`
  **Conduit expressions**.

The runtime does the rest: runs the OAuth grant, seals and stores credentials,
refreshes tokens early and exactly once, builds requests, classifies errors,
retries with backoff, follows pagination and maps output. Storage, locking,
encryption and identity are **ports** — bring your own, or start with the
in-memory defaults — and the HTTP surface is a plain `Request → Response`
handler that mounts in Express, Hono, Fastify, Bun, Deno, Workers or Next.

```ts
import { createConduit } from '@aigntiq/conduit';
import { createNodeHandler, fileSource } from '@aigntiq/conduit/node';

const conduit = createConduit({
    sources: fileSource('./connectors'),
    secret: process.env.CONDUIT_SECRET!,           // signs OAuth state, seals credentials
    redirectUri: 'https://app.example/conduit/auth/callback',
    clients: { 'acme-crm': { id: '…', secret: '…' } }
    // production: accounts, transient, locks, cipher → durable adapters
});

// Connect accounts, OAuth callback, dynamic options:
app.use(createNodeHandler(conduit, { resolveOwner: (req) => req.session?.userId }));

// Call operations from your own code:
const { output } = await conduit.execute({
    connector: 'acme-crm',
    operation: 'create-contact',
    account: accountId,
    inputs: { email: 'ada@example.com' }
});
```

## Packages

| Package | What it is |
|---|---|
| [`@aigntiq/conduit`](packages/conduit) | The runtime: spec, validation, forms, expressions, auth/OAuth, executor, ports, fetch + Node handlers, the TypeScript builder |
| [`@aigntiq/conduit-connectors`](packages/conduit-connectors) | Ready-made connectors in one package — pick the ones you use (Gmail, …) |

Planned: `@aigntiq/conduit-cli`, storage adapters (`-surreal`, `-pg`, `-redis`),
`@aigntiq/conduit-actors`, `@aigntiq/conduit-ui`, `@aigntiq/conduit-mcp`,
`@aigntiq/conduit-openapi`. See [`docs/architecture.md`](docs/architecture.md).

## Docs

- [Architecture](docs/architecture.md) — ports, the execution pipeline, security
- [Spec reference](docs/spec-reference.md) — every field of `conduit/1`
- [Expressions](docs/expressions.md) — the `{{ }}` language and standard library
- [UI hints, forms and validation](docs/ui-hints.md) — generating UIs from a connector; one validator for browser and server
- [Writing a connector](docs/writing-a-connector.md)
- [Authoring in TypeScript](docs/authoring-in-typescript.md) — the typed builder that compiles to JSON
- [Integrating](docs/integrating.md) — Express, Hono, fetch runtimes

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

MIT © Andreas Ekdahl
