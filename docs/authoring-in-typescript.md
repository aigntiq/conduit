# Authoring connectors in TypeScript

`@sigx/conduit/builder` writes connectors as TypeScript that compiles to
ordinary `conduit/1` JSON. JSON stays the runtime contract. The builder adds:

- **typed templates:** `inputs.emial` is a compile error, not a load-time diagnostic;
- **reuse:** pagination blocks, error rules and field sets are plain functions and constants;
- **typed calls for hosts:** each operation's input and output types carry through to `conduit.execute`.

Everything the builder produces is data. Builder functions run once, at build
time, and never at request time.

```ts
import { $, action, connector, email, expr, string, auth, search, paging, rules, emails, richtext, files } from '@sigx/conduit/builder';

export default connector({
    id: 'acme',
    name: 'Acme',
    version: '1.0.0',
    http: { baseUrl: 'https://api.acme.example/v1' },
    auth: [auth.bearer('token', { test: { url: '/me' } })],
    operations: [
        action('create-contact', {
            label: 'Create contact',
            inputs: {
                email: email({ title: 'Email' }),
                name: string().optional()
            },
            request: ({ inputs }) => ({ method: 'POST', url: '/contacts', body: { email: inputs.email, name: inputs.name } }),
            output: ({ response }) => response.body
        })
    ]
});
```

## Fields

Every helper takes the UI and validation hints from [ui-hints](ui-hints.md)
as options. Fields are **required unless** `.optional()`.

| Helper | Compiles to |
|---|---|
| `string()`, `text()`, `richtext()` | string (`textarea` / `richtext` widget) |
| `email()`, `url()`, `date()`, `datetime()` | string with `format` |
| `secret()` | string, `format: password`, `x-secret` |
| `select(['a', 'b'])` | `enum` |
| `select({ a: 'Label A' })` | labelled `oneOf` |
| `number()`, `integer()`, `boolean()` | |
| `array(item)`, `emails()` | arrays |
| `file()`, `files()` | `{ filename, contentType?, base64 }` (`file` widget) |
| `object({...})`, `json()` | objects |

The shared options are:
- labels and help: `title`, `description`, `placeholder`;
- values: `default`, `examples`;
- layout: `group`, `order`, `advanced`;
- state: `readOnly`, `deprecated`, `secret`;
- rendering: `widget`;
- conditions: `visibleWhen` and `requiredWhen` (build them with `when.equals/in/notEmpty/empty/all`);
- `messages`: message overrides per issue code.

Constraints and dynamic options (`options: { operation, dependsOn, search }`)
sit on the helpers they apply to.

Cross-field rules go on the operation, for example
`rules: [rules.atLeastOne(['to', 'cc', 'bcc'])]`.

## Templates

The builder functions (`request`, `output`, `errors`, `steps`, `paginate`,
`http`, auth definitions) receive **refs** to the scope roots:

| Write | Compiles to |
|---|---|
| `inputs.email` | `"{{inputs.email}}"` (raw value when used whole) |
| `` $`/users/${inputs.id}` `` | `"/users/{{inputs.id}}"` |
| `` expr`${inputs.to} \| join(', ')` `` | `"{{inputs.to \| join(\", \")}}"` |
| `` expr`${response.status} == 404` `` | `"{{response.status == 404}}"` |

- **`inputs` is typed** from the declared fields, so a misspelled input doesn't compile.
- **Everything else is untyped** (`response`, `auth`, `config`, `steps`, `items`, …), because the API decides its shape. Any path is allowed.
- To read something the types don't know, use `ref('inputs.legacyField')`.

## Operations

- **Operation types:** `action`, `search` (with `paginate: paging.cursor/offset/page/nextUrl/linkHeader(...)`), `options`, `pollTrigger`, `webhookTrigger`.
- **Shared fields:** each takes `label`, `description`, `group`, `destructive`, `helpUrl`, `hidden`, `tags`, `auth`, `inputs`, `rules`, `outputs`, `steps`, `output`, `errors` and `retry`.
- **Auth:** `auth.oauth2`, `auth.apiKey`, `auth.basic`, `auth.bearer`, `auth.jwt`, `auth.custom`. Their definitions can be a function of the scope.

## Typed `execute`

Declare `outputs` with the same helpers to type the result. Then:

```ts
import { createConduit, type CatalogOf } from '@sigx/conduit';
import acme from './connectors/acme';

const conduit = createConduit<CatalogOf<typeof acme>>({ sources: memorySource([acme]), secret });

const { output } = await conduit.execute({
    connector: 'acme',                 // checked
    operation: 'create-contact',       // checked
    inputs: { email: 'ada@example.com' } // checked: required fields, types
});
```

For connectors shipped as JSON, `emitTypes(spec)` prints a `.d.ts` that
gives the default export the same phantom types.
`CatalogOf<typeof gmail | typeof acme>` combines several connectors.

## Compiling to JSON

`connector(...)` already returns the JSON object, so `JSON.stringify` it.
Validate it with `validateConnector` as part of the build, so a connector
with any diagnostic never ships.
