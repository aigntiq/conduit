# Conduit expressions

Everything dynamic in a connector — URLs, headers, bodies, output mapping,
error rules, pagination — is written as a **template**: a JSON value whose
strings may contain `{{ expression }}`.

```json
{
    "url": "/contacts/{{inputs.id}}",
    "query": { "limit": "{{inputs.limit}}" },
    "output": "{{response.body.items | map(c => {id: c.id, email: lower(c.email)})}}"
}
```

The language is small, sandboxed and side-effect free. It is **data, not code**:
there is no `eval`, nothing reaches a JavaScript prototype, and every run has a
step budget. It is available on its own as `@sigx/conduit/expr`.

## Templates

| Template | Result |
|---|---|
| `"{{inputs.count}}"` — exactly one expression, nothing around it | the raw value (number, list, object, …) |
| `"/users/{{inputs.id}}"` — text around it | a string; values are converted to text |
| `"plain"` — no `{{` | the literal string |

When converting to text, `null` and `undefined` become `""`, and objects and
lists become JSON.

Templates are rendered **deeply** through objects and arrays. **An object key
whose value renders to `undefined` is dropped** — this is how optional
parameters are written:

```json
"query": { "limit": "{{inputs.limit}}", "q": "{{inputs.search}}" }
```

With `inputs = { search: "ada" }` this sends `?q=ada` — no `limit=`.

## Syntax

| | |
|---|---|
| Literals | `1`, `2.5e3`, `'text'`, `"text"` (escapes `\n \t \' \" \uXXXX`), `true`, `false`, `null`, `undefined` |
| Paths | `inputs.user.name`, `list[0]`, `list[-1]` (from the end), `obj['a-b']`, `obj[key]`, `a?.b` |
| Arithmetic | `+ - * / %` — `+` adds numbers and otherwise concatenates text; the others coerce numeric strings |
| Comparison | `< <= > >=` — numeric when both sides are numbers (or numeric strings), otherwise text order |
| Equality | `==` / `!=` are **strict and deep**: `1 == '1'` is false, `[1, {a: 2}] == [1, {a: 2}]` is true. `===`/`!==` are aliases |
| Logic | `&&`, `\|\|` (return an operand, like JavaScript), `!`, `??` (null/undefined fallback), `cond ? a : b` |
| Lists | `[1, 2, ...other]` |
| Objects | `{a: 1, 'b-c': 2, [key]: 3, ...other, shorthand}` |
| Lambdas | `x => x.id`, `(item, index) => index`, `() => 1` |
| Calls | `join(list, ',')` |
| Pipes | `list \| join(',')` ≡ `join(list, ',')`; `value \| upper` (no parentheses needed without arguments) |

The pipe binds loosest, so `a + b | upper` is `upper(a + b)`. A lambda body
extends as far right as it can, pipes included: `map(i => i.tags | join(','))`.

Reading a missing property yields `undefined`, never an error, so
`response.body.data.items` is safe when `data` is absent.

## Scope

What a template can read depends on where it sits in the spec. The full
table is in the [spec reference](spec-reference.md#scope). The common roots:

| Root | Contents |
|---|---|
| `inputs` | the caller's inputs, after defaults |
| `auth` | the account's resolved credentials (`accessToken`, `apiKey`, `username`, …) |
| `account` | non-secret account data (`id`, `externalId`, `displayName`, `data`) |
| `config` | the connector's static `config` |
| `steps` | results of earlier `steps`, by name |
| `response` | `{status, headers, body}` of the current response (response mappings only) |
| `items` | every item collected across pages (search output only) |
| `page` | the pagination state (paging templates only) |
| `env` | values the host explicitly passes in — nothing from the process environment |

## Standard library

Every function takes its subject first, so each can be piped. Functions are
lenient with missing data: `null` or `undefined` in gives `null`, `undefined`
or an empty result out rather than an error.

**Values:** `default(v, fallback)` · `ifEmpty(v, fallback)` · `isEmpty(v)` · `type(v)` ·
`string(v)` · `number(v)` · `boolean(v)` · `json(v)` · `parseJson(text)` · `equals(a, b)`

**Text:** `upper` · `lower` · `trim` · `split(text, sep = ',')` · `join(list, sep = ',')` ·
`replace(text, find, replacement)` (literal, all occurrences) · `startsWith` · `endsWith` ·
`contains(textOrListOrObject, item)` · `substring(text, start, end?)` · `padStart(text, n, fill?)` ·
`length` · `urlEncode` · `urlDecode` · `base64` · `base64url` · `fromBase64`

**Lists:** `map(list, fn)` · `filter` · `find` · `some` · `every` · `flatMap` ·
`sortBy(list, fn, 'asc' | 'desc')` · `groupBy` · `first` · `last` · `slice(list, start, end?)` ·
`concat` · `reverse` · `unique` · `flatten` · `compact` · `range(start, end)` · `sum` · `min` · `max`

Wherever a function takes `fn`, a property path works too: `map(items, 'id')`,
`sortBy(items, 'meta.createdAt', 'desc')`.

**Objects:** `keys` · `values` · `entries` (→ `{key, value}`) · `fromEntries` · `merge(...objects)` ·
`pick(obj, ...keys)` · `omit(obj, ...keys)` · `get(value, 'a.b.0', fallback?)` · `compactObject`

**Numbers:** `round(n, digits?)` · `floor` · `ceil` · `abs`

**Dates** (always ISO-8601 text in and out; epoch numbers and all-digit strings are read as seconds below 10¹¹, as milliseconds above it):
`now()` · `date(v)` · `addTime(date, amount, unit)` (`ms s m h d w`) ·
`formatDate(date, 'iso' | 'date' | 'unix' | 'unixMs')` · `unix(date?)`

**Messages and trees:** `mime({ from, to, cc, bcc, replyTo, subject, text, html, attachments, inReplyTo, references, messageId, date, headers })` builds an RFC 5322 email (RFC 2047 headers, base64 bodies, alternative/mixed multipart, header injection stripped); pipe it into `base64url` for raw-message APIs. `flattenTree(tree, childrenKey = "parts")` lists every node depth first, e.g. the parts of a MIME payload.

**Crypto:** `uuid()` · `sha256(text, encoding?)` · `hash(text, 'sha1' | 'sha256' | 'sha384' | 'sha512', encoding?)` ·
`hmac(text, key, algorithm = 'sha256', encoding = 'hex')` ·
`signJwt(claims, key, algorithm = 'RS256', header?)` — `HS*` take a shared secret; `RS*`/`ES*`
take a PEM private key (PKCS#8, or PKCS#1 `RSA PRIVATE KEY`; escaped `\n` is accepted).
Encodings are `hex`, `base64` and `base64url`.

### Adding functions

Hosts add functions through a plugin (`registry.addFunctions`), and a connector
can define its own in `functions`:

```json
"functions": {
    "fullName": { "params": ["u"], "body": "u.first + ' ' + u.last" }
}
```

On its own, the engine takes a registry directly:

```ts
import { createFunctionRegistry, renderTemplate } from '@sigx/conduit/expr';

const functions = createFunctionRegistry({
    cents: { minArgs: 1, maxArgs: 1, signature: 'cents(amount)', call: ([v]) => Math.round(Number(v) * 100) }
});
await renderTemplate('{{ inputs.price | cents }}', { inputs: { price: 9.99 } }, { functions }); // 999
```

## Limits

| Limit | Default | Option |
|---|---|---|
| Node evaluations per render | 100 000 | `maxSteps` |
| Longest string produced | 5 000 000 characters | `maxStringLength` |
| Nesting depth | 200 | — |
| `range` size | 10 000 | — |

## Static analysis

`analyzeTemplate(value, { functions, roots })` parses every template in a
value without running it. It reports syntax errors, unknown functions and
unavailable roots, each with a path and an offset. Connector validation uses
it, so a typo is a validation error at load time instead of a failed call in
production.
