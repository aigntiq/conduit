/**
 * Microsoft Calendar — find, read, create, change, answer and delete events
 * in Outlook calendars, and find times that suit everyone, through Microsoft
 * Graph.
 *
 * Graph keeps times as `{ dateTime, timeZone }` pairs. Every request asks for
 * UTC (`Prefer: outlook.timezone="UTC"`), so the connector returns ISO times
 * ending in `Z` — or a plain date for all-day events — and writes the ISO
 * times it is given as UTC.
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
    integer,
    object,
    options,
    rules,
    search,
    select,
    string,
    richtext,
    text,
    webhookTrigger,
    type ErrorRuleDef,
    type Ref
} from '@aigntiq/conduit/builder';
import { GRAPH, graphPaging, graphRetry, graphSubscription, microsoftOAuth, microsoftSetup } from '../_shared/microsoft';
import { moment } from '../_shared/time';

const SCOPES = ['Calendars.ReadWrite'];

/** Everything `eventOf` reads. */
const EVENT_FIELDS =
    'id,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,isOnlineMeeting,onlineMeeting,showAs,isCancelled,responseStatus,webLink,seriesMasterId,type,categories,importance,createdDateTime,lastModifiedDateTime';

// ── Shared pieces ───────────────────────────────────────────────────────

const calendarOptions = { operation: 'list-calendars' };

const calendarField = () => string({ title: 'Calendar', description: 'Default: your main calendar.', options: calendarOptions });

/** `/me/calendar` (the default calendar) or `/me/calendars/<id>`. */
function calendarPath(calendarId: Ref) {
    return expr`isEmpty(${calendarId}) ? '/me/calendar' : '/me/calendars/' + urlEncode(${calendarId})`;
}

/** `/me/events/<id>[suffix]`, encoded. */
function eventUrl(id: Ref, suffix: unknown = '') {
    return $`/me/events/${expr`urlEncode(${id})`}${suffix}`;
}

const showAs = select({ free: 'Free', tentative: 'Tentative', busy: 'Busy', oof: 'Away', workingElsewhere: 'Working elsewhere' }, { title: 'Show as', advanced: true });

function notFound(response: Ref, field: string, what = 'event'): ErrorRuleDef {
    return { when: expr`${response.status} == 404`, error: 'notFound', field, message: `That ${what} does not exist` };
}

/** Graph rejects an end before the start as 400 ErrorInvalidRequest about the time. */
function badRange(response: Ref, field: string): ErrorRuleDef {
    return {
        when: expr`${response.status} == 400 && contains(lower(default(${response.body.error.message}, '')), 'end time')`,
        error: 'validation',
        field,
        message: 'The end must be after the start'
    };
}

const personOutput = object({ name: string().optional(), address: string() });

const eventFields = {
    id: string(),
    subject: string().optional(),
    preview: string().optional(),
    start: string(),
    end: string(),
    allDay: boolean(),
    location: string().optional(),
    organizer: personOutput.optional(),
    attendees: array(object({ name: string().optional(), address: string(), type: string().optional(), response: string().optional() })),
    onlineMeeting: boolean(),
    joinUrl: string().optional(),
    showAs: string().optional(),
    cancelled: boolean(),
    myResponse: string().optional(),
    webLink: string().optional(),
    seriesMasterId: string().optional(),
    type: string().optional(),
    categories: array(string()),
    importance: string().optional(),
    created: string().optional(),
    updated: string().optional()
};

const eventOutput = object(eventFields);

// ── Connector ───────────────────────────────────────────────────────────

export default connector({
    id: 'microsoft-calendar',
    name: 'Microsoft Calendar',
    version: '1.0.0',
    description: 'Find, create, update, answer and delete events in Outlook calendars, and find times that suit everyone.',
    categories: ['calendar', 'productivity'],
    brandColor: '#0f6cbd',
    homepage: 'https://outlook.office.com/calendar',
    helpUrl: 'https://learn.microsoft.com/graph/outlook-calendar-concept-overview',
    config: { baseUrl: GRAPH, tenant: 'common' },
    functions: {
        timeOf: {
            params: ['t', 'allDay'],
            description: 'A Graph time (UTC, as requested) as ISO text: a date for all-day events.',
            body: "t == undefined ? undefined : (allDay ? substring(t.dateTime, 0, 10) : substring(t.dateTime, 0, 19) + 'Z')"
        },
        graphTime: {
            params: ['value', 'allDay'],
            description: 'An ISO date or date-time as a Graph time in UTC; all-day events start and end at midnight.',
            body: "value == undefined ? undefined : {dateTime: allDay || length(value) == 10 ? substring(value, 0, 10) + 'T00:00:00' : substring(date(value), 0, 19), timeZone: 'UTC'}"
        },
        personOf: {
            params: ['e'],
            description: 'A Graph emailAddress as { name, address }.',
            body: 'e == undefined ? undefined : compactObject({name: e.name, address: e.address})'
        },
        attendeesOf: {
            params: ['required', 'optional'],
            description: 'Graph attendees from required and optional address lists.',
            body: `required == undefined && optional == undefined ? undefined : concat(
                map(default(required, []), a => {type: 'required', emailAddress: {address: a}}),
                map(default(optional, []), a => {type: 'optional', emailAddress: {address: a}})
            )`
        },
        eventOf: {
            params: ['e'],
            description: 'A Graph event, flattened.',
            body: `{
                id: e.id,
                subject: e.subject,
                preview: e.bodyPreview,
                start: timeOf(e.start, e.isAllDay),
                end: timeOf(e.end, e.isAllDay),
                allDay: default(e.isAllDay, false),
                location: ifEmpty(e.location.displayName, undefined),
                organizer: personOf(e.organizer.emailAddress),
                attendees: map(default(e.attendees, []), a => compactObject({name: a.emailAddress.name, address: a.emailAddress.address, type: a.type, response: a.status.response})),
                onlineMeeting: default(e.isOnlineMeeting, false),
                joinUrl: e.onlineMeeting.joinUrl,
                showAs: e.showAs,
                cancelled: default(e.isCancelled, false),
                myResponse: e.responseStatus.response,
                webLink: e.webLink,
                seriesMasterId: e.seriesMasterId,
                type: e.type,
                categories: default(e.categories, []),
                importance: e.importance,
                created: e.createdDateTime,
                updated: e.lastModifiedDateTime
            } | compactObject`
        }
    },
    http: ({ config }) => ({
        baseUrl: config.baseUrl,
        // Every time Graph returns is in UTC.
        headers: { Accept: 'application/json', Prefer: 'outlook.timezone="UTC"' },
        retry: graphRetry
    }),
    auth: [
        microsoftOAuth({
            scopes: SCOPES,
            helpUrl: 'https://learn.microsoft.com/graph/permissions-reference',
            setup: microsoftSetup('microsoft-calendar', SCOPES)
        })
    ],
    operations: [
        options('list-calendars', {
            label: 'Calendars',
            readOnly: true,
            inputs: { writable: boolean({ title: 'Only calendars I can edit', default: true }).optional() },
            request: { url: '/me/calendars', query: { $select: 'id,name,isDefaultCalendar,canEdit', $top: 100 } },
            paginate: ({ response }) => graphPaging(response, 5),
            output: ({ items, inputs }) =>
                expr`${items}
                    | filter(c => ${inputs.writable} == false || c.canEdit)
                    | sortBy(c => (c.isDefaultCalendar ? '0' : '1') + lower(c.name))
                    | map(c => {label: c.name, value: c.id})`
        }),

        search('search-events', {
            label: 'Search events',
            description: 'Events between two times, with recurring events expanded into their occurrences, earliest first.',
            group: 'Events',
            readOnly: true,
            inputs: {
                calendarId: calendarField().optional(),
                from: datetime({ title: 'From', description: 'Default: now.' }).optional(),
                to: datetime({ title: 'To', description: 'Default: 30 days after From.' }).optional(),
                query: string({ title: 'Subject contains' }).optional()
            },
            outputs: array(eventOutput),
            request: ({ inputs }) => ({
                url: $`${calendarPath(inputs.calendarId)}/calendarView`,
                query: {
                    startDateTime: expr`date(default(${inputs.from}, now()))`,
                    endDateTime: expr`date(default(${inputs.to}, addTime(default(${inputs.from}, now()), 30, 'd')))`,
                    $filter: expr`isEmpty(${inputs.query}) ? undefined : "contains(subject,'" + replace(${inputs.query}, "'", "''") + "')"`,
                    $orderby: 'start/dateTime',
                    $select: EVENT_FIELDS,
                    $top: 50
                }
            }),
            errors: ({ response }) => [notFound(response, 'calendarId', 'calendar')],
            paginate: ({ response }) => graphPaging(response, 20),
            output: ({ items }) => expr`${items} | map(e => eventOf(e))`
        }),

        action('get-event', {
            label: 'Get event',
            group: 'Events',
            readOnly: true,
            inputs: { eventId: string({ title: 'Event' }) },
            outputs: object({ ...eventFields, body: string().optional(), bodyType: string().optional() }),
            request: ({ inputs }) => ({ url: eventUrl(inputs.eventId), query: { $select: `${EVENT_FIELDS},body` } }),
            errors: ({ response }) => [notFound(response, 'eventId')],
            output: ({ response }) => expr`merge(eventOf(${response.body}), compactObject({body: ${response.body.body.content}, bodyType: lower(default(${response.body.body.contentType}, ''))}))`
        }),

        action('create-event', {
            label: 'Create event',
            description: 'Add an event and invite attendees, optionally as a Teams meeting.',
            group: 'Events',
            inputs: {
                calendarId: calendarField().optional(),
                subject: string({ title: 'Title', group: 'Event' }),
                start: moment({ title: 'Start', group: 'Event' }),
                end: moment({ title: 'End', description: 'Default: an hour after the start (the next day for all-day events).', group: 'Event' }).optional(),
                allDay: boolean({ title: 'All day', default: false, group: 'Event' }).optional(),
                location: string({ title: 'Location', group: 'Details' }).optional(),
                body: richtext({ title: 'Description', group: 'Details' }).optional(),
                attendees: emails({ title: 'Attendees', group: 'Attendees' }).optional(),
                optionalAttendees: emails({ title: 'Optional attendees', group: 'Attendees', advanced: true }).optional(),
                teamsMeeting: boolean({ title: 'Teams meeting', default: false, group: 'Attendees' }).optional(),
                reminderMinutes: integer({ title: 'Reminder (minutes before)', minimum: 0, group: 'Details', advanced: true }).optional(),
                showAs: showAs.optional(),
                categories: array(string(), { title: 'Categories', group: 'Details', advanced: true }).optional()
            },
            outputs: eventOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: $`${calendarPath(inputs.calendarId)}/events`,
                body: {
                    subject: inputs.subject,
                    body: expr`${inputs.body} == undefined ? undefined : {contentType: 'HTML', content: ${inputs.body}}`,
                    // All-day (or a plain-date start): midnight to midnight of the start's own date.
                    isAllDay: expr`${inputs.allDay} || length(${inputs.start}) == 10`,
                    start: expr`graphTime(${inputs.start}, ${inputs.allDay})`,
                    end: expr`graphTime(
                        default(${inputs.end}, ${inputs.allDay} || length(${inputs.start}) == 10 ? substring(addTime(substring(${inputs.start}, 0, 10), 1, 'd'), 0, 10) : addTime(${inputs.start}, 1, 'h')),
                        ${inputs.allDay} || length(${inputs.start}) == 10
                    )`,
                    location: expr`${inputs.location} == undefined ? undefined : {displayName: ${inputs.location}}`,
                    attendees: expr`attendeesOf(${inputs.attendees}, ${inputs.optionalAttendees})`,
                    isOnlineMeeting: expr`${inputs.teamsMeeting} ? true : undefined`,
                    onlineMeetingProvider: expr`${inputs.teamsMeeting} ? 'teamsForBusiness' : undefined`,
                    isReminderOn: expr`${inputs.reminderMinutes} == undefined ? undefined : true`,
                    reminderMinutesBeforeStart: inputs.reminderMinutes,
                    showAs: inputs.showAs,
                    categories: inputs.categories
                }
            }),
            errors: ({ response }) => [notFound(response, 'calendarId', 'calendar'), badRange(response, 'end')],
            output: ({ response }) => expr`eventOf(${response.body})`
        }),

        action('update-event', {
            label: 'Update event',
            description: 'Change only the fields given. Attendees, when given, replace the list (and are notified).',
            group: 'Events',
            inputs: {
                eventId: string({ title: 'Event' }),
                subject: string({ title: 'Title' }).optional(),
                start: moment({ title: 'Start' }).optional(),
                end: moment({ title: 'End' }).optional(),
                allDay: boolean({ title: 'All day', description: 'How to read start and end.' }).optional(),
                location: string({ title: 'Location' }).optional(),
                body: richtext({ title: 'Description' }).optional(),
                attendees: emails({ title: 'Attendees' }).optional(),
                optionalAttendees: emails({ title: 'Optional attendees', advanced: true }).optional(),
                showAs: showAs.optional(),
                categories: array(string(), { title: 'Categories', advanced: true }).optional()
            },
            rules: [
                rules.check(
                    '{{ inputs.subject != undefined || inputs.start != undefined || inputs.end != undefined || inputs.allDay != undefined || inputs.location != undefined || inputs.body != undefined || inputs.attendees != undefined || inputs.optionalAttendees != undefined || inputs.showAs != undefined || inputs.categories != undefined }}',
                    'Choose something to change',
                    ['subject', 'start', 'end', 'allDay', 'location', 'body', 'attendees', 'optionalAttendees', 'showAs', 'categories']
                )
            ],
            outputs: eventOutput,
            request: ({ inputs }) => ({
                method: 'PATCH',
                url: eventUrl(inputs.eventId),
                body: {
                    subject: inputs.subject,
                    body: expr`${inputs.body} == undefined ? undefined : {contentType: 'HTML', content: ${inputs.body}}`,
                    isAllDay: inputs.allDay,
                    start: expr`graphTime(${inputs.start}, ${inputs.allDay})`,
                    end: expr`graphTime(${inputs.end}, ${inputs.allDay})`,
                    location: expr`${inputs.location} == undefined ? undefined : {displayName: ${inputs.location}}`,
                    attendees: expr`attendeesOf(${inputs.attendees}, ${inputs.optionalAttendees})`,
                    showAs: inputs.showAs,
                    categories: inputs.categories
                }
            }),
            errors: ({ response }) => [notFound(response, 'eventId'), badRange(response, 'end')],
            output: ({ response }) => expr`eventOf(${response.body})`
        }),

        action('delete-event', {
            label: 'Delete event',
            description: 'Deletes the event. For a meeting you organize, attendees get a cancellation; for a series, the whole series goes.',
            group: 'Events',
            destructive: true,
            inputs: { eventId: string({ title: 'Event' }) },
            outputs: object({ deleted: boolean(), eventId: string() }),
            request: ({ inputs }) => ({ method: 'DELETE', url: eventUrl(inputs.eventId) }),
            errors: ({ response }) => [notFound(response, 'eventId')],
            output: ({ inputs }) => ({ deleted: true, eventId: inputs.eventId })
        }),

        action('respond-to-event', {
            label: 'Respond to invitation',
            description: 'Accept, tentatively accept or decline a meeting, optionally with a note to the organizer.',
            group: 'Events',
            inputs: {
                eventId: string({ title: 'Event' }),
                response: select({ accept: 'Accept', tentativelyAccept: 'Tentative', decline: 'Decline' }, { title: 'Response' }),
                comment: text({ title: 'Note to the organizer' }).optional(),
                notifyOrganizer: boolean({ title: 'Send the response', default: true, advanced: true }).optional()
            },
            outputs: object({ responded: string(), eventId: string() }),
            request: ({ inputs }) => ({
                method: 'POST',
                url: eventUrl(inputs.eventId, $`/${inputs.response}`),
                body: { comment: inputs.comment, sendResponse: expr`default(${inputs.notifyOrganizer}, true)` }
            }),
            errors: ({ response }) => [
                notFound(response, 'eventId'),
                {
                    when: expr`${response.status} == 400 && contains(lower(default(${response.body.error.message}, '')), 'organizer')`,
                    error: 'validation',
                    field: 'eventId',
                    message: 'You organize this meeting, so there is no invitation to answer'
                }
            ],
            output: ({ inputs }) => ({ responded: inputs.response, eventId: inputs.eventId })
        }),

        action('find-meeting-times', {
            label: 'Find meeting times',
            description: 'Times within a window when the attendees (and you) are free, best first.',
            group: 'Availability',
            readOnly: true,
            inputs: {
                attendees: emails({ title: 'Attendees', minItems: 1 }),
                from: datetime({ title: 'From' }),
                to: datetime({ title: 'To' }),
                durationMinutes: integer({ title: 'Length (minutes)', default: 30, minimum: 5, maximum: 1440 }).optional(),
                workingHoursOnly: boolean({ title: 'Working hours only', default: true, advanced: true }).optional(),
                maxResults: integer({ title: 'At most', default: 5, minimum: 1, maximum: 20, advanced: true }).optional()
            },
            outputs: object({
                suggestions: array(object({ start: string(), end: string(), confidence: integer().optional(), attendees: array(object({ address: string(), availability: string() })) })),
                emptyReason: string().optional()
            }),
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/me/findMeetingTimes',
                body: {
                    attendees: expr`map(${inputs.attendees}, a => {type: 'required', emailAddress: {address: a}})`,
                    timeConstraint: {
                        activityDomain: expr`${inputs.workingHoursOnly} == false ? 'unrestricted' : 'work'`,
                        timeSlots: [{ start: expr`graphTime(${inputs.from}, false)`, end: expr`graphTime(${inputs.to}, false)` }]
                    },
                    meetingDuration: expr`'PT' + string(default(${inputs.durationMinutes}, 30)) + 'M'`,
                    maxCandidates: expr`default(${inputs.maxResults}, 5)`,
                    returnSuggestionReasons: true
                }
            }),
            output: ({ response }) =>
                expr`compactObject({
                    suggestions: map(default(${response.body.meetingTimeSuggestions}, []), s => compactObject({
                        start: timeOf(s.meetingTimeSlot.start, false),
                        end: timeOf(s.meetingTimeSlot.end, false),
                        confidence: s.confidence,
                        attendees: map(default(s.attendeeAvailability, []), a => {address: a.attendee.emailAddress.address, availability: a.availability})
                    })),
                    emptyReason: ifEmpty(${response.body.emptySuggestionsReason}, undefined)
                })`
        }),

        action('get-schedule', {
            label: 'Get free/busy',
            description: 'When people or rooms are busy between two times.',
            group: 'Availability',
            readOnly: true,
            inputs: {
                addresses: emails({ title: 'People or rooms', minItems: 1 }),
                from: datetime({ title: 'From' }),
                to: datetime({ title: 'To' })
            },
            outputs: array(object({ address: string(), busy: array(object({ start: string(), end: string(), status: string() })), error: string().optional() })),
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/me/calendar/getSchedule',
                body: { schedules: inputs.addresses, startTime: expr`graphTime(${inputs.from}, false)`, endTime: expr`graphTime(${inputs.to}, false)`, availabilityViewInterval: 30 }
            }),
            output: ({ response }) =>
                expr`map(default(${response.body.value}, []), v => compactObject({
                    address: v.scheduleId,
                    busy: map(filter(default(v.scheduleItems, []), i => i.status != 'free'), i => {start: timeOf(i.start, false), end: timeOf(i.end, false), status: i.status}),
                    error: v.error.message
                }))`
        }),

        webhookTrigger('event-changed', {
            label: 'Event created, changed or deleted',
            description: 'Fires when an event in a calendar (your main one by default) is created, changed or deleted, with its id — get the event for the rest.',
            group: 'Triggers',
            readOnly: true,
            inputs: { calendarId: calendarField().optional() },
            outputs: object({ id: string(), changeType: string(), subscriptionId: string() }),
            trigger: graphSubscription({
                resource: ({ inputs }) => expr`isEmpty(${inputs.calendarId}) ? 'me/events' : 'me/calendars/' + ${inputs.calendarId} + '/events'`,
                changeType: 'created,updated,deleted',
                // Event subscriptions live at most 10 080 minutes (7 days).
                lifetimeMinutes: 4320,
                renewEveryMinutes: 2880
            })
        })
    ]
});
