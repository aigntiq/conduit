# Microsoft Outlook

Send, draft, reply, forward, search, read, file and delete email in a
Microsoft 365 or Outlook.com mailbox, through
[Microsoft Graph](https://learn.microsoft.com/graph/outlook-mail-concept-overview).

## Setup

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **App registrations** and create a **New registration**. Choose who may sign in; accounts in any organization plus personal accounts suit the default `tenant: common`.
2. Under **Authentication**, add a **Web** platform with your Conduit callback URL (e.g. `https://app.example/conduit/auth/callback`) as a redirect URI.
3. Under **Certificates & secrets**, create a **client secret**.
4. Under **API permissions**, add the Microsoft Graph *delegated* permissions `offline_access`, `User.Read`, `Mail.ReadWrite` and `Mail.Send`.
5. Pass the client to Conduit: `createConduit({ clients: { 'microsoft-outlook': { id, secret } } })`.

Sign-in goes through `login.microsoftonline.com/{tenant}`, where the tenant
is `config.tenant`:

- `common` (the default): work, school and personal accounts
- `organizations`: work and school only
- `consumers`: personal only
- a tenant id or domain: one organization

For example: `createConduit({ config: { 'microsoft-outlook': { tenant: 'contoso.onmicrosoft.com' } } })`.
Some organizations require an administrator to consent to the permissions
first.

The account is identified by its Microsoft object id, which is stable, and
displayed by its mailbox address.

## Messages

Recipients are plain address lists; `Name <address>` keeps the name.
Attachments are file values, up to the 150 MB a message may hold. Those of
3 MB or less go with the message, which is Graph's limit for that. Larger ones
go through upload sessions, and `send-email` and `create-draft` do that for
you:
1. The message is saved as a draft, with the small attachments.
2. Each large attachment gets an upload session and is sent in parts of about
   2.9 MB. The parts go to the session's own URL, never with the account's
   credentials.
3. The draft is sent, or, for `create-draft`, returned.

A message without large attachments is still a single call.

Messages come back flat: `{ id, conversationId, subject, from, to, cc,
receivedAt, sentAt, isRead, isDraft, importance, hasAttachments, preview,
webLink, categories, flagged, folderId }`. Addresses are `{ name, address }`.
`get-message` adds the body (HTML, or text on request) and the attachment
list.

## Without a signed-in user

For automation on a shared or service mailbox, connect an account with the
`app` method instead: OAuth client credentials, no user present. Each such
account acts on one mailbox.

```ts
await conduit.auth.begin({
    connector: 'microsoft-outlook',
    method: 'app',
    owner,
    inputs: { tenantId: 'contoso.onmicrosoft.com', mailbox: 'shared@contoso.com' }
});
```

1. Use the same app registration and client secret, or a separate one.
2. Under **API permissions**, add the Microsoft Graph *application* permissions `Mail.ReadWrite` and `Mail.Send`, then **Grant admin consent**.
3. Application permissions reach every mailbox in the tenant. Limit the app to the mailboxes it should use with [RBAC for Applications in Exchange Online](https://learn.microsoft.com/exchange/permissions-exo/application-rbac).

Connecting mints a token for the tenant (`https://graph.microsoft.com/.default`)
and reads its Inbox folder to prove access. There is no redirect, and a new token is
minted whenever the old one expires. The account is named by its mailbox, and
every operation acts on `/users/<mailbox>` instead of `/me`. The `new-email` trigger subscribes to that mailbox.

## Operations

| Operation | Kind | Notes |
|---|---|---|
| `send-email` | action | to/cc/bcc (at least one), subject, HTML or text, importance, attachments (large ones through upload sessions), reply-to; kept in Sent Items. A bad address comes back as a validation issue on `to` |
| `create-draft` | action | same fields; saved in Drafts |
| `reply-to-message` | action | reply, or reply to all, in the conversation, with Outlook's quoting |
| `forward-message` | action | to one or more addresses, with a note |
| `search-messages` | search | **read-only**. Search text (as in Outlook's search box: `from:`, `subject:` …), a folder or the whole mailbox, unread only. Newest first without search text; pages of 50, at most 20 (lower it with `execute({ paging: { maxPages } })`) |
| `get-message` | action | **read-only**. The message, with its body (HTML or text) and attachment list |
| `get-attachment` | action | **read-only**. A file value `{ filename, contentType, base64, size }` |
| `list-folders` | options | **read-only**. Top-level mail folders, Inbox and the other standard ones first; searchable |
| `move-message` | action | to another folder; the moved message has a **new id**, which is returned |
| `update-message` | action | read/unread, flag, categories, importance; only the fields given |
| `delete-message` | action | **destructive**. Moves the message to Deleted Items |
| `new-email` | trigger (webhook) | **read-only**. A Graph subscription on a folder (the Inbox by default). Each event is `{ id, changeType, subscriptionId }`; get the message for the rest. The subscription is renewed every 2 days; only notifications carrying its secret `clientState` are accepted. The trigger is defined, but the trigger runtime is not released yet |

## Limits

Graph throttles per mailbox and per app, answering `429` with `Retry-After`.
Conduit waits and retries. A message holds up to 150 MB in total. An
attachment larger than 3 MB takes one request per 2.9 MB part, and the host
must allow the upload-session hosts, `outlook.office.com` and
`outlook.office365.com`. The connector already declares them.
