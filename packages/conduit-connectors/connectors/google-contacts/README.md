# Google Contacts

Search, create, update and delete contacts, and organise them into groups,
through the [People API](https://developers.google.com/people).

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project and **enable the People API**.
2. Configure the **OAuth consent screen** and add the scope `https://www.googleapis.com/auth/contacts`.
3. Create an **OAuth client ID** of type *Web application*. Add your Conduit callback URL (e.g. `https://app.example/conduit/auth/callback`) as an **authorized redirect URI**.
4. Pass the client to Conduit: `createConduit({ clients: { 'google-contacts': { id, secret } } })`.

`contacts` is a *sensitive* scope. Test users work right away; offering the
app to anyone else needs Google's verification, but no security assessment.
The connected account is identified by its email address.

## Contacts

Contacts come back flat: `{ id, resourceName, name, givenName, familyName,
emails, phones, organization, jobTitle, address, birthday, notes, groups,
photo }`. `id` is the short id (`c123…`); every operation takes either that
or the resource name (`people/c123…`). A birthday is `1990-05-04`, or
`--05-04` when it has no year. `groups` holds contact group resource names.

`update-contact` changes only the fields given. Emails and phones replace the
stored lists, and a first or last name on its own keeps the other half.
It sends the contact's current `etag`, so a concurrent change comes back as a
`conflict` instead of being overwritten.

## Operations

| Operation | Kind | Notes |
|---|---|---|
| `search-contacts` | search | **read-only**. With text, a prefix match on names, emails, phones and companies (one page of up to 30). Without it, every contact sorted by first name, in pages of 1000, at most 50 (lower it with `execute({ paging: { maxPages } })`) |
| `get-contact` | action | **read-only** |
| `create-contact` | action | name, emails, phones, company and title, address, birthday, notes, groups; needs at least a name, email, phone or company |
| `update-contact` | action | only the fields given, guarded by the contact's etag |
| `delete-contact` | action | **destructive** |
| `list-contact-groups` | options | **read-only**. Your own groups plus Starred |
| `modify-group-members` | action | add and/or remove contacts in a group; returns the ids Google didn't find |
| `new-contact` | trigger (poll) | **read-only**. Contacts added after the trigger is turned on, checked every 5 minutes. The trigger is defined, but the trigger runtime is not released yet |

## Limits

The People API limits requests per user per minute, and contact writes per
user more strictly. Conduit retries `429` and `5xx` responses with backoff.
Search is served from a cache Google builds per user, so a contact created a
moment ago may take a little while to be found by text.
