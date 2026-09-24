/**
 * Google Contacts against a scripted stand-in for Google's OAuth and People
 * API endpoints. Every request is recorded, so the tests assert what would go
 * on the wire as well as how the answers are mapped.
 */
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '@aigntiq/conduit/schema';
import { connect, json, last, scriptedHttp } from './support/stub';

const ada = {
    resourceName: 'people/c1',
    etag: '%EgUBAgMFBw==',
    names: [{ displayName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace' }],
    emailAddresses: [{ value: 'ada@example.com' }, { value: 'ada@work.example' }],
    phoneNumbers: [{ value: '+46 8 123 45' }],
    organizations: [{ name: 'Analytical Engines', title: 'Programmer' }],
    birthdays: [{ date: { month: 12, day: 10 } }],
    memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/friends' } }, { domainMembership: { inViewerDomain: true } }],
    photos: [{ url: 'https://lh3.example/default', default: true }]
};
const grace = { resourceName: 'people/c2', names: [{ displayName: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper' }], birthdays: [{ date: { year: 1906, month: 12, day: 9 } }] };

function peopleStub() {
    return scriptedHttp({
        tokenEndpoint: 'oauth2.googleapis.com/token',
        revokeEndpoint: 'oauth2.googleapis.com/revoke',
        accessToken: 'ya29.people',
        hosts: ['people.googleapis.com'],
        prefix: '/v1',
        routes: ({ route, url, body }) => {
            switch (route) {
                case 'GET /people/me':
                    return json({ resourceName: 'people/me1', names: [{ displayName: 'Ada Lovelace' }], emailAddresses: [{ value: 'ada@example.com' }] });
                case 'GET /people/me/connections':
                    if (url.searchParams.get('sortOrder') === 'LAST_MODIFIED_DESCENDING') return json({ connections: [grace] });
                    if (!url.searchParams.get('pageToken')) return json({ connections: [ada], nextPageToken: 'p2', totalPeople: 2 });
                    return json({ connections: [grace], totalPeople: 2 });
                case 'GET /people:searchContacts':
                    // Offers a next page, which a text search must not follow.
                    return json({ results: url.searchParams.get('query') === 'ada' ? [{ person: ada }] : [], nextPageToken: 'more' });
                case 'GET /people/c1':
                    return json(ada);
                case 'GET /people/c404':
                case 'PATCH /people/c404:updateContact':
                    return json({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404);
                case 'POST /people:createContact':
                    return json({ resourceName: 'people/c9', etag: 'e9', ...JSON.parse(body) });
                case 'PATCH /people/c1:updateContact': {
                    const sent = JSON.parse(body);
                    if (sent.etag !== ada.etag) return json({ error: { code: 400, message: 'etag mismatch', status: 'FAILED_PRECONDITION' } }, 400);
                    return json({ ...ada, ...sent, etag: 'e-new' });
                }
                case 'DELETE /people/c1:deleteContact':
                    return json({});
                case 'GET /contactGroups':
                    return json({
                        contactGroups: [
                            { resourceName: 'contactGroups/myContacts', groupType: 'SYSTEM_CONTACT_GROUP', name: 'myContacts', formattedName: 'My Contacts' },
                            { resourceName: 'contactGroups/starred', groupType: 'SYSTEM_CONTACT_GROUP', name: 'starred', formattedName: 'Starred' },
                            { resourceName: 'contactGroups/friends', groupType: 'USER_CONTACT_GROUP', name: 'Friends', formattedName: 'Friends' },
                            { resourceName: 'contactGroups/board', groupType: 'USER_CONTACT_GROUP', name: 'Board' }
                        ]
                    });
                case 'POST /contactGroups/friends/members:modify':
                    return json({ notFoundResourceNames: ['people/c404'] });
            }
            return undefined;
        }
    });
}

async function setup() {
    const stub = peopleStub();
    return { ...(await connect('google-contacts', stub.http)), seen: stub.seen };
}

describe('Google Contacts: connecting', () => {
    it('asks for the contacts scope and identifies the account by email', async () => {
        const { conduit, account, authorizeUrl } = await setup();
        expect(authorizeUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/contacts');
        expect(await conduit.accounts.get(account)).toMatchObject({ externalId: 'ada@example.com', displayName: 'Ada Lovelace' });
    });
});

describe('Google Contacts: reading', () => {
    it('lists every contact across pages when there is no search text', async () => {
        const { conduit, account, seen } = await setup();
        const { output, pages } = await conduit.execute({ connector: 'google-contacts', operation: 'search-contacts', account });
        expect(pages).toBe(2);
        const params = Object.fromEntries(seen.find((s) => s.url.pathname.endsWith('/connections'))!.url.searchParams);
        expect(params).toMatchObject({ sortOrder: 'FIRST_NAME_ASCENDING', pageSize: '1000' });
        expect(params.personFields).toContain('emailAddresses');
        expect(params).not.toHaveProperty('readMask');
        expect(output).toEqual([
            {
                id: 'c1',
                resourceName: 'people/c1',
                etag: '%EgUBAgMFBw==',
                name: 'Ada Lovelace',
                givenName: 'Ada',
                familyName: 'Lovelace',
                emails: ['ada@example.com', 'ada@work.example'],
                phones: ['+46 8 123 45'],
                organization: 'Analytical Engines',
                jobTitle: 'Programmer',
                birthday: '--12-10',
                groups: ['contactGroups/friends']
            },
            { id: 'c2', resourceName: 'people/c2', name: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper', emails: [], phones: [], birthday: '1906-12-09', groups: [] }
        ]);
    });

    it('reads as many pages as the caller allows', async () => {
        const { conduit, account } = await setup();
        const { output, pages } = await conduit.execute({ connector: 'google-contacts', operation: 'search-contacts', account, paging: { maxPages: 1 } });
        expect([pages, output.map((c) => c.id)]).toEqual([1, ['c1']]);
    });

    it('searches by text with searchContacts and a read mask', async () => {
        const { conduit, account, seen } = await setup();
        const { output, pages } = await conduit.execute({ connector: 'google-contacts', operation: 'search-contacts', account, inputs: { query: 'ada' } });
        expect(pages).toBe(1);
        const params = Object.fromEntries(last(seen, 'GET', /searchContacts$/).url.searchParams);
        expect(params).toMatchObject({ query: 'ada', pageSize: '30' });
        expect(params).not.toHaveProperty('personFields');
        expect(params.readMask).toContain('names');
        expect(output.map((c) => c.id)).toEqual(['c1']);
        expect(seen.filter((s) => s.url.pathname.endsWith(':searchContacts'))).toHaveLength(1);
    });

    it('gets one contact by id or resource name, and reports a missing one on the field', async () => {
        const { conduit, account } = await setup();
        const byId = await conduit.execute({ connector: 'google-contacts', operation: 'get-contact', account, inputs: { id: 'c1' } });
        const byName = await conduit.execute({ connector: 'google-contacts', operation: 'get-contact', account, inputs: { id: 'people/c1' } });
        expect(byName.output).toEqual(byId.output);
        const err = await conduit.execute({ connector: 'google-contacts', operation: 'get-contact', account, inputs: { id: 'c404' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.id', code: 'remote' }] });
    });
});

describe('Google Contacts: writing', () => {
    it('refuses an empty contact before calling Google', async () => {
        const { conduit, account, seen } = await setup();
        const before = seen.length;
        const err = await conduit.execute({ connector: 'google-contacts', operation: 'create-contact', account, inputs: { notes: 'just a note' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'inputs_invalid', issues: [{ path: 'inputs.givenName', code: 'rule' }] });
        expect(seen.length).toBe(before);
    });

    it('creates a contact from flat fields', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'google-contacts',
            operation: 'create-contact',
            account,
            inputs: { givenName: 'Linus', emails: ['linus@example.com'], organization: 'Kernel', birthday: '1969-12-28', groups: ['contactGroups/friends'] }
        });
        expect(JSON.parse(last(seen, 'POST', /createContact$/).body)).toEqual({
            names: [{ givenName: 'Linus' }],
            emailAddresses: [{ value: 'linus@example.com' }],
            organizations: [{ name: 'Kernel' }],
            birthdays: [{ date: { year: 1969, month: 12, day: 28 } }],
            memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/friends' } }]
        });
        expect(output).toMatchObject({ id: 'c9', givenName: 'Linus', emails: ['linus@example.com'], birthday: '1969-12-28', groups: ['contactGroups/friends'] });
    });

    it('updates only the fields given, with the current etag, keeping the other half of the name', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-contacts', operation: 'update-contact', account, inputs: { id: 'c1', familyName: 'King', phones: [] } });
        const patch = last(seen, 'PATCH', /updateContact$/);
        expect(patch.url.searchParams.get('updatePersonFields')).toBe('names,phoneNumbers');
        expect(JSON.parse(patch.body)).toEqual({ etag: '%EgUBAgMFBw==', names: [{ givenName: 'Ada', familyName: 'King' }], phoneNumbers: [] });
        expect(output).toMatchObject({ familyName: 'King', phones: [], emails: ['ada@example.com', 'ada@work.example'] });
    });

    it('reports a missing contact on the field', async () => {
        const { conduit, account } = await setup();
        const err = await conduit.execute({ connector: 'google-contacts', operation: 'update-contact', account, inputs: { id: 'c404', notes: 'x' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.id', code: 'remote' }] });
    });

    it('deletes, marked destructive', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({ connector: 'google-contacts', operation: 'delete-contact', account, inputs: { id: 'people/c1' } });
        expect(output).toEqual({ deleted: true, id: 'c1' });
        expect((await conduit.connectors.describe('google-contacts')).operations.find((o) => o.id === 'delete-contact')).toMatchObject({ destructive: true });
    });
});

describe('Google Contacts: groups', () => {
    it('offers your own groups plus Starred, sorted', async () => {
        const { conduit, account } = await setup();
        expect(await conduit.options({ connector: 'google-contacts', operation: 'list-contact-groups', account })).toEqual([
            { label: 'Board', value: 'contactGroups/board' },
            { label: 'Friends', value: 'contactGroups/friends' },
            { label: 'Starred', value: 'contactGroups/starred' }
        ]);
    });

    it('adds and removes members by id or resource name', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'google-contacts',
            operation: 'modify-group-members',
            account,
            inputs: { groupId: 'contactGroups/friends', add: ['c2', 'people/c404'], remove: ['c1'] }
        });
        expect(JSON.parse(last(seen, 'POST', /members:modify$/).body)).toEqual({ resourceNamesToAdd: ['people/c2', 'people/c404'], resourceNamesToRemove: ['people/c1'] });
        expect(output).toEqual({ notFound: ['c404'] });
    });
});

describe('Google Contacts: intent and typing', () => {
    it('marks the pure reads readOnly and only delete destructive', async () => {
        const { conduit } = await setup();
        const ops = (await conduit.connectors.describe('google-contacts')).operations;
        expect(ops.filter((o) => o.readOnly).map((o) => o.id)).toEqual(['search-contacts', 'get-contact', 'list-contact-groups', 'new-contact']);
        expect(ops.filter((o) => o.destructive).map((o) => o.id)).toEqual(['delete-contact']);
        const tools = toolDefinitions(await conduit.connectors.describe('google-contacts'));
        expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/"x-/);
    });

    it('types every operation through the catalog', async () => {
        const { conduit, account } = await setup();
        // @ts-expect-error — not a Google Contacts operation
        void (() => conduit.execute({ connector: 'google-contacts', operation: 'merge-contacts', account }));
        // @ts-expect-error — id is required
        void (() => conduit.execute({ connector: 'google-contacts', operation: 'get-contact', account, inputs: {} }));
    });
});
