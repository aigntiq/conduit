# `conduit/1` spec reference

A connector is JSON (or TypeScript via `defineConnector`) that describes one
API. This page documents every field. The machine-readable schema is
[`packages/conduit/schema/conduit-1.schema.json`](../packages/conduit/schema/conduit-1.schema.json)
(exported as `@aigntiq/conduit/schema`); add
`"$schema": "<path to it>"` to a `connector.json` for editor completion.

Every string marked *template* may contain `{{ expressions }}` — see
[expressions](expressions.md). What each template can read is listed under
[Scope](#scope).

## Layout

`fileSource(dir)` from `@aigntiq/conduit/node` reads either layout:

```
connectors/
  acme-crm/
    connector.json        everything except auth and operations
    auth.json             [ …methods ]  or  { "methods": [ … ] }
    operations/*.json     one operation per file; "id" defaults to the file name
    icon.svg              inlined as a data: URI when connector.json has no icon
  weather.json            a whole connector in one file
```

Any other source works too: implement `ConnectorSource` (`list`, `get`,
optional `watch`), or use `memorySource([...])`.

## Connector

| Field | Type | |
|---|---|---|
| `spec` | `"conduit/1"` | required |
| `id` | string | required. `^[a-z0-9][a-z0-9_-]*$`, stable forever — accounts reference it |
| `name` | string | required |
| `version` | semver | required. The connector's own version |
| `description`, `homepage` | string | |
| `icon` | string | URL or `data:` URI (a relative path in `connector.json` is inlined) |
| `brandColor`, `helpUrl` | string | `#rrggbb`; a link for the connector |
| `categories` | string[] | |
| `config` | object | static, non-secret values, read as `config.*`. Hosts can override per connector (e.g. point `baseUrl` at a sandbox) |
| `http` | [HTTP defaults](#http-defaults) | |
| `functions` | `{ name: { params, body } }` | expression functions for this connector; `body` is a bare expression (no `{{ }}`) over `params`, `config` and `env` |
| `auth` | [auth method](#auth-methods)[] | absent or empty: no credentials needed |
| `operations` | [operation](#operations)[] | required |

## HTTP defaults

| Field | |
|---|---|
| `baseUrl` | *template*. Relative request URLs resolve against it |
| `headers`, `query` | *template* maps applied to every request (a request's own values win) |
| `timeoutMs` | per attempt. Default 30 000 |
| `retry` | [retry policy](#retries) |
| `errors` | [error rules](#errors) checked after the operation's own |
| `allowHosts` | extra hosts requests may reach. `*.example.com` matches subdomains. See [host guard](#host-guard) |

## Requests

Used by operations, steps, auth tests, identity lookups and triggers.

| Field | |
|---|---|
| `url` | *template*, required. Relative → joined to `http.baseUrl` |
| `method` | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or a template |
| `query` | map of *templates* (array values repeat the key; keys rendering `undefined` are dropped), or one template producing a map |
| `headers` | map of *templates* |
| `body` | *template* — any JSON |
| `encoding` | how `body` is sent: `json` (default), `form` (url-encoded), `multipart`, `text`, `binary` |
| `responseType` | `auto` (default — by `Content-Type`), `json`, `text`, `binary` |
| `timeoutMs` | overrides `http.timeoutMs` |
| `auth` | `false` to send without the account's credentials |

### Steps

`steps` (on operations and custom auth) are named requests run in order before
the main request. Each is a request plus:

| Field | |
|---|---|
| `name` | required; the result is `steps.<name>` |
| `when` | *template*; the step is skipped unless truthy |
| `output` | *template* for `steps.<name>`. Default: the response body. Scope adds `response` |
| `forEach` | *template* rendering to a list (operation steps only). The step runs once per item, in order; `when`, the request and `output` also read `each` (the item) and `index`. `steps.<name>` is then the list of outputs, `null` where `when` skipped an item |
| `maxIterations` | the most items `forEach` may take. Default 100; more is an error before any request |

A `forEach` step makes an upload session easy to fill — `chunks()` splits a
file into byte ranges, and `auth: false` keeps credentials off an upload URL:

```json
{ "name": "parts", "forEach": "{{chunks(inputs.file.base64, 2949120)}}",
  "method": "PUT", "url": "{{steps.session.uploadUrl}}", "auth": false, "encoding": "binary",
  "headers": { "Content-Range": "bytes {{each.start}}-{{each.end}}/{{each.total}}" },
  "body": "{{each.base64}}" }
```

## Auth methods

Every method has `id` (required), `label`, `description`, and:

| Field | |
|---|---|
| `inputs` | [input schema](#inputs) of what the owner enters when connecting. Each type has a conventional default |
| `apply` | `{ headers, query }` *templates* overriding where credentials go (scope: `auth`, `account`, `config`, `env`) |
| `test` | a request that succeeds only when the credentials work |
| `identity` | `{ request?, id, name, data }` — who the account is. `data` is kept (non-secret) as `account.data` |
| `refreshSkewSec` | refresh this long before expiry. Default 60 |
| `setup`, `helpUrl` | markdown setup instructions (register an app, redirect URI, scopes) and a link |

Whatever the type, credentials are read as `auth.*` and **sealed** before an
`AccountStore` ever sees them.

### `oauth2`

| Field | |
|---|---|
| `grant` | `authorization_code` (default) or `client_credentials` |
| `authorizeUrl` | *template*; required for `authorization_code` |
| `tokenUrl` | *template*, required |
| `refreshUrl` | default `tokenUrl` |
| `revokeUrl` | called when an account is revoked |
| `scopes`, `scopeSeparator` | default separator `" "` |
| `pkce` | S256 PKCE. Default **true** for `authorization_code` |
| `clientAuth` | `body` (default: `client_id`/`client_secret` form fields) or `basic` |
| `authorizeParams`, `tokenParams` | extra *template* parameters |
| `token` | [token mapping](#token-mapping). Default: the RFC 6749 fields |
| `client` | `{ id, secret }` *templates*. Default: the host's client resolver, then `inputs.clientId`/`inputs.clientSecret` |

Applied as `Authorization: Bearer {{auth.accessToken}}`. Refresh uses the
stored refresh token. A `client_credentials` method re-mints its token when
the token expires.

### `apiKey`

`name` (header or query parameter, required), `in` (`header` default, or
`query`), `prefix` (e.g. `"Token "`), `value` (default `{{auth.apiKey}}`).
Default input: `apiKey`.

### `basic`

Default inputs `username`, `password`; applied as `Authorization: Basic …`.

### `bearer`

Default input `token`; applied as `Authorization: Bearer {{auth.token}}`.

### `jwt`

Signs a JWT per `jwt: { algorithm, key, claims, header?, lifetimeSec? }`.
`iat` and `exp` are added unless present, and `now` holds epoch seconds. With
`exchange: { request, token? }` the JWT is traded for an access token (scope
adds `jwt`). Without `exchange`, the JWT itself is the bearer token. Either
way it is re-minted near expiry. Put the key in `inputs` (as `x-secret`) or
pass it in via `env`.

### `custom`

The escape hatch: `steps` that mint credentials (scope: `inputs`, `config`,
`env`, `steps`), `credentials` (*template*, what to store — default: the
connect inputs), `expiresIn` (*template*, seconds), and a required `apply`.

### Token mapping

`accessToken`, `refreshToken`, `expiresIn` (seconds), `expiresAt` (absolute;
wins), `tokenType`, `scope`, `data` (extra values stored as `auth.*`). Scope:
`response` is the token endpoint's reply, `{ status, headers, body }`, where
`body` is parsed from JSON or form encoding. The defaults read
`response.body.access_token`, `refresh_token`, `expires_in`, `token_type` and
`scope`. A refresh that returns no new refresh token keeps the old one.

## Operations

Every operation has `id`, `kind`, `label` (all required), plus:

| Field | |
|---|---|
| `description`, `tags` | |
| `group`, `helpUrl` | catalog grouping and a link |
| `destructive` | the operation deletes or irreversibly changes data; UIs ask for confirmation |
| `readOnly` | the operation only reads — no side effects — so a host may run it without asking. Absent means unknown, not "writes". Cannot be combined with `destructive` |
| `auth` | method ids it works with (default: any), or `false` for no credentials |
| `inputs` | [input schema](#inputs) |
| `outputs` | JSON Schema of the result (documentation for UIs and tools) |
| `steps` | [steps](#steps) |
| `request` | the main [request](#requests); required except for triggers |
| `output` | *template* for the result. Default: the response body (for `search`: every item) |
| `errors` | [error rules](#errors) checked before the connector's |
| `retry` | [retry policy](#retries), or `false` |
| `hidden` | hide from catalogs. `options` operations are hidden by default |

### Kinds

- **`action`** — one call, one result.
- **`search`** — a list, optionally across pages ([`paginate`](#pagination)). `output` sees `items`, every item collected.
- **`options`** — dynamic choices for an input (`x-options`). The output must be a list; plain values are normalised to `{label, value}`.
- **`trigger`** — events, from a webhook or a poll ([triggers](#triggers)).

### Pagination

| Field | |
|---|---|
| `style` | `cursor`, `offset`, `page`, `nextUrl`, `linkHeader` |
| `items` | *template*, required — one page's items |
| `next` | `cursor`: the next cursor. `nextUrl`: the next page's URL |
| `hasMore` | *template*. Default: the page had items (and a `next`, where one applies) |
| `param` | query parameter for the cursor / offset / page number (required for those styles) |
| `pageSize`, `pageSizeParam` | size requested per page |
| `start` | first offset (default 0) or page (default 1) |
| `maxPages` | default 10 |
| `maxItems` | stop once this many are collected |

`linkHeader` follows `Link: <…>; rel="next"`. A caller can also ask for one
page at a time and resume from the returned cursor.

### Inputs

A JSON Schema subset, `{ "type": "object", "properties": { … }, "required": [ … ], "x-rules": [ … ] }`.

Each property has a `type` (`string`, `number`, `integer`, `boolean`,
`array` or `object`) plus optional:

- standard keywords: `title`, `description`, `default`, `examples`,
  `readOnly`, `deprecated`, `enum`, `oneOf` (labelled choices), `format`,
  `items`, `properties`, `required`;
- constraints: `minimum`, `maximum`, `minLength`, `maxLength`,
  `pattern`, `minItems`, `maxItems`;
- UI and validation hints: `x-widget`, `x-placeholder`, `x-group`,
  `x-order`, `x-advanced`, `x-visibleWhen`, `x-requiredWhen`,
  `x-options`, `x-secret`, `x-accept`, `x-maxBytes`, `x-language`,
  `x-errorMessage`.

Unknown keys are rejected, so a misspelled hint is a validation error rather
than something silently ignored.

**[UI hints, forms and validation](ui-hints.md)** documents all of it:

- the widget vocabulary and inference table;
- conditions and cross-field rules;
- the form model (`conduit.connectors.form`);
- how inputs are prepared: defaults, coercion, hidden fields dropped,
  validation with coded issues;
- behaviour for hosts that bind inputs dynamically.

### Errors

Every response is classified. Rules are checked in order: the operation's
`errors`, then the connector's `http.errors`, then the defaults. The first
match wins, and a rule may match a 2xx response (an API that answers
`200 {"ok": false}`).

| Rule field | |
|---|---|
| `when` | *template*, required. Scope adds `response` |
| `error` | `auth`, `forbidden`, `notFound`, `rateLimited`, `validation`, `conflict`, `transient`, `fatal` |
| `message` | *template* |
| `retryable` | override |
| `field` | attribute a `validation` failure to an input: the error carries `issues: [{ path: "inputs.<field>", code: "remote" }]`, and the HTTP surface answers 422 |

The default classification is:

| Status | Kind |
|---|---|
| 400, 422 | `validation` |
| 401 | `auth` |
| 403 | `forbidden` |
| 404 | `notFound` |
| 409 | `conflict` |
| 429 | `rateLimited` |
| 408, 5xx, network failure | `transient` |
| any other 4xx | `fatal` |

A 401 on an account whose token can be refreshed triggers one forced refresh
and a retry. If that fails too, the result is a `ConduitAuthError` with
`needsReauth`.

### Retries

`{ attempts (default 3, total), initialDelayMs (500), maxDelayMs (30000), factor (2), on (["rateLimited", "transient"]) }`.
Backoff is exponential with full jitter. `Retry-After` is honoured, capped at
`maxDelayMs`.

### Triggers

`trigger` is a webhook or a poll.

**Webhook:**

| Field | |
|---|---|
| `subscribe` | request + `output`. Scope adds `subscription.callbackUrl` and `subscription.secret`. `output` is kept as `subscription.data` |
| `unsubscribe` | request; scope adds `subscription.data` |
| `renew` | `{ everyMinutes, request }` |
| `verify` | `hmac` (`header`, `algorithm`, `encoding`, `prefix`, `secret`, `payload`, `timestampHeader`, `toleranceSec`), `token` (`header`, `value`), or `custom` (`valid`). Comparison is constant-time |
| `handshake` | `{ when, respond }` — answer a validation challenge directly |
| `filter` | *template*; emit only when truthy |
| `event` | *template*, required; a list emits one event per item |
| `dedupeKey` | *template* |

Delivery scope: `request` (`headers`, `query`, `body`, `rawBody`), `inputs`,
`subscription`, `auth`, `account`, `config`, `env`.

**Poll:**

| Field | |
|---|---|
| `request` | required. Scope adds `state.cursor` |
| `items` | *template*, required. Scope adds `response` |
| `cursor` | *template*; stored as the next `state.cursor` |
| `dedupeKey` | *template*, required; scope adds `item` |
| `event` | *template*; scope adds `item` |
| `intervalSec` | default 300 |

## Scope

| Where | Readable roots |
|---|---|
| `http.baseUrl`, `http.headers`, `http.query` | `inputs` `auth` `account` `config` `env` |
| operation `request`, step `when`/request | the above + `steps` `page` (a `forEach` step adds `each` `index`) |
| step `output` | the above + `response` |
| operation `output` | `inputs` `auth` `account` `config` `env` `steps` `response` `items` |
| `errors[].when` / `message` | `inputs` `auth` `account` `config` `env` `steps` `response` |
| `paginate.*` | `inputs` `auth` `account` `config` `env` `steps` `response` `page` |
| auth `apply`, `apiKey.value` | `auth` `account` `config` `env` |
| auth `test`, `identity.request` | `inputs` `auth` `account` `config` `env` |
| `identity.id`/`name`/`data` | the above + `response` `token` |
| `authorizeUrl`, `authorizeParams` | `inputs` `config` `env` `oauth` `client` |
| `tokenUrl`, `refreshUrl`, `revokeUrl`, `tokenParams`, `client` | `inputs` `config` `env` `oauth` `client` `auth` |
| token mapping | `inputs` `config` `env` `auth` `response` |
| `jwt.*` | `auth` `config` `env` `now` |
| `jwt.exchange.request` | `auth` `config` `env` `jwt` |
| custom `steps` | `inputs` `config` `env` `steps` |
| custom `credentials`, `expiresIn` | the above + `response` |
| webhook `subscribe`/`unsubscribe`/`renew` | `inputs` `auth` `account` `config` `env` `subscription` |
| webhook `verify`/`handshake`/`filter`/`event`/`dedupeKey` | `inputs` `auth` `account` `config` `env` `request` `subscription` |
| poll `request` | `inputs` `auth` `account` `config` `env` `state` |
| poll `items`/`cursor`/`dedupeKey`/`event` | the above + `response` `item` |
| `x-options.inputs` | `inputs` `config` `env` |

The root values:

- `oauth` = `{ redirectUri, state, codeChallenge, codeChallengeMethod, scope, code }`
- `client` = `{ id, secret }`
- `page` = `{ number, offset, cursor, url }`
- `account` = `{ id, owner, connector, method, externalId, displayName, data }`

Reading a root that is not available where a template sits reads `undefined`.
Validation reports it as a warning.

## Host guard

Requests may only go to:

- the host of the rendered `baseUrl`;
- the hosts of the connector's auth endpoints;
- `http.allowHosts`;
- the host's own `allowHosts`.

Anything else fails with a `ConduitRequestError` before a socket opens. This
keeps an input like `url: "{{inputs.link}}"` from reaching internal addresses.

## Validation

`validateConnector(spec)` returns `{ valid, diagnostics }`. Each diagnostic
has a `path` (`operations[2].request.url`), a stable `code` and a `severity`.
Checks are structural (the schema) and semantic:

- duplicate ids;
- unknown auth, operation and step references;
- `x-options` pointing at a non-`options` operation;
- an operation both `readOnly` and `destructive` (`operation_read_only_destructive`);
- every template parsed, with its functions resolved;
- scope roots checked against the table above (warnings).

`createConduit` validates every connector it loads and refuses invalid ones.
