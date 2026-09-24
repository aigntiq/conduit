# @aigntiq/conduit-connectors

Ready-made [Conduit](https://github.com/aigntiq/conduit) connectors in one
package. Install once and pick the ones you use; only those are loaded.

```sh
pnpm add @aigntiq/conduit @aigntiq/conduit-connectors
```

```ts
import { createConduit, type CatalogOf } from '@aigntiq/conduit';
import { connectorCatalog, type Connectors } from '@aigntiq/conduit-connectors';

const conduit = createConduit<CatalogOf<Connectors>>({
    sources: connectorCatalog({ include: ['gmail'] }),   // or '*'
    secret: process.env.CONDUIT_SECRET!,
    redirectUri: 'https://app.example/conduit/auth/callback',
    clients: { gmail: { id: process.env.GOOGLE_CLIENT_ID!, secret: process.env.GOOGLE_CLIENT_SECRET } }
});

await conduit.execute({
    connector: 'gmail',
    operation: 'send-email',            // typed: operation ids, inputs and outputs
    account,
    inputs: { to: ['ada@example.com'], subject: 'Hello', body: '<p>Hi!</p>' }
});
```

Three ways in, all carrying the same spec:

| | |
|---|---|
| `connectorCatalog({ include })` | a `ConnectorSource`; each connector is loaded on first use |
| `@aigntiq/conduit-connectors/gmail` | the spec as a module, for bundlers and edge runtimes: `memorySource([gmail])` |
| `@aigntiq/conduit-connectors/json/gmail.json` | plain `conduit/1` JSON, for anything else |

Wrap the catalog in `compositeSource` with your own `fileSource` to override
one connector (earlier sources win), for example to pin an older version.

## Connectors

| Connector | Auth | Operations |
|---|---|---|
| [Gmail](connectors/gmail/README.md) | Google OAuth | send email, create draft, reply, search messages, get message, get conversation, download attachment, labels (options), add/remove labels, move to trash, new email (trigger) |
| [Google Calendar](connectors/google-calendar/README.md) | Google OAuth | calendars (options), search events, get event, create event (guests, Google Meet), quick add, update event, delete event, find busy times, event created or changed (trigger) |
| [Google Drive](connectors/google-drive/README.md) | Google OAuth | search files, get file, download file (Google files exported), upload file, create folder, rename/move/star, copy file, share file, move to trash, folders (options), new file (trigger) |
| [Microsoft Outlook](connectors/microsoft-outlook/README.md) | Microsoft OAuth | send email, create draft, reply (all), forward, search messages, get message, download attachment, folders (options), move message, mark/flag/categorize, delete message, new email (webhook trigger) |
| [Microsoft Calendar](connectors/microsoft-calendar/README.md) | Microsoft OAuth | calendars (options), search events, get event, create event (attendees, Teams meeting), update event, delete event, respond to invitation, find meeting times, free/busy, event created/changed/deleted (webhook trigger) |
| [Google Contacts](connectors/google-contacts/README.md) | Google OAuth | search contacts, get contact, create contact, update contact, delete contact, contact groups (options), add/remove group members, new contact (trigger) |

## Versioning

- Adding a connector or an operation is a **minor** release.
- Fixing a mapping is a **patch** release.
- Breaking any connector is a **major** release.

Each connector also carries its own `version`, and its changes are listed in
the [changelog](CHANGELOG.md).

## Contributing a connector

Connectors are written in TypeScript with `@aigntiq/conduit/builder`, in
`connectors/<id>/index.ts`, plus `icon.svg` and a README. They are compiled
by `pnpm --filter @aigntiq/conduit-connectors generate`. The build refuses any
connector with a validation diagnostic, and every connector needs replay
tests (see `__tests__/gmail.test.ts`) — a test checks each one has its icon,
README and `__tests__/<id>.test.ts`.

What a family of connectors shares lives in `connectors/_shared/` (a
directory without an `index.ts` is never built as a connector) — for example
`googleOAuth()` for every Google connector, and `microsoftOAuth()`,
`graphPaging()` and `graphSubscription()` (a Graph change-notification
webhook trigger) for every Microsoft 365 one. Replay tests build their scripted
provider with `scriptedHttp()` and connect an account with `connect()` from
`__tests__/support/stub.ts`.

MIT © Andreas Ekdahl
