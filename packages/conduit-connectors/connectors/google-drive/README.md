# Google Drive

Find, download, upload, organise, share and trash files, through the
[Google Drive API](https://developers.google.com/drive/api).

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project and **enable the Google Drive API**.
2. Configure the **OAuth consent screen** and add the scope `https://www.googleapis.com/auth/drive`.
3. Create an **OAuth client ID** of type *Web application*. Add your Conduit callback URL (e.g. `https://app.example/conduit/auth/callback`) as an **authorized redirect URI**.
4. Pass the client to Conduit: `createConduit({ clients: { 'google-drive': { id, secret } } })`.

`drive` is a **restricted** scope. It works right away for the test users on
your consent screen. Offering it to anyone else needs Google's app
verification, including a security assessment. The connected account is
identified by its email address.

## Files

Files and folders come back flat: `{ id, name, mimeType, folder, googleDoc,
parents, size, createdTime, modifiedTime, webViewLink, starred, trashed,
description, owner }`. Every operation also works on files in shared drives.

Search builds Drive's query language from plain fields and quotes every
value. `query` adds a raw Drive query for anything else.

`download-file` returns a file value `{ filename, contentType, base64, size }`,
ready to attach or upload elsewhere. Google Docs, Sheets and Slides have no
bytes of their own, so they are exported: as PDF by default, or as
Word/Excel/PowerPoint, CSV (a sheet's first tab), text or HTML. The export
format's extension is added to the name.

`upload-file` takes a file value and makes two calls. The first creates the
file with its name and folder; the second sends the bytes to it. If the
second call fails, an empty file with that name is left behind.

## Operations

| Operation | Kind | Notes |
|---|---|---|
| `search-files` | search | **read-only**. Name contains, folder, type (folders, Docs, Sheets, Slides, PDFs, images), raw query, trashed files optional; folders first, then newest. Pages of 100, at most 50 (lower it with `execute({ paging: { maxPages } })`) |
| `get-file` | action | **read-only** |
| `download-file` | action | **read-only**. A file value; Google files exported |
| `upload-file` | action | a file (up to 100 MB here) into a folder (default: My Drive), optionally renamed |
| `create-folder` | action | |
| `update-file` | action | rename, move to another folder, description, star; only the fields given |
| `copy-file` | action | optionally renamed, into another folder |
| `share-file` | action | a person or group (with an optional email), a domain, or anyone with the link; as viewer, commenter or editor |
| `trash-file` | action | **destructive**. Moves the file, or the folder and everything in it, to the trash (Drive deletes after 30 days) |
| `list-folders` | options | **read-only**. My Drive first, then folders by name; searchable |
| `new-file` | trigger (poll) | **read-only**. Files created after the trigger is turned on, in one folder or anywhere, checked every 2 minutes. The trigger is defined, but the trigger runtime is not released yet |

## Limits

Google exports files up to 10 MB. A larger Doc, Sheet or Slides file comes
back as a validation issue on `fileId`. Drive limits requests per user and
per project. Conduit retries `429` and `5xx` responses with backoff.
