# Microsoft Calendar

Find, create, update, answer and delete events in Outlook calendars
(Microsoft 365 and Outlook.com), and find times that suit everyone, through
[Microsoft Graph](https://learn.microsoft.com/graph/outlook-calendar-concept-overview).

## Setup

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **App registrations** and create a **New registration**. Choose who may sign in; accounts in any organization plus personal accounts suit the default `tenant: common`.
2. Under **Authentication**, add a **Web** platform with your Conduit callback URL (e.g. `https://app.example/conduit/auth/callback`) as a redirect URI.
3. Under **Certificates & secrets**, create a **client secret**.
4. Under **API permissions**, add the Microsoft Graph *delegated* permissions `offline_access`, `User.Read` and `Calendars.ReadWrite`.
5. Pass the client to Conduit: `createConduit({ clients: { 'microsoft-calendar': { id, secret } } })`.

Sign-in goes through `login.microsoftonline.com/{tenant}`, where the tenant
is `config.tenant`: `common` (the default), `organizations`, `consumers`, or
a tenant id or domain. The account is identified by its Microsoft object id,
and displayed by its mailbox address.

## Times

Every request asks Graph for UTC, so events come back with ISO `start`/`end`
ending in `Z`. An all-day event has a plain date instead, `allDay: true` and
an exclusive end: an event on 6 May ends on `2026-05-07`.

When writing, `start` and `end` take a date-time with its offset
(`2026-05-04T09:00:00+02:00` or `…Z`), which is stored as UTC. A plain date
always makes an all-day event. `end` defaults to an hour after the start, or
to the next day for an all-day event. `calendarId` defaults to your main
calendar, and every calendar picker loads from `list-calendars`.

Events come back flat: `{ id, subject, preview, start, end, allDay, location,
organizer, attendees, onlineMeeting, joinUrl, showAs, cancelled, myResponse,
webLink, seriesMasterId, type, categories, importance, created, updated }`.

## Operations

| Operation | Kind | Notes |
|---|---|---|
| `list-calendars` | options | **read-only**. Calendars you can edit (or all of them), your main one first |
| `search-events` | search | **read-only**. A calendar view between two times (default: the next 30 days), recurring events expanded, earliest first, optional subject filter. Pages of 50, at most 20 (lower it with `execute({ paging: { maxPages } })`) |
| `get-event` | action | **read-only**. The event with its description (`body`) |
| `create-event` | action | title, start/end or all-day, location, description, required and optional attendees, a Teams meeting, reminder, show-as, categories |
| `update-event` | action | only the fields given; attendees, when given, replace the list |
| `delete-event` | action | **destructive**. A meeting you organize is cancelled for its attendees; a series goes as a whole |
| `respond-to-event` | action | accept, tentatively accept or decline, with an optional note |
| `find-meeting-times` | action | **read-only**. Slots of a given length in a window when the attendees are free, best first, with each attendee's availability |
| `get-schedule` | action | **read-only**. Busy times of people or rooms between two times |
| `event-changed` | trigger (webhook) | **read-only**. A Graph subscription on a calendar (your main one by default) for created, changed and deleted events. Each event is `{ id, changeType, subscriptionId }`; get the event for the rest. The subscription is renewed every 2 days; only notifications carrying its secret `clientState` are accepted. The trigger is defined, but the trigger runtime is not released yet |

## Limits

Graph throttles per mailbox and per app, answering `429` with `Retry-After`.
Conduit waits and retries. Group calendars, and app-only access without a
signed-in user, are not supported yet.
