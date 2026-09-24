/**
 * Gmail — send, draft, reply, search, read, label and trash messages.
 *
 * Gmail's send and draft endpoints take a whole RFC 5322 message, base64url
 * encoded, in `raw`; `mime()` builds it from the form's fields.
 */
import {
    $,
    action,
    array,
    boolean,
    connector,
    email,
    emails,
    expr,
    files,
    integer,
    object,
    options,
    paging,
    pollTrigger,
    richtext,
    rules,
    search,
    select,
    string,
    type ErrorRuleDef,
    type Ref
} from '@aigntiq/conduit/builder';
import { googleOAuth, googleRetry, googleSetup } from '../_shared/google';

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

// ── Shared pieces ───────────────────────────────────────────────────────

/** The fields every composed message shares. */
const composeFields = {
    to: emails({ title: 'To', group: 'Recipients' }).optional(),
    cc: emails({ title: 'Cc', group: 'Recipients', advanced: true }).optional(),
    bcc: emails({ title: 'Bcc', group: 'Recipients', advanced: true }).optional(),
    subject: string({ title: 'Subject', group: 'Message' }),
    body: richtext({ title: 'Message', group: 'Message' }),
    format: select({ html: 'Formatted (HTML)', text: 'Plain text' }, { title: 'Format', default: 'html', group: 'Message', advanced: true }).optional(),
    attachments: files({ title: 'Attachments', group: 'Attachments', maxBytes: 25_000_000 }).optional(),
    from: email({ title: 'Send as', description: 'A send-as alias configured on the account.', group: 'Message', advanced: true }).optional(),
    replyTo: emails({ title: 'Reply to', group: 'Recipients', advanced: true }).optional()
};

type Compose = {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    format?: 'html' | 'text';
    attachments?: unknown[];
    from?: string;
    replyTo?: string[];
};

const recipientsRule = rules.atLeastOne(['to', 'cc', 'bcc'], 'Add at least one recipient');

/** The raw, base64url-encoded message for a composed form. */
function raw(inputs: Ref<Compose>) {
    return expr`mime({
        from: ${inputs.from}, to: ${inputs.to}, cc: ${inputs.cc}, bcc: ${inputs.bcc}, replyTo: ${inputs.replyTo},
        subject: ${inputs.subject},
        html: ${inputs.format} == 'text' ? undefined : ${inputs.body},
        text: ${inputs.format} == 'text' ? ${inputs.body} : undefined,
        attachments: ${inputs.attachments}
    }) | base64url`;
}

/** Gmail reports bad addresses as a 400 naming the header; point the form at the field. */
function recipientErrors(response: Ref): ErrorRuleDef[] {
    return (['To', 'Cc', 'Bcc'] as const).map((header) => ({
        when: expr`${response.status} == 400 && contains(default(${response.body.error.message}, ''), ${`Invalid ${header} header`})`,
        error: 'validation' as const,
        field: header.toLowerCase(),
        message: `One of the ${header} addresses is not valid`
    }));
}

const messageOutput = object({ id: string(), threadId: string(), labelIds: array(string()).optional() });

const labelOptions = { operation: 'list-labels', search: 'query' };

// ── Connector ───────────────────────────────────────────────────────────

export default connector({
    id: 'gmail',
    name: 'Gmail',
    version: '1.0.0',
    description: 'Send, draft, search, read, label and trash email in a Gmail account.',
    categories: ['email', 'productivity'],
    brandColor: '#d93025',
    homepage: 'https://mail.google.com',
    helpUrl: 'https://developers.google.com/gmail/api',
    config: { baseUrl: 'https://gmail.googleapis.com/gmail/v1' },
    functions: {
        headersOf: {
            params: ['payload'],
            description: 'The headers of a message payload, as an object with lower-case names.',
            body: 'fromEntries(map(default(payload.headers, []), h => [lower(h.name), h.value]))'
        },
        partText: {
            params: ['payload', 'type'],
            description: 'The decoded body of the first non-attachment part of a MIME type.',
            body: "flattenTree(payload) | find(p => p.mimeType == type && !p.filename) | get('body.data') | fromBase64"
        },
        attachmentsOf: {
            params: ['payload'],
            body: 'flattenTree(payload) | filter(p => p.filename && p.body.attachmentId) | map(p => {attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size})'
        }
    },
    http: ({ config }) => ({
        baseUrl: config.baseUrl,
        headers: { Accept: 'application/json' },
        retry: googleRetry
    }),
    auth: [
        googleOAuth(({ response }) => ({
            scopes: [SCOPE],
            identity: {
                request: { url: '/users/me/profile' },
                id: response.body.emailAddress,
                name: response.body.emailAddress
            },
            test: { url: '/users/me/profile' },
            helpUrl: 'https://developers.google.com/gmail/api/auth/scopes',
            setup: googleSetup('Gmail API', 'gmail', [SCOPE], [
                '`gmail.modify` is a *restricted* scope: apps used beyond your own test users need Google verification (and a security assessment).'
            ])
        }))
    ],
    operations: [
        action('send-email', {
            label: 'Send email',
            description: 'Send a message, with optional attachments.',
            group: 'Messages',
            inputs: {
                ...composeFields,
                threadId: string({ title: 'Thread', description: 'Send inside an existing conversation.', advanced: true }).optional()
            },
            rules: [recipientsRule],
            outputs: messageOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/users/me/messages/send',
                body: { raw: raw(inputs), threadId: inputs.threadId }
            }),
            errors: ({ response }) => recipientErrors(response),
            output: ({ response }) => ({ id: response.body.id, threadId: response.body.threadId, labelIds: response.body.labelIds })
        }),

        action('create-draft', {
            label: 'Create draft',
            group: 'Messages',
            inputs: composeFields,
            outputs: object({ draftId: string(), messageId: string(), threadId: string() }),
            request: ({ inputs }) => ({ method: 'POST', url: '/users/me/drafts', body: { message: { raw: raw(inputs) } } }),
            errors: ({ response }) => recipientErrors(response),
            output: ({ response }) => ({ draftId: response.body.id, messageId: response.body.message.id, threadId: response.body.message.threadId })
        }),

        action('reply-to-message', {
            label: 'Reply to message',
            description: 'Reply in the same conversation, quoting the right headers so every client threads it.',
            group: 'Messages',
            inputs: {
                messageId: string({ title: 'Message', description: 'The message being replied to.' }),
                body: richtext({ title: 'Message' }),
                format: select({ html: 'Formatted (HTML)', text: 'Plain text' }, { title: 'Format', default: 'html', advanced: true }).optional(),
                replyAll: boolean({ title: 'Reply to all', default: false }).optional(),
                attachments: files({ title: 'Attachments', maxBytes: 25_000_000 }).optional()
            },
            outputs: messageOutput,
            steps: ({ inputs, response }) => [
                {
                    name: 'original',
                    url: $`/users/me/messages/${expr`urlEncode(${inputs.messageId})`}`,
                    query: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'Reply-To', 'To', 'Cc', 'Message-ID', 'References'] },
                    output: {
                        threadId: response.body.threadId,
                        headers: expr`headersOf(${response.body.payload})`
                    }
                }
            ],
            request: ({ inputs, steps }) => ({
                method: 'POST',
                url: '/users/me/messages/send',
                body: {
                    threadId: steps.original.threadId,
                    raw: expr`mime({
                        to: default(${steps.original.headers['reply-to']}, ${steps.original.headers.from}),
                        cc: ${inputs.replyAll} ? (compact([${steps.original.headers.to}, ${steps.original.headers.cc}]) | join(', ')) : undefined,
                        subject: startsWith(lower(default(${steps.original.headers.subject}, '')), 're:')
                            ? ${steps.original.headers.subject}
                            : 'Re: ' + default(${steps.original.headers.subject}, ''),
                        inReplyTo: ${steps.original.headers['message-id']},
                        references: trim(default(${steps.original.headers.references}, '') + ' ' + default(${steps.original.headers['message-id']}, '')),
                        html: ${inputs.format} == 'text' ? undefined : ${inputs.body},
                        text: ${inputs.format} == 'text' ? ${inputs.body} : undefined,
                        attachments: ${inputs.attachments}
                    }) | base64url`
                }
            }),
            errors: ({ response }) => [{ when: expr`${response.status} == 404`, error: 'notFound', field: 'messageId', message: 'That message does not exist' }],
            output: ({ response }) => ({ id: response.body.id, threadId: response.body.threadId, labelIds: response.body.labelIds })
        }),

        search('search-messages', {
            label: 'Search messages',
            description: 'Find messages with Gmail search syntax — the same as the search box.',
            group: 'Messages',
            readOnly: true,
            inputs: {
                query: string({ title: 'Search', placeholder: 'from:ada@example.com is:unread newer_than:7d' }).optional(),
                labelIds: array(string(), { title: 'Labels', options: labelOptions }).optional(),
                includeSpamTrash: boolean({ title: 'Include spam and trash', default: false, advanced: true }).optional(),
                maxPages: integer({ title: 'Pages to read', description: 'Up to 100 messages per page.', default: 5, minimum: 1, maximum: 50, advanced: true }).optional()
            },
            outputs: array(object({ id: string(), threadId: string() })),
            request: ({ inputs }) => ({
                url: '/users/me/messages',
                query: { q: inputs.query, labelIds: inputs.labelIds, includeSpamTrash: inputs.includeSpamTrash, maxResults: 100 }
            }),
            paginate: ({ response }) => paging.cursor({ param: 'pageToken', items: response.body.messages, next: response.body.nextPageToken, maxPages: 50 }),
            output: ({ items }) => expr`${items} | map(m => {id: m.id, threadId: m.threadId})`
        }),

        action('get-message', {
            label: 'Get message',
            group: 'Messages',
            readOnly: true,
            inputs: { id: string({ title: 'Message' }) },
            outputs: object({
                id: string(),
                threadId: string(),
                labelIds: array(string()),
                snippet: string(),
                receivedAt: string(),
                from: string().optional(),
                to: string().optional(),
                cc: string().optional(),
                subject: string().optional(),
                messageId: string().optional(),
                text: string().optional(),
                html: string().optional(),
                attachments: array(object({ attachmentId: string(), filename: string(), mimeType: string(), size: integer() }))
            }),
            request: ({ inputs }) => ({ url: $`/users/me/messages/${expr`urlEncode(${inputs.id})`}`, query: { format: 'full' } }),
            errors: ({ response }) => [{ when: expr`${response.status} == 404`, error: 'notFound', field: 'id', message: 'That message does not exist' }],
            output: ({ response }) =>
                expr`{
                    id: ${response.body.id},
                    threadId: ${response.body.threadId},
                    labelIds: default(${response.body.labelIds}, []),
                    snippet: ${response.body.snippet},
                    receivedAt: date(number(${response.body.internalDate})),
                    from: headersOf(${response.body.payload}).from,
                    to: headersOf(${response.body.payload}).to,
                    cc: headersOf(${response.body.payload}).cc,
                    subject: headersOf(${response.body.payload}).subject,
                    messageId: headersOf(${response.body.payload})['message-id'],
                    text: partText(${response.body.payload}, 'text/plain'),
                    html: partText(${response.body.payload}, 'text/html'),
                    attachments: attachmentsOf(${response.body.payload})
                }`
        }),

        action('get-thread', {
            label: 'Get conversation',
            group: 'Messages',
            readOnly: true,
            inputs: { id: string({ title: 'Thread' }) },
            request: ({ inputs }) => ({
                url: $`/users/me/threads/${expr`urlEncode(${inputs.id})`}`,
                query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] }
            }),
            errors: ({ response }) => [{ when: expr`${response.status} == 404`, error: 'notFound', field: 'id', message: 'That conversation does not exist' }],
            output: ({ response }) =>
                expr`{
                    id: ${response.body.id},
                    messages: map(default(${response.body.messages}, []), m => merge(
                        {id: m.id, snippet: m.snippet, labelIds: m.labelIds, receivedAt: date(number(m.internalDate))},
                        headersOf(m.payload) | pick('from', 'to', 'subject')
                    ))
                }`
        }),

        action('get-attachment', {
            label: 'Download attachment',
            group: 'Messages',
            readOnly: true,
            inputs: {
                messageId: string({ title: 'Message' }),
                attachmentId: string({ title: 'Attachment' }),
                filename: string({ title: 'File name', description: 'Carried through to the file value.' }).optional(),
                contentType: string({ title: 'Content type', advanced: true }).optional()
            },
            request: ({ inputs }) => ({ url: $`/users/me/messages/${expr`urlEncode(${inputs.messageId})`}/attachments/${expr`urlEncode(${inputs.attachmentId})`}` }),
            // A file value, ready to attach elsewhere. Gmail returns base64url, which file consumers accept.
            output: ({ response, inputs }) => ({
                filename: expr`default(${inputs.filename}, 'attachment')`,
                contentType: expr`default(${inputs.contentType}, 'application/octet-stream')`,
                base64: response.body.data,
                size: response.body.size
            })
        }),

        options('list-labels', {
            label: 'Labels',
            readOnly: true,
            inputs: { query: string({ title: 'Search' }).optional() },
            request: { url: '/users/me/labels' },
            output: ({ response, inputs }) =>
                expr`default(${response.body.labels}, [])
                    | filter(l => isEmpty(${inputs.query}) || contains(lower(l.name), lower(${inputs.query})))
                    | sortBy(l => (l.type == 'system' ? '0' : '1') + lower(l.name))
                    | map(l => {label: l.name, value: l.id, system: l.type == 'system'})`
        }),

        action('modify-labels', {
            label: 'Add or remove labels',
            group: 'Labels',
            inputs: {
                messageId: string({ title: 'Message' }),
                add: array(string(), { title: 'Add labels', options: labelOptions }).optional(),
                remove: array(string(), { title: 'Remove labels', options: labelOptions }).optional()
            },
            rules: [rules.atLeastOne(['add', 'remove'], 'Choose labels to add or remove')],
            outputs: messageOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: $`/users/me/messages/${expr`urlEncode(${inputs.messageId})`}/modify`,
                body: { addLabelIds: inputs.add, removeLabelIds: inputs.remove }
            }),
            errors: ({ response }) => [
                { when: expr`${response.status} == 404`, error: 'notFound', field: 'messageId', message: 'That message does not exist' },
                { when: expr`${response.status} == 400 && contains(default(${response.body.error.message}, ''), 'label')`, error: 'validation', field: 'add', message: 'One of the labels does not exist' }
            ],
            output: ({ response }) => ({ id: response.body.id, threadId: response.body.threadId, labelIds: response.body.labelIds })
        }),

        action('trash-message', {
            label: 'Move to trash',
            description: 'Moves the message to Trash. Gmail deletes trashed messages after 30 days.',
            group: 'Messages',
            destructive: true,
            inputs: { id: string({ title: 'Message' }) },
            outputs: messageOutput,
            request: ({ inputs }) => ({ method: 'POST', url: $`/users/me/messages/${expr`urlEncode(${inputs.id})`}/trash` }),
            errors: ({ response }) => [{ when: expr`${response.status} == 404`, error: 'notFound', field: 'id', message: 'That message does not exist' }],
            output: ({ response }) => ({ id: response.body.id, threadId: response.body.threadId, labelIds: response.body.labelIds })
        }),

        pollTrigger('new-email', {
            label: 'New email',
            description: 'Fires for each new message matching the search.',
            group: 'Triggers',
            readOnly: true,
            intervalSec: 60,
            inputs: {
                query: string({ title: 'Search', placeholder: 'from:billing@example.com has:attachment' }).optional(),
                labelIds: array(string(), { title: 'Labels', default: ['INBOX'], options: labelOptions }).optional()
            },
            request: ({ inputs }) => ({ url: '/users/me/messages', query: { q: inputs.query, labelIds: inputs.labelIds, maxResults: 50 } }),
            items: ({ response }) => expr`default(${response.body.messages}, [])`,
            dedupeKey: ({ item }) => item.id,
            event: ({ item }) => ({ id: item.id, threadId: item.threadId })
        })
    ]
});
