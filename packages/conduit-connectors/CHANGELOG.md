# Changelog

All notable changes to `@aigntiq/conduit-connectors` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
package follows [Semantic Versioning](https://semver.org/): adding a connector
or an operation is a minor release, fixing a mapping a patch, and breaking
any connector a major. Each connector also carries its own `version`.

## [Unreleased]

### Added

- The package: `connectorCatalog({ include })`, per-connector subpaths, plain JSON under `json/`, and a `Connectors` type for typed `execute`.
- **Gmail** 1.0.0: send, draft, reply, search, get message/conversation/attachment, labels (options, add/remove), trash, and a new-email poll trigger (runtime pending).
- Gmail marks its pure reads `readOnly`: `search-messages`, `get-message`, `get-thread`, `get-attachment`, `list-labels` and the `new-email` trigger.
