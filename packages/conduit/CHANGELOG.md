# Changelog

All notable changes to `@sigx/conduit` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
adheres to [Semantic Versioning](https://semver.org/) (pre-1.0: minor = breaking).

## [Unreleased]

### Added

- The `conduit/1` connector spec: TypeScript types, `defineConnector`, the JSON Schema (`./schema`, `schema/conduit-1.schema.json`) and `validateConnector` with located diagnostics.
- Conduit expressions (`./expr`): a sandboxed `{{ }}` language with pipes, lambdas, a standard library (text, lists, objects, dates, digests, HMAC, JWT signing) and static analysis.
- `createConduit`: connector registry, accounts, auth flows (OAuth 2 authorization code with PKCE, client credentials, refresh and revoke; API key; basic; bearer; JWT, direct or exchanged; custom steps), and operation execution with steps, pagination, error rules, retries and output mapping.
- Ports with in-memory defaults (`memoryAccounts`, `memoryTransient`, `inProcessLocks`), `webCryptoCipher`, and connector sources (`memorySource`, `compositeSource`, `fileSource`).
- The plugin API (`definePlugin`): expression functions, body encodings, request middleware, execute and account events, routes.
- HTTP surface: `createFetchHandler` (`./server`) and `createNodeHandler` (`./node`).
- Standalone OAuth helpers (`./oauth`).
