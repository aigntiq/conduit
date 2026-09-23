# Gmail

Send, draft, reply, search, read, label and trash email in a Gmail account,
through the [Gmail API](https://developers.google.com/gmail/api).

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project and **enable the Gmail API**.
2. Configure the **OAuth consent screen** and add the scope `https://www.googleapis.com/auth/gmail.modify`.
3. Create an **OAuth client ID** of type *Web application*. Add your Conduit callback URL (e.g. `https://app.example/conduit/auth/callback`) as an **authorized redirect URI**.
4. Pass the client to Conduit: `createConduit({ clients: { gmail: { id, secret } } })`.

`gmail.modify` is a **restricted** scope. It works right away for the test
users on your consent screen. Offering it to anyone else needs Google's app
verification, including a security assessment.

Connecting asks for offline access and always shows consent, so Google
returns a refresh token. Conduit then renews the one-hour access token by
itself.

## Operations

| Operation | Kind | Notes |
|---|---|---|
| `send-email` | action | to/cc/bcc (at least one), subject, HTML or plain body, attachments, send-as alias, reply-to, optional thread. Bad recipients come back as a validation issue on the field |
| `create-draft` | action | same fields as `send-email` |
| `reply-to-message` | action | replies in the thread with correct `In-Reply-To`/`References`, to the sender's Reply-To (or From), optional reply-all |
| `search-messages` | search | **read-only** — Gmail search syntax, label filter, up to 50 pages of 100 |
| `get-message` | action | **read-only** — headers, decoded text and HTML bodies, attachment list |
| `get-thread` | action | **read-only** — the conversation's messages with their main headers |
| `get-attachment` | action | **read-only** — returns a file value `{ filename, contentType, base64, size }`, ready to attach elsewhere |
| `list-labels` | options | **read-only** — system labels first; searchable |
| `modify-labels` | action | add and/or remove labels (label pickers load from `list-labels`) |
| `trash-message` | action | **destructive** — moves to Trash (Gmail deletes after 30 days) |
| `new-email` | trigger (poll) | **read-only** — new messages matching a search, every 60 s. Defined; the trigger runtime is not released yet |

## Limits

Gmail allows messages up to 25 MB including attachments, and 500 recipients
per message for consumer accounts. Rate limits are per user and per project.
Conduit retries `429` and `5xx` responses with backoff.
