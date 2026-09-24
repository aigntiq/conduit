/**
 * Microsoft Calendar against a scripted stand-in for the Microsoft identity
 * platform and Microsoft Graph. Every request is recorded, so the tests
 * assert the Graph JSON and times that would go on the wire as well as the
 * mapping back.
 */
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '@aigntiq/conduit/schema';
import calendar from '@aigntiq/conduit-connectors/microsoft-calendar';
import { connect, json, last, scriptedHttp } from './support/stub';
import { renderWebhook } from './support/triggers';

const utc = (t: string) => ({ dateTime: `${t}.0000000`, timeZone: 'UTC' });

const planning = {
    id: 'AAMk-e1',
    subject: 'Planning',
    bodyPreview: 'Agenda inside',
    start: utc('2026-05-04T07:00:00'),
    end: utc('2026-05-04T08:00:00'),
    isAllDay: false,
    location: { displayName: 'Room 4' },
    organizer: { emailAddress: { name: 'Ada Lovelace', address: 'ada@contoso.example' } },
    attendees: [{ type: 'required', status: { response: 'accepted' }, emailAddress: { name: 'Grace', address: 'grace@contoso.example' } }],
    isOnlineMeeting: true,
    onlineMeeting: { joinUrl: 'https://teams.example/l/meetup-join/1' },
    showAs: 'busy',
    isCancelled: false,
    responseStatus: { response: 'organizer' },
    webLink: 'https://outlook.office365.com/owa/?itemid=AAMk-e1',
    type: 'singleInstance',
    categories: [],
    importance: 'normal',
    createdDateTime: '2026-04-01T08:00:00Z',
    lastModifiedDateTime: '2026-04-02T08:00:00Z'
};
const offsite = { ...planning, id: 'AAMk-e2', subject: 'Offsite', isAllDay: true, start: utc('2026-05-06T00:00:00'), end: utc('2026-05-07T00:00:00'), location: { displayName: '' }, attendees: [], isOnlineMeeting: false, onlineMeeting: null };

function graphStub() {
    return scriptedHttp({
        tokenEndpoint: 'login.microsoftonline.com/common/oauth2/v2.0/token',
        accessToken: 'eyJ0eXAi.cal',
        hosts: ['graph.microsoft.com'],
        prefix: '/v1.0',
        routes: ({ route, url, body, headers }) => {
            if (headers.get('prefer') !== 'outlook.timezone="UTC"') return json({ error: { code: 'NoUtc', message: 'the stub only answers in UTC' } }, 400);
            switch (route) {
                case 'GET /me':
                    return json({ id: 'user-object-id', displayName: 'Ada Lovelace', mail: 'ada@contoso.example' });
                case 'GET /me/calendars':
                    return json({
                        value: [
                            { id: 'cal-team', name: 'Team', isDefaultCalendar: false, canEdit: true },
                            { id: 'cal-main', name: 'Calendar', isDefaultCalendar: true, canEdit: true },
                            { id: 'cal-holidays', name: 'Holidays', isDefaultCalendar: false, canEdit: false }
                        ]
                    });
                case 'GET /me/calendar/calendarView':
                    if (!url.searchParams.get('$skip')) {
                        const next = new URL(url);
                        next.searchParams.set('$skip', '1');
                        return json({ value: [planning], '@odata.nextLink': next.toString() });
                    }
                    return json({ value: [offsite] });
                case 'GET /me/calendars/missing/calendarView':
                    return json({ error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, 404);
                case 'GET /me/events/AAMk-e1':
                    return json({ ...planning, body: { contentType: 'html', content: '<p>Agenda</p>' } });
                case 'POST /me/calendar/events':
                case 'POST /me/calendars/cal-team/events': {
                    const event = JSON.parse(body);
                    if (event.end.dateTime < event.start.dateTime) return json({ error: { code: 'ErrorInvalidRequest', message: 'The end time must be after the start time.' } }, 400);
                    return json(
                        {
                            ...planning,
                            ...event,
                            id: 'AAMk-new',
                            onlineMeeting: event.isOnlineMeeting ? { joinUrl: 'https://teams.example/l/meetup-join/new' } : null,
                            attendees: (event.attendees ?? []).map((a: object) => ({ ...a, status: { response: 'none' } }))
                        },
                        201
                    );
                }
                case 'PATCH /me/events/AAMk-e1':
                    return json({ ...planning, ...JSON.parse(body) });
                case 'DELETE /me/events/AAMk-e1':
                    return new Response(null, { status: 204 });
                case 'POST /me/events/AAMk-e1/accept':
                case 'POST /me/events/AAMk-e1/decline':
                    return new Response(null, { status: 202 });
                case 'POST /me/events/AAMk-own/tentativelyAccept':
                    return json({ error: { code: 'ErrorInvalidRequest', message: 'Your request cannot be completed. You are the organizer of this meeting.' } }, 400);
                case 'POST /me/findMeetingTimes':
                    return json({
                        emptySuggestionsReason: '',
                        meetingTimeSuggestions: [
                            {
                                confidence: 100,
                                meetingTimeSlot: { start: utc('2026-05-05T09:00:00'), end: utc('2026-05-05T09:30:00') },
                                attendeeAvailability: [{ attendee: { emailAddress: { address: 'grace@contoso.example' } }, availability: 'free' }]
                            }
                        ]
                    });
                case 'POST /me/calendar/getSchedule':
                    return json({
                        value: [
                            {
                                scheduleId: 'grace@contoso.example',
                                availabilityView: '0220',
                                scheduleItems: [
                                    { status: 'busy', start: utc('2026-05-04T08:00:00'), end: utc('2026-05-04T09:00:00') },
                                    { status: 'free', start: utc('2026-05-04T09:00:00'), end: utc('2026-05-04T09:30:00') }
                                ]
                            },
                            { scheduleId: 'room@contoso.example', error: { message: 'The mailbox was not found.', responseCode: 'ErrorMailRecipientNotFound' } }
                        ]
                    });
            }
            return undefined;
        }
    });
}

async function setup() {
    const stub = graphStub();
    return { ...(await connect('microsoft-calendar', stub.http)), seen: stub.seen };
}

describe('Microsoft Calendar: connecting', () => {
    it('asks for calendar access and identifies the account by object id', async () => {
        const { conduit, account, authorizeUrl } = await setup();
        expect(authorizeUrl.searchParams.get('scope')).toBe('offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite');
        expect(await conduit.accounts.get(account)).toMatchObject({ externalId: 'user-object-id', displayName: 'ada@contoso.example' });
    });
});

describe('Microsoft Calendar: reading', () => {
    it('lists editable calendars, the main one first', async () => {
        const { conduit, account } = await setup();
        expect(await conduit.options({ connector: 'microsoft-calendar', operation: 'list-calendars', account })).toEqual([
            { label: 'Calendar', value: 'cal-main' },
            { label: 'Team', value: 'cal-team' }
        ]);
        expect(await conduit.options({ connector: 'microsoft-calendar', operation: 'list-calendars', account, inputs: { writable: false } })).toHaveLength(3);
    });

    it('reads a calendar view across pages, in UTC, into one flat shape', async () => {
        const { conduit, account, seen } = await setup();
        const { output, pages } = await conduit.execute({
            connector: 'microsoft-calendar',
            operation: 'search-events',
            account,
            inputs: { from: '2026-05-01T00:00:00+02:00', query: "Q1 'plan'" }
        });
        expect(pages).toBe(2);
        const params = Object.fromEntries(seen.find((s) => s.url.pathname.endsWith('/calendarView'))!.url.searchParams);
        expect(params).toMatchObject({
            startDateTime: '2026-04-30T22:00:00.000Z',
            endDateTime: '2026-05-30T22:00:00.000Z',
            $filter: "contains(subject,'Q1 ''plan''')",
            $orderby: 'start/dateTime'
        });
        expect(output).toEqual([
            {
                id: 'AAMk-e1',
                subject: 'Planning',
                preview: 'Agenda inside',
                start: '2026-05-04T07:00:00Z',
                end: '2026-05-04T08:00:00Z',
                allDay: false,
                location: 'Room 4',
                organizer: { name: 'Ada Lovelace', address: 'ada@contoso.example' },
                attendees: [{ name: 'Grace', address: 'grace@contoso.example', type: 'required', response: 'accepted' }],
                onlineMeeting: true,
                joinUrl: 'https://teams.example/l/meetup-join/1',
                showAs: 'busy',
                cancelled: false,
                myResponse: 'organizer',
                webLink: 'https://outlook.office365.com/owa/?itemid=AAMk-e1',
                type: 'singleInstance',
                categories: [],
                importance: 'normal',
                created: '2026-04-01T08:00:00Z',
                updated: '2026-04-02T08:00:00Z'
            },
            expect.objectContaining({ id: 'AAMk-e2', start: '2026-05-06', end: '2026-05-07', allDay: true, onlineMeeting: false })
        ]);
        expect(output[1]).not.toHaveProperty('location');
    });

    it('gets an event with its description, and reports a missing calendar on the field', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-calendar', operation: 'get-event', account, inputs: { eventId: 'AAMk-e1' } });
        expect(output).toMatchObject({ id: 'AAMk-e1', body: '<p>Agenda</p>', bodyType: 'html' });
        const err = await conduit.execute({ connector: 'microsoft-calendar', operation: 'search-events', account, inputs: { calendarId: 'missing' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.calendarId', code: 'remote' }] });
    });
});

describe('Microsoft Calendar: writing', () => {
    it('creates a timed Teams meeting in UTC, an hour long by default, with required and optional attendees', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'microsoft-calendar',
            operation: 'create-event',
            account,
            inputs: {
                subject: 'Review',
                start: '2026-05-04T15:00:00+02:00',
                attendees: ['grace@contoso.example'],
                optionalAttendees: ['linus@contoso.example'],
                teamsMeeting: true,
                reminderMinutes: 10
            }
        });
        expect(JSON.parse(last(seen, 'POST', /\/me\/calendar\/events$/).body)).toEqual({
            subject: 'Review',
            isAllDay: false,
            start: { dateTime: '2026-05-04T13:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-05-04T14:00:00', timeZone: 'UTC' },
            attendees: [
                { type: 'required', emailAddress: { address: 'grace@contoso.example' } },
                { type: 'optional', emailAddress: { address: 'linus@contoso.example' } }
            ],
            isOnlineMeeting: true,
            onlineMeetingProvider: 'teamsForBusiness',
            isReminderOn: true,
            reminderMinutesBeforeStart: 10
        });
        expect(output).toMatchObject({ id: 'AAMk-new', subject: 'Review', start: '2026-05-04T13:00:00Z', joinUrl: 'https://teams.example/l/meetup-join/new' });
    });

    it('makes a plain date all-day, midnight to the next midnight, on another calendar', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-calendar', operation: 'create-event', account, inputs: { calendarId: 'cal-team', subject: 'Offsite', start: '2026-05-06', location: 'Lake house' } });
        const body = JSON.parse(last(seen, 'POST', /cal-team\/events$/).body);
        expect(body).toMatchObject({
            isAllDay: true,
            start: { dateTime: '2026-05-06T00:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-05-07T00:00:00', timeZone: 'UTC' },
            location: { displayName: 'Lake house' }
        });
        expect(output).toMatchObject({ allDay: true, start: '2026-05-06', end: '2026-05-07', location: 'Lake house' });
    });

    it('puts an end before the start on the end field', async () => {
        const { conduit, account } = await setup();
        const err = await conduit
            .execute({ connector: 'microsoft-calendar', operation: 'create-event', account, inputs: { subject: 'x', start: '2026-05-04T13:00:00Z', end: '2026-05-04T12:00:00Z' } })
            .catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.end', code: 'remote', message: 'The end must be after the start' }] });
    });

    it('patches only the fields given, and needs something', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-calendar', operation: 'update-event', account, inputs: { eventId: 'AAMk-e1', subject: 'Planning (moved)', start: '2026-05-04T08:00:00Z', end: '2026-05-04T09:00:00Z' } });
        expect(JSON.parse(last(seen, 'PATCH', /AAMk-e1$/).body)).toEqual({
            subject: 'Planning (moved)',
            start: { dateTime: '2026-05-04T08:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-05-04T09:00:00', timeZone: 'UTC' }
        });
        expect(output).toMatchObject({ subject: 'Planning (moved)', start: '2026-05-04T08:00:00Z', attendees: [{ address: 'grace@contoso.example' }] });
        await conduit.execute({ connector: 'microsoft-calendar', operation: 'update-event', account, inputs: { eventId: 'AAMk-e1', start: '2026-05-06', end: '2026-05-07' } });
        expect(JSON.parse(last(seen, 'PATCH', /AAMk-e1$/).body)).toEqual({
            isAllDay: true,
            start: { dateTime: '2026-05-06T00:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-05-07T00:00:00', timeZone: 'UTC' }
        });
        const err = await conduit.execute({ connector: 'microsoft-calendar', operation: 'update-event', account, inputs: { eventId: 'AAMk-e1' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'inputs_invalid' });
    });

    it('deletes, marked destructive', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-calendar', operation: 'delete-event', account, inputs: { eventId: 'AAMk-e1' } });
        expect(output).toEqual({ deleted: true, eventId: 'AAMk-e1' });
    });

    it('answers invitations, and explains that an organizer has none to answer', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-calendar', operation: 'respond-to-event', account, inputs: { eventId: 'AAMk-e1', response: 'decline', comment: 'Clash, sorry' } });
        expect(JSON.parse(last(seen, 'POST', /decline$/).body)).toEqual({ comment: 'Clash, sorry', sendResponse: true });
        expect(output).toEqual({ responded: 'decline', eventId: 'AAMk-e1' });
        const err = await conduit.execute({ connector: 'microsoft-calendar', operation: 'respond-to-event', account, inputs: { eventId: 'AAMk-own', response: 'tentativelyAccept' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.eventId' }] });
    });
});

describe('Microsoft Calendar: availability', () => {
    it('finds meeting times in working hours by default', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'microsoft-calendar',
            operation: 'find-meeting-times',
            account,
            inputs: { attendees: ['grace@contoso.example'], from: '2026-05-05T00:00:00Z', to: '2026-05-06T00:00:00Z', durationMinutes: 30 }
        });
        const body = JSON.parse(last(seen, 'POST', /findMeetingTimes$/).body);
        expect(body).toMatchObject({
            attendees: [{ type: 'required', emailAddress: { address: 'grace@contoso.example' } }],
            timeConstraint: { activityDomain: 'work', timeSlots: [{ start: { dateTime: '2026-05-05T00:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-05-06T00:00:00', timeZone: 'UTC' } }] },
            meetingDuration: 'PT30M',
            maxCandidates: 5
        });
        expect(output).toEqual({
            suggestions: [{ start: '2026-05-05T09:00:00Z', end: '2026-05-05T09:30:00Z', confidence: 100, attendees: [{ address: 'grace@contoso.example', availability: 'free' }] }]
        });
    });

    it('returns busy times per person or room, with errors per address', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({
            connector: 'microsoft-calendar',
            operation: 'get-schedule',
            account,
            inputs: { addresses: ['grace@contoso.example', 'room@contoso.example'], from: '2026-05-04T00:00:00Z', to: '2026-05-05T00:00:00Z' }
        });
        expect(output).toEqual([
            { address: 'grace@contoso.example', busy: [{ start: '2026-05-04T08:00:00Z', end: '2026-05-04T09:00:00Z', status: 'busy' }] },
            { address: 'room@contoso.example', busy: [], error: 'The mailbox was not found.' }
        ]);
    });
});

describe('Microsoft Calendar: event-changed trigger', () => {
    const subscription = { callbackUrl: 'https://app.example/conduit/hooks/cal', secret: 's3cret', data: { id: 'sub-9' } };
    const subscribe = async (inputs: Record<string, unknown> = {}) =>
        ((await (await renderWebhook(calendar, 'event-changed', { inputs, subscription })).subscribe()) as { body: Record<string, string> }).body;

    it('watches the main calendar, or a chosen one (encoded), for every kind of change', async () => {
        expect(await subscribe()).toMatchObject({ resource: 'me/events', changeType: 'created,updated,deleted', clientState: 's3cret' });
        expect((await subscribe({ calendarId: 'cal-team' })).resource).toBe('me/calendars/cal-team/events');
        expect((await subscribe({ calendarId: 'AAMk/x?y=1' })).resource).toBe('me/calendars/AAMk%2Fx%3Fy%3D1/events');
    });

    it('turns a notification into one event per changed event', async () => {
        const webhook = await renderWebhook(calendar, 'event-changed', { subscription });
        const note = (changeType: string, id: string) => ({ subscriptionId: 'sub-9', clientState: 's3cret', changeType, resourceData: { id } });
        expect(await webhook.deliver({ body: { value: [note('updated', 'AAMk-e1'), note('deleted', 'AAMk-e2')] } })).toMatchObject({
            valid: true,
            events: [
                { id: 'AAMk-e1', changeType: 'updated', subscriptionId: 'sub-9' },
                { id: 'AAMk-e2', changeType: 'deleted', subscriptionId: 'sub-9' }
            ],
            dedupeKey: 'updated:AAMk-e1,deleted:AAMk-e2'
        });
    });
});

describe('Microsoft Calendar: intent and typing', () => {
    it('marks the pure reads readOnly and only delete destructive', async () => {
        const { conduit } = await setup();
        const ops = (await conduit.connectors.describe('microsoft-calendar')).operations;
        expect(ops.filter((o) => o.readOnly).map((o) => o.id)).toEqual(['list-calendars', 'search-events', 'get-event', 'find-meeting-times', 'get-schedule', 'event-changed']);
        expect(ops.filter((o) => o.destructive).map((o) => o.id)).toEqual(['delete-event']);
        const tools = toolDefinitions(await conduit.connectors.describe('microsoft-calendar'));
        expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/"x-/);
    });

    it('types every operation through the catalog', async () => {
        const { conduit, account } = await setup();
        // @ts-expect-error — not a Microsoft Calendar operation
        void (() => conduit.execute({ connector: 'microsoft-calendar', operation: 'clear-calendar', account }));
        // @ts-expect-error — response is accept | tentativelyAccept | decline
        void (() => conduit.execute({ connector: 'microsoft-calendar', operation: 'respond-to-event', account, inputs: { eventId: 'e', response: 'maybe' } }));
    });
});
