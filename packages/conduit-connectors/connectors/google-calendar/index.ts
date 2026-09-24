/**
 * Google Calendar — find, read, create, change and delete events, and ask
 * when people are busy.
 *
 * Google keeps timed events in `start.dateTime` and all-day events in
 * `start.date` (with an exclusive end date); the connector takes one ISO
 * `start`/`end` pair plus `allDay` and maps both ways.
 */
import {
    $,
    action,
    array,
    boolean,
    connector,
    datetime,
    emails,
    expr,
    object,
    options,
    paging,
    pollTrigger,
    search,
    select,
    string,
    text,
    type ErrorRuleDef,
    type Ref
} from '@aigntiq/conduit/builder';
import { googleOAuth, googleRetry, googleSetup } from '../_shared/google';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];

// ── Shared pieces ───────────────────────────────────────────────────────

const calendarOptions = { operation: 'list-calendars' };

/**
 * A start or end: a date-time, or a plain date for all-day events. Shown as a
 * date-time picker; validated loosely because `datetime()` refuses a date.
 */
const moment = (options: { title: string; description?: string; group?: string }) =>
    string({
        ...options,
        widget: 'datetime',
        // A date, or an RFC 3339 date-time with its offset (seconds and fraction optional):
        // without one, the default end would depend on the server's zone.
        pattern: String.raw`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$`,
        messages: { pattern: 'Use a date (2026-05-04) or a date and time with its offset (2026-05-04T09:00:00+02:00)' }
    });

const calendarField = string({ title: 'Calendar', default: 'primary', options: calendarOptions });

const sendUpdates = select(
    { all: 'Everyone', externalOnly: 'Only people outside the organization', none: 'No one' },
    { title: 'Notify guests', default: 'all', advanced: true }
);

/** `/calendars/<calendarId>/events[/<eventId>]`, both URL-encoded. */
function eventsUrl(calendarId: unknown, eventId?: unknown) {
    const base = $`/calendars/${expr`urlEncode(${calendarId})`}/events`;
    return eventId === undefined ? base : $`/calendars/${expr`urlEncode(${calendarId})`}/events/${expr`urlEncode(${eventId})`}`;
}

/** A Google `start`/`end` object — see the `timeOf` function below. */
function timeOf(value: unknown, allDay: unknown, timeZone: Ref) {
    return expr`timeOf(${value}, ${allDay}, ${timeZone})`;
}

const eventOutput = object({
    id: string(),
    status: string(),
    summary: string().optional(),
    description: string().optional(),
    location: string().optional(),
    start: string(),
    end: string(),
    allDay: boolean(),
    timeZone: string().optional(),
    organizer: string().optional(),
    attendees: array(object({ email: string(), name: string().optional(), response: string().optional(), organizer: boolean().optional() })),
    meetLink: string().optional(),
    htmlLink: string().optional(),
    recurringEventId: string().optional(),
    created: string().optional(),
    updated: string().optional()
});

/** Guests as Google wants them — absent stays absent, so a PATCH never clears the list by accident. */
function guests(emails: Ref) {
    return expr`${emails} == undefined ? undefined : map(${emails}, email => {email})`;
}

/** Google answers 404 for a missing event and 410 for a deleted one. */
function notFound(response: Ref, field: string, what = 'event'): ErrorRuleDef {
    return { when: expr`${response.status} == 404 || ${response.status} == 410`, error: 'notFound', field, message: `That ${what} does not exist` };
}

/** Google rejects an end before the start as a 400 about the time range. */
function badRange(response: Ref, field: string): ErrorRuleDef {
    return {
        when: expr`${response.status} == 400 && contains(lower(default(${response.body.error.message}, '')), 'time range')`,
        error: 'validation',
        field,
        message: 'The end must be after the start'
    };
}

// ── Connector ───────────────────────────────────────────────────────────

export default connector({
    id: 'google-calendar',
    name: 'Google Calendar',
    version: '1.0.0',
    description: 'Find, create, update and delete events in Google Calendar, and check when people are free.',
    categories: ['calendar', 'productivity'],
    brandColor: '#1a73e8',
    homepage: 'https://calendar.google.com',
    helpUrl: 'https://developers.google.com/calendar/api',
    config: { baseUrl: 'https://www.googleapis.com/calendar/v3' },
    functions: {
        timeOf: {
            params: ['value', 'allDay', 'timeZone'],
            description: 'A Google start/end object: `date` for all-day events and plain dates, `dateTime` (with an optional zone) otherwise.',
            body: 'value == undefined ? undefined : (allDay || length(value) == 10 ? {date: substring(value, 0, 10)} : compactObject({dateTime: value, timeZone}))'
        },
        eventOf: {
            params: ['e'],
            description: 'A Google Calendar event, flattened: one ISO start/end, attendees with plain names.',
            body: `{
                id: e.id,
                status: e.status,
                summary: e.summary,
                description: e.description,
                location: e.location,
                start: e.start.dateTime ?? e.start.date,
                end: e.end.dateTime ?? e.end.date,
                allDay: e.start.date != undefined,
                timeZone: e.start.timeZone,
                organizer: e.organizer.email,
                attendees: map(default(e.attendees, []), a => compactObject({email: a.email, name: a.displayName, response: a.responseStatus, organizer: a.organizer})),
                meetLink: e.hangoutLink,
                htmlLink: e.htmlLink,
                recurringEventId: e.recurringEventId,
                created: e.created,
                updated: e.updated
            } | compactObject`
        }
    },
    http: ({ config }) => ({
        baseUrl: config.baseUrl,
        headers: { Accept: 'application/json' },
        retry: googleRetry
    }),
    auth: [
        googleOAuth(({ response }) => ({
            scopes: SCOPES,
            // The primary calendar's id is the account's email address.
            identity: {
                request: { url: '/calendars/primary' },
                id: response.body.id,
                name: expr`default(${response.body.summary}, ${response.body.id})`
            },
            test: { url: '/calendars/primary' },
            helpUrl: 'https://developers.google.com/calendar/api/auth',
            setup: googleSetup('Google Calendar API', 'google-calendar', SCOPES)
        }))
    ],
    operations: [
        options('list-calendars', {
            label: 'Calendars',
            readOnly: true,
            inputs: { writable: boolean({ title: 'Only calendars I can edit', default: true }).optional() },
            request: ({ inputs }) => ({ url: '/users/me/calendarList', query: { minAccessRole: expr`${inputs.writable} == false ? 'reader' : 'writer'`, maxResults: 250 } }),
            paginate: ({ response }) => paging.cursor({ param: 'pageToken', items: response.body.items, next: response.body.nextPageToken }),
            output: ({ items }) =>
                expr`${items}
                    | sortBy(c => (c.primary ? '0' : '1') + lower(default(c.summaryOverride, c.summary)))
                    | map(c => {label: default(c.summaryOverride, c.summary), value: c.primary ? 'primary' : c.id})`
        }),

        search('search-events', {
            label: 'Search events',
            description: 'Events in a time range, optionally matching text. Recurring events are expanded into their occurrences.',
            group: 'Events',
            readOnly: true,
            inputs: {
                calendarId: calendarField.optional(),
                from: datetime({ title: 'From', description: 'Events ending after this time. Default: now.' }).optional(),
                to: datetime({ title: 'To', description: 'Events starting before this time.' }).optional(),
                query: string({ title: 'Search', description: 'Free text matched against title, description, location and attendees.' }).optional(),
                includeCancelled: boolean({ title: 'Include cancelled events', default: false, advanced: true }).optional()
            },
            outputs: array(eventOutput),
            request: ({ inputs }) => ({
                url: eventsUrl(expr`default(${inputs.calendarId}, 'primary')`),
                query: {
                    timeMin: expr`default(${inputs.from}, now())`,
                    timeMax: inputs.to,
                    q: inputs.query,
                    showDeleted: inputs.includeCancelled,
                    singleEvents: true,
                    orderBy: 'startTime',
                    maxResults: 250
                }
            }),
            errors: ({ response }) => [notFound(response, 'calendarId', 'calendar')],
            paginate: ({ response }) => paging.cursor({ param: 'pageToken', items: response.body.items, next: response.body.nextPageToken, maxPages: 40 }),
            output: ({ items }) => expr`${items} | map(e => eventOf(e))`
        }),

        action('get-event', {
            label: 'Get event',
            group: 'Events',
            readOnly: true,
            inputs: { calendarId: calendarField.optional(), eventId: string({ title: 'Event' }) },
            outputs: eventOutput,
            request: ({ inputs }) => ({ url: eventsUrl(expr`default(${inputs.calendarId}, 'primary')`, inputs.eventId) }),
            errors: ({ response }) => [notFound(response, 'eventId')],
            output: ({ response }) => expr`eventOf(${response.body})`
        }),

        action('create-event', {
            label: 'Create event',
            description: 'Add an event, invite guests and optionally attach a Google Meet link.',
            group: 'Events',
            inputs: {
                calendarId: calendarField.optional(),
                summary: string({ title: 'Title', group: 'Event' }),
                start: moment({ title: 'Start', group: 'Event' }),
                end: moment({ title: 'End', description: 'Default: an hour after the start (the next day for all-day events).', group: 'Event' }).optional(),
                allDay: boolean({ title: 'All day', default: false, group: 'Event' }).optional(),
                timeZone: string({ title: 'Time zone', description: 'An IANA zone such as Europe/Stockholm. Default: the calendar’s.', placeholder: 'Europe/Stockholm', group: 'Event', advanced: true }).optional(),
                location: string({ title: 'Location', group: 'Details' }).optional(),
                description: text({ title: 'Description', group: 'Details' }).optional(),
                attendees: emails({ title: 'Guests', group: 'Guests' }).optional(),
                addMeet: boolean({ title: 'Add a Google Meet link', default: false, group: 'Guests' }).optional(),
                sendUpdates: sendUpdates.optional(),
                recurrence: array(string(), {
                    title: 'Repeats',
                    description: 'RFC 5545 lines, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO',
                    group: 'Details',
                    advanced: true
                }).optional()
            },
            outputs: eventOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: eventsUrl(expr`default(${inputs.calendarId}, 'primary')`),
                query: { sendUpdates: inputs.sendUpdates, conferenceDataVersion: expr`${inputs.addMeet} ? 1 : undefined` },
                body: {
                    summary: inputs.summary,
                    location: inputs.location,
                    description: inputs.description,
                    start: timeOf(inputs.start, inputs.allDay, inputs.timeZone),
                    // All-day (or a plain-date start): the day after the start's own date, not its UTC date.
                    end: timeOf(
                        expr`default(${inputs.end}, ${inputs.allDay} || length(${inputs.start}) == 10 ? addTime(substring(${inputs.start}, 0, 10), 1, 'd') : addTime(${inputs.start}, 1, 'h'))`,
                        expr`${inputs.allDay} || length(${inputs.start}) == 10`,
                        inputs.timeZone
                    ),
                    attendees: guests(inputs.attendees),
                    recurrence: inputs.recurrence,
                    conferenceData: expr`${inputs.addMeet} ? {createRequest: {requestId: uuid(), conferenceSolutionKey: {type: 'hangoutsMeet'}}} : undefined`
                }
            }),
            errors: ({ response }) => [
                notFound(response, 'calendarId', 'calendar'),
                badRange(response, 'end')
            ],
            output: ({ response }) => expr`eventOf(${response.body})`
        }),

        action('quick-add-event', {
            label: 'Quick add event',
            description: 'Create an event from a sentence, the way Google Calendar’s quick add does.',
            group: 'Events',
            inputs: {
                calendarId: calendarField.optional(),
                text: string({ title: 'What and when', placeholder: 'Lunch with Ada at Café Blå tomorrow 12:30' }),
                sendUpdates: sendUpdates.optional()
            },
            outputs: eventOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: $`${eventsUrl(expr`default(${inputs.calendarId}, 'primary')`)}/quickAdd`,
                query: { text: inputs.text, sendUpdates: inputs.sendUpdates }
            }),
            errors: ({ response }) => [notFound(response, 'calendarId', 'calendar')],
            output: ({ response }) => expr`eventOf(${response.body})`
        }),

        action('update-event', {
            label: 'Update event',
            description: 'Change only the fields given; everything else stays as it is.',
            group: 'Events',
            inputs: {
                calendarId: calendarField.optional(),
                eventId: string({ title: 'Event' }),
                summary: string({ title: 'Title' }).optional(),
                start: moment({ title: 'Start' }).optional(),
                end: moment({ title: 'End' }).optional(),
                allDay: boolean({ title: 'All day', description: 'How to read start and end.', default: false }).optional(),
                timeZone: string({ title: 'Time zone', placeholder: 'Europe/Stockholm', advanced: true }).optional(),
                location: string({ title: 'Location' }).optional(),
                description: text({ title: 'Description' }).optional(),
                attendees: emails({ title: 'Guests', description: 'Replaces the guest list.' }).optional(),
                sendUpdates: sendUpdates.optional()
            },
            outputs: eventOutput,
            request: ({ inputs }) => ({
                method: 'PATCH',
                url: eventsUrl(expr`default(${inputs.calendarId}, 'primary')`, inputs.eventId),
                query: { sendUpdates: inputs.sendUpdates },
                body: {
                    summary: inputs.summary,
                    location: inputs.location,
                    description: inputs.description,
                    start: timeOf(inputs.start, inputs.allDay, inputs.timeZone),
                    end: timeOf(inputs.end, inputs.allDay, inputs.timeZone),
                    attendees: guests(inputs.attendees)
                }
            }),
            errors: ({ response }) => [
                notFound(response, 'eventId'),
                badRange(response, 'end')
            ],
            output: ({ response }) => expr`eventOf(${response.body})`
        }),

        action('delete-event', {
            label: 'Delete event',
            description: 'Deletes the event (for recurring events, the whole series unless an occurrence id is given).',
            group: 'Events',
            destructive: true,
            inputs: { calendarId: calendarField.optional(), eventId: string({ title: 'Event' }), sendUpdates: sendUpdates.optional() },
            outputs: object({ deleted: boolean(), eventId: string() }),
            request: ({ inputs }) => ({
                method: 'DELETE',
                url: eventsUrl(expr`default(${inputs.calendarId}, 'primary')`, inputs.eventId),
                query: { sendUpdates: inputs.sendUpdates }
            }),
            errors: ({ response }) => [notFound(response, 'eventId')],
            output: ({ inputs }) => ({ deleted: true, eventId: inputs.eventId })
        }),

        action('find-free-busy', {
            label: 'Find busy times',
            description: 'When each calendar is busy between two times — for finding a slot that suits everyone.',
            group: 'Availability',
            readOnly: true,
            inputs: {
                calendars: array(string(), {
                    title: 'Calendars',
                    description: 'Calendar ids: a person’s email address, a shared calendar’s id, or primary. Default: your primary calendar.',
                    options: calendarOptions
                }).optional(),
                from: datetime({ title: 'From' }),
                to: datetime({ title: 'To' }),
                timeZone: string({ title: 'Time zone', placeholder: 'Europe/Stockholm', advanced: true }).optional()
            },
            outputs: array(object({ calendar: string(), busy: array(object({ start: string(), end: string() })), error: string().optional() })),
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/freeBusy',
                body: {
                    timeMin: inputs.from,
                    timeMax: inputs.to,
                    timeZone: inputs.timeZone,
                    items: expr`map(ifEmpty(${inputs.calendars}, ['primary']), id => {id})`
                }
            }),
            errors: ({ response }) => [
                {
                    when: expr`${response.status} == 400 && contains(lower(default(${response.body.error.message}, '')), 'time')`,
                    error: 'validation',
                    field: 'to',
                    message: 'The time range is not valid'
                }
            ],
            output: ({ response }) =>
                expr`entries(default(${response.body.calendars}, {}))
                    | map(c => compactObject({calendar: c.key, busy: default(c.value.busy, []), error: first(default(c.value.errors, []))?.reason}))`
        }),

        pollTrigger('event-changed', {
            label: 'Event created or changed',
            description: 'Fires when an event is created, updated or cancelled after the trigger is turned on.',
            group: 'Triggers',
            readOnly: true,
            intervalSec: 120,
            inputs: { calendarId: calendarField.optional() },
            outputs: eventOutput,
            request: ({ inputs, state }) => ({
                url: eventsUrl(expr`default(${inputs.calendarId}, 'primary')`),
                query: { updatedMin: expr`default(${state.cursor}, now())`, showDeleted: true, orderBy: 'updated', maxResults: 250 }
            }),
            items: ({ response }) => expr`default(${response.body.items}, [])`,
            // The newest change seen; `updatedMin` is inclusive, so the next
            // poll repeats it and `dedupeKey` drops the repeat.
            cursor: ({ response, state }) => expr`default(last(sortBy(default(${response.body.items}, []), 'updated'))?.updated, ${state.cursor})`,
            dedupeKey: ({ item }) => expr`${item.id} + '@' + ${item.updated}`,
            event: ({ item }) => expr`eventOf(${item})`
        })
    ]
});
