# UI hints, forms and validation

A connector fully describes the forms a UI needs: the inputs of every
operation, and what each auth method asks for when connecting. Any renderer
(web components, React, a CLI prompt, an AI tool schema) can generate the
same form from it, and the browser and the server validate with **the same
function**.

The rule: standard JSON Schema wherever it has a keyword, and `x-` hints only
where it doesn't.

## The vocabulary

### Per field

| Keyword | Meaning |
|---|---|
| `title`, `description` | label and help text (the label defaults to the humanised key: `firstName` → "First name") |
| `default`, `examples` | standard |
| `readOnly`, `deprecated` | standard |
| `enum` | plain choices |
| `oneOf: [{ const, title, description? }]` | labelled choices: `{ "const": "INBOX", "title": "Inbox" }` |
| `format` | `email` (a bare address or `Name <address>`), `uri`, `date`, `date-time` and `uuid` are **validated**; `password` marks a secret |
| `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems` | constraints |
| `x-widget` | how to render (see below). Default: inferred |
| `x-placeholder` | placeholder text |
| `x-group` | the section the field belongs to |
| `x-order` | sort key within its group; ties keep declaration order |
| `x-advanced` | collapsed under "Advanced" |
| `x-visibleWhen` | show the field only when a [condition](#conditions) holds |
| `x-requiredWhen` | required only when a condition holds |
| `x-options` | dynamic choices: `{ operation, inputs?, dependsOn?, search? }` |
| `x-secret` | masked in UIs and traces |
| `x-accept`, `x-maxBytes` | `file` fields: accepted types (`image/*,.pdf`) and size cap |
| `x-language` | `code` fields |
| `x-errorMessage` | message overrides per issue code: `{ "pattern": "Use the format ABC-123" }` |

### Per input schema

`x-rules: [{ check, message, fields? }]` is for cross-field rules. `check` is
a template over `inputs` that must be truthy:

```json
"x-rules": [{ "check": "{{ length(inputs.to) + length(inputs.cc) > 0 }}", "message": "Add at least one recipient", "fields": ["to", "cc"] }]
```

Rules run in the browser too, so they see only `inputs` and should use
standard functions.

### Operations, auth methods, connectors

| Where | Keyword | Meaning |
|---|---|---|
| operation | `group` | catalog grouping ("Messages", "Labels") |
| operation | `destructive` | deletes or irreversibly changes data: UIs ask for confirmation |
| operation | `readOnly` | only reads: safe to run without confirmation (not with `destructive`) |
| operation | `helpUrl` | |
| auth method | `setup` | markdown instructions: register an app, the redirect URI, scopes |
| auth method | `helpUrl` | |
| connector | `brandColor`, `helpUrl` | `#rrggbb` |
| error rule | `field` | attribute a remote validation failure to an input |

## Widgets

The set is closed, so every renderer implements the same list:

`text` `textarea` `richtext` `markdown` `code` `password` `number` `toggle`
`select` `multiselect` `combobox` `date` `datetime` `email` `url` `emails`
`file` `json` `keyvalue` `list` `fieldset` `hidden`

When `x-widget` is absent, the widget is inferred by one table (`inferWidget`):

| Field | Widget |
|---|---|
| `x-secret`, or `format: password` | `password` |
| boolean | `toggle` |
| number/integer | `number` (`select` with choices) |
| string with `x-options` | `select`, or `combobox` when `search` is set |
| string with `enum`/`oneOf` | `select` |
| string with `format` `email` / `uri` / `date` / `date-time` | `email` / `url` / `date` / `datetime` |
| other string | `text` |
| array with options or choices (on itself or its items) | `multiselect` |
| array of `file` items | `file` (multiple) |
| array of email strings | `emails` |
| other array | `list` (repeat the item's editor) |
| object with `properties` | `fieldset` |
| object without | `keyvalue` |

`validateConnector` rejects a widget that can't render its type, e.g.
`toggle` on a string.

A `file` value is `{ filename, contentType, base64 }`. That is the shape the
`multipart` encoding and `mime()` accept.

## Conditions

```json
{ "mode": "later" }                       // equals
{ "mode": { "in": ["later", "draft"] } }  // one of
{ "threadId": { "notEmpty": true } }      // has a value ("", [], {} count as empty)
{ "cc": { "empty": true } }
```

Several keys in one condition must all hold. Conditions refer to fields
**next to** the field, i.e. in the same object.

## The form model

```ts
const model = await conduit.connectors.form('gmail', { operation: 'send-email' });
const auth  = await conduit.connectors.form('acme-crm', { authMethod: 'key' });
// HTTP: GET {base}/connectors/:id/forms/:operation
//       GET {base}/connectors/:id/auth/:method/form
// Standalone: buildForm(inputSchema)
```

`FormModel` is plain JSON:

```ts
{
  groups: [{ name?: string, advanced: boolean, fields: FormField[] }],   // unnamed first; advanced after regular
  rules:  [{ check, message, fields? }],
  schema: InputSchema
}
```

Each `FormField` has:

- `name`, `path`, `label`, `description`, `type`, `widget`;
- `required`, `requiredWhen`, `visibleWhen`;
- `default`, `placeholder`, `examples`, `readOnly`, `deprecated`, `secret`, `multiple`;
- `choices: [{ value, label }]`;
- `options: { operation, inputs, dependsOn, search }`;
- `accept`, `maxBytes`, `language`;
- `constraints: { minimum, maximum, minLength, maxLength, pattern, format, minItems, maxItems }`;
- `messages`, `group`, `advanced`;
- `item` (for arrays) and `fields` (for objects).

A renderer walks the model and never re-derives anything.

### Dynamic options

A field with `options` loads its choices from
`POST {base}/options/:connector/:operation`, sending the `inputs` rendered
over the current values. It reloads when a field in `dependsOn` changes. With
`search`, it sends the typed text as that input, which makes it a searchable
`combobox`.

## Validation

```ts
import { validateForm, prepareForm } from '@aigntiq/conduit';

const issues = await validateForm(model, values);      // [{ path, code, params?, message }]
const { value, issues } = await prepareForm(model, values);
```

`prepareForm` is exactly what the runtime runs before every `execute` and
`connect`. In order:

1. **Defaults** are applied.
2. **Coercion** goes toward the declared type, and only there:
   - `"5"` → `5`, `"true"` → `true`;
   - `""` counts as missing for non-string fields;
   - for values resolved from elsewhere: a single item becomes a one-item list, and JSON text becomes an object or list.
3. **Hidden fields** (`x-visibleWhen` false) are **dropped** — not validated, not sent.
4. **Fields are validated**, one issue per field (the first problem). `x-requiredWhen` counts.
5. **Rules** run.

Issue codes: `required`, `type`, `enum`, `const`, `format`, `minLength`,
`maxLength`, `pattern`, `minimum`, `maximum`, `minItems`, `maxItems`,
`uniqueItems`, `rule`, and `remote` (see below). `params` carries the
specifics, e.g. `{ limit: 3 }` or `{ format: 'email' }`, so a UI can
translate. `x-errorMessage` overrides a message per code.

### Remote validation

Some checks only the API can make ("this address bounces"). An error rule
with `field` turns such a response into a field issue:

```json
"errors": [{ "when": "{{ response.body.error.reason == 'invalidRecipient' }}", "error": "validation", "field": "to", "message": "One of the recipients is not valid" }]
```

The thrown `ConduitRequestError` carries
`issues: [{ path: 'inputs.to', code: 'remote', message }]`, and the HTTP
surface answers 422 with them.

## Hosts with dynamic bindings

A workflow editor lets a field be **bound**, for example to the output of an
earlier step. At design time its value doesn't exist yet. Conduit doesn't
know about workflows, but the form layer is built for this. Pass the bound
paths:

```ts
await validateForm(model, values, { bound: ['to', 'attachments'] });
```

- A bound field **satisfies `required`**, and its value checks are **deferred**.
- Conditions are **three-valued**: a condition that reads a bound field is *unknown*.
  - An unknown `visibleWhen` keeps the field **visible**.
  - An unknown `requiredWhen` is **not enforced**.
- A **rule** that reads a bound field is **deferred**.
- A field whose `options.dependsOn` includes a bound field can't load choices yet. The editor should offer free entry or a binding instead.

At run time the host resolves its bindings and calls `execute`. The same
rules then run on real values, and values that arrive as text (`"5"`,
`'["a","b"]'`, a single address for a list) are coerced as described above.
