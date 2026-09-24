# Google Calendar

Find, create, update and delete events, and check when people are busy,
through the [Google Calendar API](https://developers.google.com/calendar/api).

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project and **enable the Google Calendar API**.
2. Configure the **OAuth consent screen** and add the scopes `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.readonly`.
3. Create an **OAuth client ID** of type *Web application*. Add your Conduit callback URL (e.g. `https://app.example/conduit/auth/callback`) as an **authorized redirect URI**.
4. Pass the client to Conduit: `createConduit({ clients: { 'google-calendar': { id, secret } } })`.

Both scopes are *sensitive*, not restricted. Test users work right away;
offering the app to anyone else needs Google's verification, but no security
assessment. The connected account is identified by its primary calendar,
whose id is the account's email address.

## Events

Every operation returns events in one flat shape. `start` and `end` are ISO
strings: a date-time for timed events, and a date for all-day events with
`allDay: true`. For all-day events `end` is exclusive: an event on 1 May ends
on `2026-05-02`. `attendees` lists `{ email, name, response, organizer }`, and
`meetLink` is the Google Meet link, if the event has one.

When creating an event, `end` defaults to one hour after `start`, or to the
next day for an all-day event. `calendarId` defaults to `primary`, and every
calendar picker loads its choices from `list-calendars`.

## Operations

| Operation | Kind | Notes |
|---|---|---|
| `list-calendars` | options | **read-only**: the calendars you can edit (or all of them), primary first |
| `search-events` | search | **read-only**: a time range (default: from now), free-text search, cancelled events optional. Recurring events are expanded into their occurrences, ordered by start. Pages of 250, at most 40 (lower it with `execute({ paging: { maxPages } })`) |
| `get-event` | action | **read-only** |
| `create-event` | action | title, start/end or all-day, time zone, location, description, guests, a Google Meet link, and `RRULE` recurrence. `sendUpdates` chooses who is notified (default: everyone) |
| `quick-add-event` | action | an event from a sentence, like "Lunch with Ada tomorrow 12:30" |
| `update-event` | action | changes only the fields given; `attendees` replaces the guest list |
| `delete-event` | action | **destructive**: deletes the event, or the whole series for a recurring event's id |
| `find-free-busy` | action | **read-only**: busy intervals per calendar (people's calendars by email address) in a time window |
| `event-changed` | trigger (poll) | **read-only**: events created, changed or cancelled after the trigger is turned on, checked every 2 minutes. The trigger is defined, but the trigger runtime is not released yet |

## Limits

Google Calendar enforces per-user and per-project quotas, and rate-limits
sending invitations to people outside your domain. Conduit retries `429` and
`5xx` responses with backoff. `quick-add-event` understands English best.
