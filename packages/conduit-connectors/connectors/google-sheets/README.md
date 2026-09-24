# Google Sheets

Read, append, update and clear rows, and create spreadsheets and sheets,
through the [Google Sheets API](https://developers.google.com/sheets/api).

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project and **enable the Google Sheets API and the Google Drive API**.
2. Configure the **OAuth consent screen** and add the scopes `https://www.googleapis.com/auth/spreadsheets` and `https://www.googleapis.com/auth/drive.metadata.readonly`.
3. Create an **OAuth client ID** of type *Web application*. Add your Conduit callback URL (e.g. `https://app.example/conduit/auth/callback`) as an **authorized redirect URI**.
4. Pass the client to Conduit: `createConduit({ clients: { 'google-sheets': { id, secret } } })`.

The Drive API is used only to list spreadsheets for the pickers and to
identify the account. `drive.metadata.readonly` sees names, never contents.
`spreadsheets` is a *sensitive* scope and `drive.metadata.readonly` a
*restricted* one, so offering the connector beyond your own test users needs
Google's verification.

## Rows and ranges

Operations take a spreadsheet, a sheet name (with pickers for both) and,
where it applies, a range in A1 notation within that sheet (`A2:D50`). Sheet
names are quoted for you.

Most sheets are tables with a header row, and the connector reads and writes
them that way:

- `get-values` returns `{ range, headers, rows }`, where each row is an object
  keyed by the header, for example `{ Name: 'Ada', Email: 'ada@example.com' }`.
  Pass `headerRow: false` to get plain lists instead.
- `append-rows` takes rows as lists of cell values, or as objects. An object
  is put in the header row's column order; keys the header lacks are ignored,
  and missing ones leave the cell empty.

Values are entered as if typed (`USER_ENTERED`), so `=SUM(A1:A3)` becomes a
formula and `2026-05-04` a date. Choose `RAW` to store them exactly as given.

## Operations

| Operation | Kind | Notes |
|---|---|---|
| `list-spreadsheets` | options | **read-only**. Most recently changed first; searchable |
| `list-sheets` | options | **read-only**. The tabs of the chosen spreadsheet, in order |
| `get-spreadsheet` | action | **read-only**. Title, URL, locale, time zone, and the sheets with their sizes |
| `create-spreadsheet` | action | a title and, optionally, the tab names to start with |
| `add-sheet` | action | a new tab; an existing name comes back as a validation issue on `title` |
| `get-values` | action | **read-only**. A sheet or range, as header-keyed objects or plain lists; formatted or raw values |
| `append-rows` | action | rows (lists or objects) below the table |
| `update-values` | action | rows of values written from the top-left of a range |
| `clear-values` | action | **destructive**. Empties a range, or the whole sheet, keeping formatting |
| `new-row` | trigger (poll) | **read-only**. Rows added below the last one seen, each with its row number, values and header-keyed record, checked every 2 minutes. The first check reports the rows already there. The trigger is defined, but the trigger runtime is not released yet |

## Limits

Sheets limits requests per minute, per user and per project. Conduit retries
`429` and `5xx` responses with backoff. A spreadsheet holds at most 10 million
cells.
