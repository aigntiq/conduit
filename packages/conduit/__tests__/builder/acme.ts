/**
 * The Acme CRM fixture connector, authored with the builder. The test
 * asserts it compiles to exactly the JSON in test/fixtures/connectors.
 */
import { $, action, array, ref, auth, connector, email, expr, options, paging, pollTrigger, search, secret, select, string, integer, webhookTrigger } from '@aigntiq/conduit/builder';

export const acme = connector({
    id: 'acme-crm',
    name: 'Acme CRM',
    version: '1.0.0',
    description: 'Contacts and deals in the (fictional) Acme CRM.',
    categories: ['crm', 'sales'],
    config: { baseUrl: 'https://api.acme.example', authUrl: 'https://auth.acme.example' },
    http: ({ config, account, response }) => ({
        baseUrl: $`${config.baseUrl}/v2`,
        headers: { Accept: 'application/json', 'X-Acme-Region': account.data.region },
        errors: [{ when: expr`${response.status} == 200 && ${response.body.ok} == false`, error: 'validation', message: response.body.error }],
        retry: { attempts: 3, initialDelayMs: 10, maxDelayMs: 200 }
    }),
    functions: {
        fullName: { params: ['c'], body: "trim(default(c.first_name, '') + ' ' + default(c.last_name, ''))" },
        toContact: {
            params: ['c'],
            body: '{id: c.id, email: lower(c.email), name: fullName(c), ownerId: c.owner_id, createdAt: date(c.created_at)}'
        }
    },
    auth: [
        auth.oauth2('oauth', ({ config, response }) => ({
            label: 'Sign in with Acme',
            authorizeUrl: $`${config.authUrl}/oauth/authorize`,
            tokenUrl: $`${config.authUrl}/oauth/token`,
            revokeUrl: $`${config.authUrl}/oauth/revoke`,
            scopes: ['contacts:read', 'contacts:write', 'offline_access'],
            authorizeParams: { prompt: 'consent' },
            identity: { request: { url: '/me' }, id: response.body.id, name: response.body.email, data: { region: response.body.region } },
            test: { url: '/me' }
        })),
        auth.apiKey('key', ({ response, inputs }) => ({
            label: 'API key',
            name: 'Authorization',
            prefix: 'Token ',
            inputs: {
                apiKey: secret({ title: 'API key', minLength: 8 }),
                region: select(['eu', 'us'], { title: 'Region', default: 'eu' }).optional()
            },
            identity: { request: { url: '/me' }, id: response.body.id, name: response.body.email, data: { region: inputs.region } },
            test: { url: '/me' }
        }))
    ],
    operations: [
        webhookTrigger('contact-created', {
            label: 'Contact created',
            trigger: ({ subscription, response, request }) => ({
                subscribe: {
                    method: 'POST',
                    url: '/webhooks',
                    body: { url: subscription.callbackUrl, events: ['contact.created'], secret: subscription.secret },
                    output: { hookId: response.body.id }
                },
                unsubscribe: { method: 'DELETE', url: $`/webhooks/${subscription.data.hookId}` },
                verify: { type: 'hmac', header: 'X-Acme-Signature', prefix: 'sha256=' },
                filter: expr`${request.body.type} == 'contact.created'`,
                event: expr`toContact(${request.body.data})`,
                dedupeKey: request.body.id
            })
        }),
        action('create-contact', {
            label: 'Create contact',
            description: 'Create a contact, optionally assigned to an owner.',
            group: 'Contacts',
            inputs: {
                email: email({ title: 'Email', minLength: 3 }),
                firstName: string({ title: 'First name' }).optional(),
                lastName: string({ title: 'Last name' }).optional(),
                ownerId: string({ title: 'Owner', options: { operation: 'list-owners' } }).optional(),
                tags: array(string(), { title: 'Tags' }).optional()
            },
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/contacts',
                body: { email: inputs.email, first_name: inputs.firstName, last_name: inputs.lastName, owner_id: inputs.ownerId, tags: inputs.tags }
            }),
            errors: ({ response, inputs }) => [{ when: expr`${response.status} == 409`, error: 'conflict', message: $`A contact with ${inputs.email} already exists` }],
            output: ({ response }) => expr`toContact(${response.body})`
        }),
        action('get-contact', {
            label: 'Get contact',
            group: 'Contacts',
            readOnly: true,
            inputs: { id: string({ title: 'Contact id', minLength: 1 }) },
            steps: ({ response }) => [
                // ownerId is read without being declared — only possible through an explicit ref.
                { name: 'owner', url: $`/owners/${ref('inputs.ownerId')}`, when: ref('inputs.ownerId'), output: response.body.name }
            ],
            request: ({ inputs }) => ({ url: $`/contacts/${expr`urlEncode(${inputs.id})`}` }),
            errors: ({ response, inputs }) => [{ when: expr`${response.status} == 404`, error: 'notFound', message: $`No contact ${inputs.id}` }],
            output: ({ response, steps }) => expr`merge(toContact(${response.body}), {ownerName: ${steps.owner}})`
        }),
        search('list-contacts', {
            label: 'List contacts',
            inputs: {
                query: string({ title: 'Search' }).optional(),
                maxPages: integer({ default: 5, minimum: 1 }).optional()
            },
            request: ({ inputs }) => ({ url: '/contacts', query: { q: inputs.query } }),
            paginate: ({ response }) =>
                paging.cursor({ param: 'cursor', pageSize: 2, pageSizeParam: 'limit', items: response.body.data, next: response.body.meta.next_cursor, maxPages: 5 }),
            output: ({ items }) => expr`${items} | map(c => toContact(c))`
        }),
        options('list-owners', {
            label: 'Owners',
            request: { url: '/owners' },
            output: ({ response }) => expr`${response.body.owners} | map(o => {label: o.name, value: o.id})`
        })
    ]
});

// Used only by the type tests.
export const poller = pollTrigger('poll', {
    label: 'Poll',
    request: { url: '/x' },
    items: ({ response }) => response.body.items,
    dedupeKey: ({ item }) => item.id
});
