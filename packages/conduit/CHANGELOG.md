# Changelog

All notable changes to `@aigntiq/conduit` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
adheres to [Semantic Versioning](https://semver.org/) (pre-1.0: minor = breaking).

## [Unreleased]

## [0.3.0] - 2026-09-25

### Added

- Steps can repeat over a list: `forEach` runs a step once per item (with `each` and `index` in scope), collecting `steps.<name>` as a list; `maxIterations` (default 100) bounds it. Operation steps only.
- `chunks(base64OrBytes, size)` and `byteLength(base64OrBytes)` in the expression standard library: split a file into byte ranges for upload sessions.

## [0.2.0] - 2026-09-24

### Added

- The builder's `json()` field can hold a list: `json({ type: 'array' })` (the default stays an object).

## [0.1.1] - 2026-09-24

### Added

- `base64`, `base64url` and `length` work on bytes, so a binary response body maps to a file value (`base64: base64(response.body)`).
- `readOnly` on operations: the operation only reads, so a host may run it without asking. Validation rejects an operation that is both `readOnly` and `destructive` (`operation_read_only_destructive`); the builder accepts it.
- `connectors.describe()` (and `GET /connectors/:id`) carries each operation's `group`, `destructive` and `readOnly`, so a UI or tool catalog built from it can group operations and pick an approval policy without reading the full spec.
- `@aigntiq/conduit/testing`: the port conformance suites (`accountStoreConformance`, `transientStoreConformance`, `lockProviderConformance`) are published. They depend on no test runner: each returns a `ConformanceSuite` of named cases, and `registerConformance(suites, { describe, it })` registers them with vitest, Jest, Mocha or `node:test`.
- `toolDefinitions(description)` and `toolSchema(inputs)` in `./schema`: an operation's inputs as plain JSON Schema without `x-` UI hints, and one tool definition per `action` / `search` operation with `readOnly` / `destructive` annotations, for hosts that expose operations to models or MCP clients.
- Operation policy: `createConduit({ policy })` asks a host-supplied `OperationPolicy` before every `execute` and `options` call. It runs after input validation and before any credential renewal or request, and answers `allow`, `confirm` or `deny`. A refusal throws `ConduitPolicyError` (`operation_denied` / `confirmation_required`, 403 over HTTP); a `confirm` runs once the host repeats the call with `confirmed: true`. Requests carry an opaque `caller`, and the handlers take `resolveCaller`. `strictest`, `firstOf`, `annotationPolicy` and `operationRules` compose layered rules. `conduit.decide()` evaluates the policy ahead of a call, and `toolDefinitions(description, { decisions })` drops denied operations and marks confirm ones with `annotations.confirm`.

## [0.1.0] - 2026-09-23

### Added

- The `conduit/1` connector spec: TypeScript types, `defineConnector`, the JSON Schema (`./schema`, `schema/conduit-1.schema.json`) and `validateConnector` with located diagnostics.
- Conduit expressions (`./expr`): a sandboxed `{{ }}` language with pipes, lambdas, a standard library (text, lists, objects, dates, digests, HMAC, JWT signing) and static analysis.
- `createConduit`: connector registry, accounts, auth flows (OAuth 2 authorization code with PKCE, client credentials, refresh and revoke; API key; basic; bearer; JWT, direct or exchanged; custom steps), and operation execution with steps, pagination, error rules, retries and output mapping.
- Ports with in-memory defaults (`memoryAccounts`, `memoryTransient`, `inProcessLocks`), `webCryptoCipher`, and connector sources (`memorySource`, `compositeSource`, `fileSource`).
- The plugin API (`definePlugin`): expression functions, body encodings, request middleware, execute and account events, routes.
- HTTP surface: `createFetchHandler` (`./server`) and `createNodeHandler` (`./node`).
- Standalone OAuth helpers (`./oauth`).
- UI hints and forms: a closed widget vocabulary, groups, ordering, advanced fields, conditions (`x-visibleWhen`, `x-requiredWhen`), labelled choices (`oneOf`), dependent and searchable options, file hints, message overrides, cross-field `x-rules`, plus `destructive`/`group` on operations, `setup` on auth methods and `brandColor` on connectors.
- `buildForm`, `prepareForm` and `validateForm`: one renderer-agnostic form model and one validator for browser and server, with coded issues, hidden fields dropped, and three-valued handling of inputs a host binds at run time. Served as `conduit.connectors.form()` and `GET {base}/connectors/:id/forms/:operation`.
- `format` is now validated (`email`, `uri`, `date`, `date-time`, `uuid`).
- `@aigntiq/conduit/builder`: author connectors in TypeScript. Field helpers carry UI hints and constraints; typed refs, `$` and `expr` build templates (a misspelled input does not compile); every builder returns plain `conduit/1` JSON. `emitTypes` writes declarations for JSON-shipped connectors.
- `mime()` and `flattenTree()` in the expression standard library.
- The `email` format accepts `Name <address>` as well as a bare address.
- Typed `execute`: `createConduit<CatalogOf<typeof connector>>()` checks connector and operation ids, inputs and outputs.
- Error rules can attribute a failure to an input (`field`); the HTTP surface answers 422 with the issues.
