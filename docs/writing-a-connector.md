# Writing a connector

This walkthrough builds a connector for a fictional to-do API, step by
step. Every field is documented in the [spec reference](spec-reference.md),
and templates use [Conduit expressions](expressions.md).

## 1. The manifest

`connectors/todo/connector.json`:

```json
{
    "$schema": "../../node_modules/@aigntiq/conduit/schema/conduit-1.schema.json",
    "spec": "conduit/1",
    "id": "todo",
    "name": "Todo",
    "version": "1.0.0",
    "config": { "baseUrl": "https://api.todo.example" },
    "http": {
        "baseUrl": "{{config.baseUrl}}/v1",
        "headers": { "Accept": "application/json" }
    }
}
```

Keep hosts in `config` so a host can point the connector at a sandbox
(`createConduit({ config: { todo: { baseUrl } } })`) without editing it.

## 2. Authentication

`connectors/todo/auth.json`:

```json
[
    {
        "id": "oauth",
        "type": "oauth2",
        "authorizeUrl": "https://todo.example/oauth/authorize",
        "tokenUrl": "https://todo.example/oauth/token",
        "scopes": ["tasks:read", "tasks:write"],
        "identity": {
            "request": { "url": "/me" },
            "id": "{{response.body.id}}",
            "name": "{{response.body.email}}"
        },
        "test": { "url": "/me" }
    },
    { "id": "token", "type": "bearer", "label": "Personal access token", "test": { "url": "/me" } }
]
```

That is the whole OAuth integration. Conduit handles the rest: PKCE, state,
the code exchange, refresh (early and single-flight), revocation and
injecting `Authorization: Bearer …`. `identity` gives the account a stable id
and a name, so connecting the same user twice updates one account instead of
creating two.

## 3. Operations

`connectors/todo/operations/create-task.json` (the id comes from the file name):

```json
{
    "kind": "action",
    "label": "Create task",
    "inputs": {
        "type": "object",
        "properties": {
            "title": { "type": "string", "minLength": 1 },
            "due": { "type": "string", "format": "date" },
            "project": { "type": "string", "x-options": { "operation": "list-projects" } }
        },
        "required": ["title"]
    },
    "request": {
        "method": "POST",
        "url": "/tasks",
        "body": { "title": "{{inputs.title}}", "due_on": "{{inputs.due}}", "project_id": "{{inputs.project}}" }
    },
    "errors": [
        { "when": "{{response.status == 422 && response.body.field == 'due_on'}}", "error": "validation", "message": "Due date must be in the future" }
    ],
    "output": "{{ {id: response.body.id, url: response.body.links.html} }}"
}
```

- Inputs the caller left out render `undefined` and **disappear** from the body. No nulls are sent.
- `x-options` tells UIs to fill the dropdown from an `options` operation.

`list-projects.json` (an `options` operation):

```json
{
    "kind": "options",
    "label": "Projects",
    "request": { "url": "/projects" },
    "output": "{{response.body.projects | map(p => {label: p.name, value: p.id})}}"
}
```

`list-tasks.json` (a paged `search`):

```json
{
    "kind": "search",
    "label": "List tasks",
    "request": { "url": "/tasks", "query": { "status": "{{inputs.status}}" } },
    "paginate": {
        "style": "cursor",
        "param": "after",
        "items": "{{response.body.data}}",
        "next": "{{response.body.paging.next}}",
        "pageSize": 100,
        "pageSizeParam": "limit",
        "maxPages": 20
    },
    "output": "{{items | map(t => pick(t, 'id', 'title', 'due_on'))}}"
}
```

## 4. Validate

```ts
import { validateConnector } from '@aigntiq/conduit';
import { fileSource } from '@aigntiq/conduit/node';

const [todo] = await fileSource('./connectors').list();
console.log(validateConnector(todo).diagnostics);
```

Validation parses every template and checks that each function exists and
each root is readable where it is used (`response` in a request URL is a
warning, for instance). It also checks every cross-reference. `createConduit`
refuses to load an invalid connector, and `conduit.connectors.diagnostics()`
lists the problems.

## 5. Test it against a fake

Point `config.baseUrl` at a local server and connect through
`auth.connect`/`auth.begin`, or pass `createConduit({ http })` a stub
`fetch` that answers from a table. See
`packages/conduit/__tests__/runtime/auth-types.test.ts` for the stub
pattern.

## Tips

- Put reusable mappings in `functions` (`"toTask": { "params": ["t"], "body": "{id: t.id, …}" }`) and call them from any template.
- Use `steps` when a call needs data from an earlier one: a lookup, an upload URL, a CSRF token.
- Prefer rules in `errors` over default classification for APIs that answer `200 {"ok": false}`.
- Mark secret inputs `x-secret` (or `format: "password"`), so UIs mask them and traces never show them.
- If an operation must reach a host other than `baseUrl` (a CDN, a regional endpoint), list it in `http.allowHosts`.
