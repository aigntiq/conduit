/**
 * Google Calendar against a scripted stand-in for Google's OAuth and Calendar
 * endpoints. Every request is recorded, so the tests assert what would go on
 * the wire as well as how the answers are mapped.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { toolDefinitions } from '@aigntiq/conduit/schema';
import { connect, json, last, scriptedHttp } from './support/stub';

const timed = {
    id: 'ev1',
    status: 'confirmed',
    summary: 'Planning',
    location: 'Room 4',
    start: { dateTime: '2026-05-04T09:00:00+02:00', timeZone: 'Europe/Stockholm' },
    end: { dateTime: '2026-05-04T10:00:00+02:00', timeZone: 'Europe/Stockholm' },
    organizer: { email: 'ada@example.com' },
    attendees: [
        { email: 'ada@example.com', organizer: true, responseStatus: 'accepted' },
        { email: 'grace@example.com', displayName: 'Grace', responseStatus: 'needsAction' }
    ],
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    htmlLink: 'https://calendar.google.com/event?eid=ev1',
    created: '2026-04-01T08:00:00.000Z',
    updated: '2026-04-02T08:00:00.000Z'
};
const allDay = { id: 'ev2', status: 'confirmed', summary: 'Offsite', start: { date: '2026-05-06' }, end: { date: '2026-05-07' }, updated: '2026-04-03T08:00:00.000Z' };

function calendarStub() {
    return scriptedHttp({
        tokenEndpoint: 'oauth2.googleapis.com/token',
        revokeEndpoint: 'oauth2.googleapis.com/revoke',
        accessToken: 'ya29.cal',
        hosts: ['www.googleapis.com'],
        prefix: '/calendar/v3',
        routes: ({ route, url, body }) => {
            switch (route) {
                case 'GET /calendars/primary':
                    return json({ id: 'ada@example.com', summary: 'ada@example.com', timeZone: 'Europe/Stockholm' });
                case 'GET /users/me/calendarList':
                    return json({
                        items: [
                            { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer' },
                            { id: 'ada@example.com', summary: 'ada@example.com', primary: true, accessRole: 'owner' },
                            { id: 'x@group.calendar.google.com', summary: 'Birthdays', summaryOverride: 'Anniversaries', accessRole: 'writer' }
                        ]
                    });
                case 'GET /calendars/primary/events':
                    if (url.searchParams.get('orderBy') === 'updated') return json({ items: [timed] });
                    if (!url.searchParams.get('pageToken')) return json({ items: [timed], nextPageToken: 'p2' });
                    return json({ items: [allDay] });
                case 'GET /calendars/missing%40example.com/events':
                    return json({ error: { code: 404, message: 'Not Found' } }, 404);
                case 'GET /calendars/primary/events/ev1':
                    return json(timed);
                case 'GET /calendars/primary/events/gone':
                    return json({ error: { code: 410, message: 'Resource has been deleted' } }, 410);
                case 'POST /calendars/primary/events':
                case 'POST /calendars/team%40group.calendar.google.com/events': {
                    const event = JSON.parse(body);
                    if ((event.end.dateTime ?? event.end.date) < (event.start.dateTime ?? event.start.date)) {
                        return json({ error: { code: 400, message: 'The specified time range is empty.' } }, 400);
                    }
                    const meet = url.searchParams.get('conferenceDataVersion') === '1' && event.conferenceData ? { hangoutLink: 'https://meet.google.com/new-meet' } : {};
                    // Echo the event back as Google would, with an id and status.
                    return json({ ...event, id: 'new-ev', status: 'confirmed', organizer: { email: 'ada@example.com' }, ...meet });
                }
                case 'POST /calendars/primary/events/quickAdd':
                    return json({ ...timed, id: 'quick', summary: url.searchParams.get('text') });
                case 'PATCH /calendars/primary/events/ev1':
                    return json({ ...timed, ...JSON.parse(body) });
                case 'DELETE /calendars/primary/events/ev1':
                    return new Response(null, { status: 204 });
                case 'POST /freeBusy':
                    return json({
                        calendars: {
                            'ada@example.com': { busy: [{ start: '2026-05-04T07:00:00Z', end: '2026-05-04T08:00:00Z' }] },
                            'nobody@example.com': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] }
                        }
                    });
            }
            return undefined;
        }
    });
}

async function setup() {
    const stub = calendarStub();
    return { ...(await connect('google-calendar', stub.http)), seen: stub.seen };
}

describe('Google Calendar: connecting', () => {
    it('asks for the calendar scopes offline and identifies the account by its primary calendar', async () => {
        const { conduit, account, authorizeUrl } = await setup();
        expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
            scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
            access_type: 'offline',
            prompt: 'consent'
        });
        expect(await conduit.accounts.get(account)).toMatchObject({ externalId: 'ada@example.com', displayName: 'ada@example.com' });
    });
});

describe('Google Calendar: calendars', () => {
    it('lists editable calendars, primary first, with overrides for names', async () => {
        const { conduit, account, seen } = await setup();
        expect(await conduit.options({ connector: 'google-calendar', operation: 'list-calendars', account })).toEqual([
            { label: 'ada@example.com', value: 'primary' },
            { label: 'Anniversaries', value: 'x@group.calendar.google.com' },
            { label: 'Team', value: 'team@group.calendar.google.com' }
        ]);
        expect(last(seen, 'GET', /calendarList$/).url.searchParams.get('minAccessRole')).toBe('writer');
        await conduit.options({ connector: 'google-calendar', operation: 'list-calendars', account, inputs: { writable: false } });
        expect(last(seen, 'GET', /calendarList$/).url.searchParams.get('minAccessRole')).toBe('reader');
    });
});

describe('Google Calendar: reading events', () => {
    it('searches from now, expanding recurring events, across pages, into one flat shape', async () => {
        const { conduit, account, seen } = await setup();
        const before = new Date().toISOString();
        const { output, pages } = await conduit.execute({ connector: 'google-calendar', operation: 'search-events', account, inputs: { query: 'plan' } });
        expect(pages).toBe(2);
        const params = seen.find((s) => s.url.pathname.endsWith('/events'))!.url.searchParams;
        expect(Object.fromEntries(params)).toMatchObject({ q: 'plan', singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
        expect(params.get('timeMin')! >= before.slice(0, 16)).toBe(true);
        expect(params.has('timeMax')).toBe(false);
        expect(output).toEqual([
            {
                id: 'ev1',
                status: 'confirmed',
                summary: 'Planning',
                location: 'Room 4',
                start: '2026-05-04T09:00:00+02:00',
                end: '2026-05-04T10:00:00+02:00',
                allDay: false,
                timeZone: 'Europe/Stockholm',
                organizer: 'ada@example.com',
                attendees: [
                    { email: 'ada@example.com', organizer: true, response: 'accepted' },
                    { email: 'grace@example.com', name: 'Grace', response: 'needsAction' }
                ],
                meetLink: 'https://meet.google.com/abc-defg-hij',
                htmlLink: 'https://calendar.google.com/event?eid=ev1',
                created: '2026-04-01T08:00:00.000Z',
                updated: '2026-04-02T08:00:00.000Z'
            },
            { id: 'ev2', status: 'confirmed', summary: 'Offsite', start: '2026-05-06', end: '2026-05-07', allDay: true, attendees: [], updated: '2026-04-03T08:00:00.000Z' }
        ]);
        expectTypeOf(output[0]!.allDay).toEqualTypeOf<boolean>();
    });

    it('reads as many pages as the caller allows', async () => {
        const { conduit, account } = await setup();
        const { output, pages } = await conduit.execute({ connector: 'google-calendar', operation: 'search-events', account, paging: { maxPages: 1 } });
        expect([pages, output.map((e) => e.id)]).toEqual([1, ['ev1']]);
    });

    it('reports a missing calendar or event on the field', async () => {
        const { conduit, account } = await setup();
        const search = await conduit.execute({ connector: 'google-calendar', operation: 'search-events', account, inputs: { calendarId: 'missing@example.com' } }).catch((e: unknown) => e);
        expect(search).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.calendarId', code: 'remote' }] });
        const get = await conduit.execute({ connector: 'google-calendar', operation: 'get-event', account, inputs: { eventId: 'gone' } }).catch((e: unknown) => e);
        expect(get).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.eventId', code: 'remote' }] });
        const { output } = await conduit.execute({ connector: 'google-calendar', operation: 'get-event', account, inputs: { eventId: 'ev1' } });
        expect(output).toMatchObject({ id: 'ev1', start: '2026-05-04T09:00:00+02:00' });
    });
});

describe('Google Calendar: writing events', () => {
    it('creates a timed event an hour long by default, inviting guests', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'google-calendar',
            operation: 'create-event',
            account,
            inputs: { summary: 'Review', start: '2026-05-04T13:00:00.000Z', timeZone: 'Europe/Stockholm', attendees: ['grace@example.com'] }
        });
        const sent = last(seen, 'POST', /\/events$/);
        expect(Object.fromEntries(sent.url.searchParams)).toEqual({ sendUpdates: 'all' });
        expect(JSON.parse(sent.body)).toEqual({
            summary: 'Review',
            start: { dateTime: '2026-05-04T13:00:00.000Z', timeZone: 'Europe/Stockholm' },
            end: { dateTime: '2026-05-04T14:00:00.000Z', timeZone: 'Europe/Stockholm' },
            attendees: [{ email: 'grace@example.com' }]
        });
        expect(output).toMatchObject({ id: 'new-ev', summary: 'Review', allDay: false, attendees: [{ email: 'grace@example.com' }] });
    });

    it('creates an all-day event on another calendar, ending the next day, with a Meet link', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'google-calendar',
            operation: 'create-event',
            account,
            inputs: { calendarId: 'team@group.calendar.google.com', summary: 'Offsite', start: '2026-05-06', allDay: true, addMeet: true, sendUpdates: 'none' }
        });
        const sent = last(seen, 'POST', /\/events$/);
        expect(sent.url.pathname).toBe('/calendar/v3/calendars/team%40group.calendar.google.com/events');
        expect(Object.fromEntries(sent.url.searchParams)).toEqual({ sendUpdates: 'none', conferenceDataVersion: '1' });
        const body = JSON.parse(sent.body);
        expect(body.start).toEqual({ date: '2026-05-06' });
        expect(body.end).toEqual({ date: '2026-05-07' });
        expect(body.conferenceData.createRequest).toMatchObject({ conferenceSolutionKey: { type: 'hangoutsMeet' } });
        expect(body.conferenceData.createRequest.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(output).toMatchObject({ start: '2026-05-06', end: '2026-05-07', allDay: true, meetLink: 'https://meet.google.com/new-meet' });
    });

    it('ends a zoned all-day start on the next local day, and refuses a start that is not a date', async () => {
        const { conduit, account, seen } = await setup();
        // 00:00 in Stockholm is still the 5th in UTC: the day must come from the text, not UTC.
        await conduit.execute({ connector: 'google-calendar', operation: 'create-event', account, inputs: { summary: 'x', start: '2026-05-06T00:00:00+02:00', allDay: true } });
        const body = JSON.parse(last(seen, 'POST', /\/events$/).body);
        expect([body.start, body.end]).toEqual([{ date: '2026-05-06' }, { date: '2026-05-07' }]);

        const before = seen.length;
        const err = await conduit.execute({ connector: 'google-calendar', operation: 'create-event', account, inputs: { summary: 'x', start: 'tomorrow' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ issues: [{ path: 'inputs.start', code: 'pattern' }] });
        expect(seen.length).toBe(before);
    });

    it('treats a plain date as all-day even without allDay, never sending it as a date-time', async () => {
        const { conduit, account, seen } = await setup();
        await conduit.execute({ connector: 'google-calendar', operation: 'create-event', account, inputs: { summary: 'x', start: '2026-05-06' } });
        const body = JSON.parse(last(seen, 'POST', /\/events$/).body);
        expect([body.start, body.end]).toEqual([{ date: '2026-05-06' }, { date: '2026-05-07' }]);
        await conduit.execute({ connector: 'google-calendar', operation: 'update-event', account, inputs: { eventId: 'ev1', end: '2026-05-08' } });
        expect(JSON.parse(last(seen, 'PATCH', /ev1$/).body)).toEqual({ end: { date: '2026-05-08' } });
    });

    it('puts an end before the start on the end field', async () => {
        const { conduit, account } = await setup();
        const err = await conduit
            .execute({ connector: 'google-calendar', operation: 'create-event', account, inputs: { summary: 'x', start: '2026-05-04T13:00:00Z', end: '2026-05-04T12:00:00Z' } })
            .catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.end', code: 'remote', message: 'The end must be after the start' }] });
    });

    it('quick-adds from a sentence', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-calendar', operation: 'quick-add-event', account, inputs: { text: 'Lunch with Ada tomorrow 12:30' } });
        expect(last(seen, 'POST', /quickAdd$/).url.searchParams.get('text')).toBe('Lunch with Ada tomorrow 12:30');
        expect(output).toMatchObject({ id: 'quick', summary: 'Lunch with Ada tomorrow 12:30' });
    });

    it('patches only the fields given', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-calendar', operation: 'update-event', account, inputs: { eventId: 'ev1', summary: 'Planning (moved)', location: 'Room 5' } });
        expect(JSON.parse(last(seen, 'PATCH', /ev1$/).body)).toEqual({ summary: 'Planning (moved)', location: 'Room 5' });
        expect(output).toMatchObject({ summary: 'Planning (moved)', location: 'Room 5', start: '2026-05-04T09:00:00+02:00' });
    });

    it('deletes, marked destructive', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-calendar', operation: 'delete-event', account, inputs: { eventId: 'ev1', sendUpdates: 'none' } });
        expect(output).toEqual({ deleted: true, eventId: 'ev1' });
        expect(last(seen, 'DELETE', /ev1$/).url.searchParams.get('sendUpdates')).toBe('none');
        expect((await conduit.connectors.describe('google-calendar')).operations.find((o) => o.id === 'delete-event')).toMatchObject({ destructive: true });
    });
});

describe('Google Calendar: availability', () => {
    it('asks for busy times, your own calendar by default, and flattens per calendar', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'google-calendar',
            operation: 'find-free-busy',
            account,
            inputs: { calendars: ['ada@example.com', 'nobody@example.com'], from: '2026-05-04T06:00:00Z', to: '2026-05-04T18:00:00Z' }
        });
        expect(JSON.parse(last(seen, 'POST', /freeBusy$/).body)).toEqual({
            timeMin: '2026-05-04T06:00:00Z',
            timeMax: '2026-05-04T18:00:00Z',
            items: [{ id: 'ada@example.com' }, { id: 'nobody@example.com' }]
        });
        expect(output).toEqual([
            { calendar: 'ada@example.com', busy: [{ start: '2026-05-04T07:00:00Z', end: '2026-05-04T08:00:00Z' }] },
            { calendar: 'nobody@example.com', busy: [], error: 'notFound' }
        ]);
        await conduit.execute({ connector: 'google-calendar', operation: 'find-free-busy', account, inputs: { from: '2026-05-04T06:00:00Z', to: '2026-05-04T18:00:00Z' } });
        expect(JSON.parse(last(seen, 'POST', /freeBusy$/).body).items).toEqual([{ id: 'primary' }]);
        await conduit.execute({ connector: 'google-calendar', operation: 'find-free-busy', account, inputs: { calendars: ['primary', 'team@group.calendar.google.com'], from: '2026-05-04T06:00:00Z', to: '2026-05-04T18:00:00Z' } });
        expect(JSON.parse(last(seen, 'POST', /freeBusy$/).body).items).toEqual([{ id: 'primary' }, { id: 'team@group.calendar.google.com' }]);
    });
});

describe('Google Calendar: intent, forms and typing', () => {
    it('marks the pure reads readOnly and only delete destructive', async () => {
        const { conduit } = await setup();
        const ops = (await conduit.connectors.describe('google-calendar')).operations;
        expect(ops.filter((o) => o.readOnly).map((o) => o.id)).toEqual(['list-calendars', 'search-events', 'get-event', 'find-free-busy', 'event-changed']);
        expect(ops.filter((o) => o.destructive).map((o) => o.id)).toEqual(['delete-event']);
        expect(ops.find((o) => o.id === 'event-changed')).toMatchObject({ kind: 'trigger' });
        const tools = toolDefinitions(await conduit.connectors.describe('google-calendar'));
        expect(tools.find((t) => t.name === 'delete-event')!.annotations).toEqual({ destructive: true });
        expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/"x-/);
    });

    it('offers calendar pickers and groups the create form', async () => {
        const { conduit } = await setup();
        const form = await conduit.connectors.form('google-calendar', { operation: 'create-event' });
        expect(form.groups.map((g) => [g.name ?? '(default)', g.advanced, g.fields.map((f) => `${f.name}:${f.widget}`)])).toEqual([
            ['(default)', false, ['calendarId:select']],
            ['(default)', true, ['sendUpdates:select']],
            ['Event', false, ['summary:text', 'start:datetime', 'end:datetime', 'allDay:toggle']],
            ['Event', true, ['timeZone:text']],
            ['Details', false, ['location:text', 'description:textarea']],
            ['Details', true, ['recurrence:list']],
            ['Guests', false, ['attendees:emails', 'addMeet:toggle']]
        ]);
        expect(form.groups[0]!.fields[0]).toMatchObject({ options: { operation: 'list-calendars' } });
    });

    it('types every operation through the catalog', async () => {
        const { conduit, account } = await setup();
        // @ts-expect-error — not a Google Calendar operation
        void (() => conduit.execute({ connector: 'google-calendar', operation: 'cancel-everything', account }));
        // @ts-expect-error — start is required
        void (() => conduit.execute({ connector: 'google-calendar', operation: 'create-event', account, inputs: { summary: 'x' } }));
        // @ts-expect-error — sendUpdates is all | externalOnly | none
        void (() => conduit.execute({ connector: 'google-calendar', operation: 'delete-event', account, inputs: { eventId: 'e', sendUpdates: 'some' } }));
    });
});
