/**
 * Google Contacts — search, read, create, update and delete contacts, and
 * manage contact groups, through the People API.
 *
 * People keeps every field as a list of typed values (`emailAddresses[]`,
 * `organizations[]`, …); the connector takes and returns one flat contact.
 * Updates carry the contact's current `etag`, fetched in a step, so Google
 * can refuse a write over someone else's change.
 */
import {
    $,
    action,
    array,
    boolean,
    connector,
    emails,
    expr,
    object,
    options,
    paging,
    pollTrigger,
    rules,
    search,
    string,
    text,
    type ErrorRuleDef,
    type Ref
} from '@aigntiq/conduit/builder';
import { googleOAuth, googleRetry, googleSetup } from '../_shared/google';

const SCOPES = ['https://www.googleapis.com/auth/contacts'];

/** Everything `contactOf` reads. */
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses,biographies,birthdays,memberships,photos,metadata';

// ── Shared pieces ───────────────────────────────────────────────────────

const groupOptions = { operation: 'list-contact-groups' };

/** `people/c123` or `c123` → the `/people/c123` path, encoded. */
function personUrl(id: Ref, suffix = '') {
    return $`/people/${expr`urlEncode(replace(${id}, 'people/', ''))`}${suffix}`;
}

/** The fields a contact is written with — shared by create and update. */
const contactFields = {
    givenName: string({ title: 'First name', group: 'Name' }).optional(),
    familyName: string({ title: 'Last name', group: 'Name' }).optional(),
    emails: emails({ title: 'Email addresses', group: 'Contact details' }).optional(),
    phones: array(string(), { title: 'Phone numbers', group: 'Contact details' }).optional(),
    organization: string({ title: 'Company', group: 'Work' }).optional(),
    jobTitle: string({ title: 'Job title', group: 'Work' }).optional(),
    address: text({ title: 'Address', group: 'More', advanced: true }).optional(),
    birthday: string({
        title: 'Birthday',
        description: '1990-05-04, or --05-04 without a year.',
        placeholder: '1990-05-04',
        pattern: String.raw`^(\d{4}|-)-\d{2}-\d{2}$`,
        messages: { pattern: 'Use 1990-05-04, or --05-04 without a year' },
        group: 'More',
        advanced: true
    }).optional(),
    notes: text({ title: 'Notes', group: 'More', advanced: true }).optional()
};

type ContactInputs = { [K in keyof typeof contactFields]?: unknown };

const UPDATABLE = Object.keys(contactFields) as (keyof typeof contactFields)[];

/**
 * The People API body for the given inputs. Each field is present only when
 * its input is, so an update never clears what it wasn't asked to change.
 * `names` merges with `current` (the stored name) when given.
 */
function personBody(inputs: Ref<ContactInputs>, current?: Ref) {
    const given = current ? expr`default(${inputs.givenName}, ${current.givenName})` : inputs.givenName;
    const family = current ? expr`default(${inputs.familyName}, ${current.familyName})` : inputs.familyName;
    return {
        names: expr`${inputs.givenName} == undefined && ${inputs.familyName} == undefined ? undefined : [compactObject({givenName: ${given}, familyName: ${family}})]`,
        emailAddresses: expr`${inputs.emails} == undefined ? undefined : map(${inputs.emails}, value => {value})`,
        phoneNumbers: expr`${inputs.phones} == undefined ? undefined : map(${inputs.phones}, value => {value})`,
        organizations: expr`${inputs.organization} == undefined && ${inputs.jobTitle} == undefined ? undefined : [compactObject({name: ${inputs.organization}, title: ${inputs.jobTitle}})]`,
        addresses: expr`${inputs.address} == undefined ? undefined : [{formattedValue: ${inputs.address}}]`,
        // The last five characters are always MM-DD; a year is there unless it starts with "--".
        birthdays: expr`${inputs.birthday} == undefined ? undefined : [{date: compactObject({
            year: startsWith(${inputs.birthday}, '--') ? undefined : number(substring(${inputs.birthday}, 0, 4)),
            month: number(substring(${inputs.birthday}, length(${inputs.birthday}) - 5, length(${inputs.birthday}) - 3)),
            day: number(substring(${inputs.birthday}, length(${inputs.birthday}) - 2))
        })}]`,
        biographies: expr`${inputs.notes} == undefined ? undefined : [{value: ${inputs.notes}, contentType: 'TEXT_PLAIN'}]`
    };
}

/** The `updatePersonFields` mask: the People fields the given inputs touch. */
function updateMask(inputs: Ref<ContactInputs>) {
    return expr`compact([
        ${inputs.givenName} != undefined || ${inputs.familyName} != undefined ? 'names' : undefined,
        ${inputs.emails} != undefined ? 'emailAddresses' : undefined,
        ${inputs.phones} != undefined ? 'phoneNumbers' : undefined,
        ${inputs.organization} != undefined || ${inputs.jobTitle} != undefined ? 'organizations' : undefined,
        ${inputs.address} != undefined ? 'addresses' : undefined,
        ${inputs.birthday} != undefined ? 'birthdays' : undefined,
        ${inputs.notes} != undefined ? 'biographies' : undefined
    ]) | join(',')`;
}

const contactOutput = object({
    id: string(),
    resourceName: string(),
    etag: string().optional(),
    name: string().optional(),
    givenName: string().optional(),
    familyName: string().optional(),
    emails: array(string()),
    phones: array(string()),
    organization: string().optional(),
    jobTitle: string().optional(),
    address: string().optional(),
    birthday: string().optional(),
    notes: string().optional(),
    groups: array(string()),
    photo: string().optional()
});

function notFound(response: Ref, field: string): ErrorRuleDef {
    return { when: expr`${response.status} == 404`, error: 'notFound', field, message: 'That contact does not exist' };
}

// ── Connector ───────────────────────────────────────────────────────────

export default connector({
    id: 'google-contacts',
    name: 'Google Contacts',
    version: '1.0.0',
    description: 'Search, create, update and delete contacts in Google Contacts, and organise them into groups.',
    categories: ['contacts', 'crm', 'productivity'],
    brandColor: '#1a73e8',
    homepage: 'https://contacts.google.com',
    helpUrl: 'https://developers.google.com/people',
    config: { baseUrl: 'https://people.googleapis.com/v1' },
    functions: {
        contactOf: {
            params: ['p'],
            description: 'A People API person, flattened into one contact.',
            body: `{
                id: replace(p.resourceName, 'people/', ''),
                resourceName: p.resourceName,
                etag: p.etag,
                name: first(default(p.names, []))?.displayName,
                givenName: first(default(p.names, []))?.givenName,
                familyName: first(default(p.names, []))?.familyName,
                emails: map(default(p.emailAddresses, []), e => e.value),
                phones: map(default(p.phoneNumbers, []), n => n.value),
                organization: first(default(p.organizations, []))?.name,
                jobTitle: first(default(p.organizations, []))?.title,
                address: first(default(p.addresses, []))?.formattedValue,
                birthday: birthdayOf(first(default(p.birthdays, []))?.date),
                notes: first(default(p.biographies, []))?.value,
                groups: default(p.memberships, []) | filter(m => m.contactGroupMembership) | map(m => m.contactGroupMembership.contactGroupResourceName),
                photo: first(filter(default(p.photos, []), ph => !ph.default))?.url
            } | compactObject`
        },
        birthdayOf: {
            params: ['d'],
            description: 'A People date as ISO text: 1990-05-04, or --05-04 without a year.',
            body: "d == undefined ? undefined : (d.year ? string(d.year) : '-') + '-' + padStart(string(d.month), 2, '0') + '-' + padStart(string(d.day), 2, '0')"
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
            identity: {
                request: { url: '/people/me', query: { personFields: 'emailAddresses,names' } },
                id: expr`first(default(${response.body.emailAddresses}, []))?.value ?? ${response.body.resourceName}`,
                name: expr`first(default(${response.body.names}, []))?.displayName ?? first(default(${response.body.emailAddresses}, []))?.value`
            },
            test: { url: '/people/me', query: { personFields: 'names' } },
            helpUrl: 'https://developers.google.com/people/v1/how-tos/authorizing',
            setup: googleSetup('People API', 'google-contacts', SCOPES)
        }))
    ],
    operations: [
        search('search-contacts', {
            label: 'Search contacts',
            description: 'Contacts whose name, email, phone or company starts with the search text — or every contact, when there is none.',
            group: 'Contacts',
            readOnly: true,
            inputs: {
                query: string({ title: 'Search', placeholder: 'ada' }).optional()
            },
            outputs: array(contactOutput),
            // With text: searchContacts (one page of up to 30). Without: the
            // whole address book, paged.
            request: ({ inputs }) => ({
                url: expr`isEmpty(${inputs.query}) ? '/people/me/connections' : '/people:searchContacts'`,
                query: {
                    query: expr`isEmpty(${inputs.query}) ? undefined : ${inputs.query}`,
                    readMask: expr`isEmpty(${inputs.query}) ? undefined : ${PERSON_FIELDS}`,
                    personFields: expr`isEmpty(${inputs.query}) ? ${PERSON_FIELDS} : undefined`,
                    sortOrder: expr`isEmpty(${inputs.query}) ? 'FIRST_NAME_ASCENDING' : undefined`,
                    pageSize: expr`isEmpty(${inputs.query}) ? 1000 : 30`
                }
            }),
            paginate: ({ response, inputs }) =>
                paging.cursor({
                    param: 'pageToken',
                    items: expr`${response.body.connections} ?? map(default(${response.body.results}, []), r => r.person)`,
                    // A text search is one page, whatever Google offers next.
                    next: expr`isEmpty(${inputs.query}) ? ${response.body.nextPageToken} : undefined`,
                    maxPages: 50
                }),
            output: ({ items }) => expr`${items} | map(p => contactOf(p))`
        }),

        action('get-contact', {
            label: 'Get contact',
            group: 'Contacts',
            readOnly: true,
            inputs: { id: string({ title: 'Contact', description: 'The contact id (c123…) or resource name (people/c123…).' }) },
            outputs: contactOutput,
            request: ({ inputs }) => ({ url: personUrl(inputs.id), query: { personFields: PERSON_FIELDS } }),
            errors: ({ response }) => [notFound(response, 'id')],
            output: ({ response }) => expr`contactOf(${response.body})`
        }),

        action('create-contact', {
            label: 'Create contact',
            group: 'Contacts',
            inputs: {
                ...contactFields,
                groups: array(string(), { title: 'Groups', options: groupOptions, group: 'More' }).optional()
            },
            rules: [rules.atLeastOne(['givenName', 'familyName', 'emails', 'phones', 'organization'], 'Give the contact a name, an email address, a phone number or a company')],
            outputs: contactOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/people:createContact',
                query: { personFields: PERSON_FIELDS },
                body: {
                    ...personBody(inputs),
                    memberships: expr`map(${inputs.groups}, g => {contactGroupMembership: {contactGroupResourceName: g}})`
                }
            }),
            output: ({ response }) => expr`contactOf(${response.body})`
        }),

        action('update-contact', {
            label: 'Update contact',
            description: 'Change only the fields given. Lists (emails, phones) replace the stored ones.',
            group: 'Contacts',
            inputs: { id: string({ title: 'Contact' }), ...contactFields },
            // "Given", not "non-empty": an empty list clears the stored one.
            rules: [rules.check(`{{ ${UPDATABLE.map((f) => `inputs.${f} != undefined`).join(' || ')} }}`, 'Choose something to change', [...UPDATABLE])],
            outputs: contactOutput,
            steps: ({ inputs, response }) => [
                {
                    name: 'current',
                    url: personUrl(inputs.id),
                    query: { personFields: 'names' },
                    output: { etag: response.body.etag, givenName: expr`first(default(${response.body.names}, []))?.givenName`, familyName: expr`first(default(${response.body.names}, []))?.familyName` }
                }
            ],
            request: ({ inputs, steps }) => ({
                method: 'PATCH',
                url: personUrl(inputs.id, ':updateContact'),
                query: { updatePersonFields: updateMask(inputs), personFields: PERSON_FIELDS },
                body: { etag: steps.current.etag, ...personBody(inputs, steps.current) }
            }),
            errors: ({ response }) => [
                notFound(response, 'id'),
                {
                    when: expr`${response.status} == 400 && ${response.body.error.status} == 'FAILED_PRECONDITION'`,
                    error: 'conflict',
                    message: 'The contact changed while it was being updated; try again'
                }
            ],
            output: ({ response }) => expr`contactOf(${response.body})`
        }),

        action('delete-contact', {
            label: 'Delete contact',
            group: 'Contacts',
            destructive: true,
            inputs: { id: string({ title: 'Contact' }) },
            outputs: object({ deleted: boolean(), id: string() }),
            request: ({ inputs }) => ({ method: 'DELETE', url: personUrl(inputs.id, ':deleteContact') }),
            errors: ({ response }) => [notFound(response, 'id')],
            output: ({ inputs }) => ({ deleted: true, id: expr`replace(${inputs.id}, 'people/', '')` })
        }),

        options('list-contact-groups', {
            label: 'Contact groups',
            readOnly: true,
            request: { url: '/contactGroups', query: { pageSize: 1000 } },
            paginate: ({ response }) => paging.cursor({ param: 'pageToken', items: response.body.contactGroups, next: response.body.nextPageToken }),
            // Your own groups, plus Starred; the other system groups can't be edited.
            output: ({ items }) =>
                expr`${items}
                    | filter(g => g.groupType == 'USER_CONTACT_GROUP' || g.resourceName == 'contactGroups/starred')
                    | sortBy(g => lower(default(g.formattedName, g.name)))
                    | map(g => {label: default(g.formattedName, g.name), value: g.resourceName})`
        }),

        action('modify-group-members', {
            label: 'Add or remove group members',
            group: 'Groups',
            inputs: {
                groupId: string({ title: 'Group', options: groupOptions }),
                add: array(string(), { title: 'Add contacts', description: 'Contact ids or resource names.' }).optional(),
                remove: array(string(), { title: 'Remove contacts' }).optional()
            },
            rules: [rules.atLeastOne(['add', 'remove'], 'Choose contacts to add or remove')],
            outputs: object({ notFound: array(string()) }),
            request: ({ inputs }) => ({
                method: 'POST',
                url: $`/contactGroups/${expr`urlEncode(replace(${inputs.groupId}, 'contactGroups/', ''))`}/members:modify`,
                body: {
                    resourceNamesToAdd: expr`map(${inputs.add}, id => 'people/' + replace(id, 'people/', ''))`,
                    resourceNamesToRemove: expr`map(${inputs.remove}, id => 'people/' + replace(id, 'people/', ''))`
                }
            }),
            errors: ({ response }) => [{ when: expr`${response.status} == 404`, error: 'notFound', field: 'groupId', message: 'That group does not exist' }],
            output: ({ response }) => ({ notFound: expr`map(default(${response.body.notFoundResourceNames}, []), r => replace(r, 'people/', ''))` })
        }),

        pollTrigger('new-contact', {
            label: 'New contact',
            description: 'Fires once for each contact added after the trigger is turned on.',
            group: 'Triggers',
            readOnly: true,
            intervalSec: 300,
            outputs: contactOutput,
            request: { url: '/people/me/connections', query: { personFields: PERSON_FIELDS, sortOrder: 'LAST_MODIFIED_DESCENDING', pageSize: 50 } },
            items: ({ response }) => expr`default(${response.body.connections}, [])`,
            dedupeKey: ({ item }) => item.resourceName,
            event: ({ item }) => expr`contactOf(${item})`
        })
    ]
});
