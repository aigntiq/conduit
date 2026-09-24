/**
 * Microsoft Outlook — send, draft, reply, forward, search, read, file and
 * delete mail in a Microsoft 365 or Outlook.com mailbox, through Microsoft
 * Graph.
 *
 * Graph takes messages as JSON (recipients as `{ emailAddress: { address,
 * name } }`, attachments as base64 `fileAttachment`s); the connector takes
 * plain address lists — `Name <address>` included — and file values.
 */
import {
    $,
    action,
    array,
    boolean,
    connector,
    emails,
    expr,
    files,
    integer,
    object,
    options,
    rules,
    search,
    select,
    string,
    richtext,
    webhookTrigger,
    type ErrorRuleDef,
    type Ref
} from '@aigntiq/conduit/builder';
import { GRAPH, graphPaging, graphRetry, graphSubscription, microsoftOAuth, microsoftSetup } from '../_shared/microsoft';

const SCOPES = ['Mail.ReadWrite', 'Mail.Send'];

/** Everything `messageOf` reads. */
const MESSAGE_FIELDS =
    'id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,isRead,isDraft,importance,hasAttachments,bodyPreview,webLink,categories,flag,parentFolderId';

// ── Shared pieces ───────────────────────────────────────────────────────

const folderOptions = { operation: 'list-folders', search: 'query' };

const format = select({ html: 'Formatted (HTML)', text: 'Plain text' }, { title: 'Format', default: 'html', advanced: true });

/** Graph caps an attachment sent inline with the message at 3 MB. */
const attachmentsField = (group?: string) => files({ title: 'Attachments', maxBytes: 3_000_000, ...(group ? { group } : {}) });

const composeFields = {
    to: emails({ title: 'To', group: 'Recipients' }).optional(),
    cc: emails({ title: 'Cc', group: 'Recipients', advanced: true }).optional(),
    bcc: emails({ title: 'Bcc', group: 'Recipients', advanced: true }).optional(),
    subject: string({ title: 'Subject', group: 'Message' }),
    body: richtext({ title: 'Message', group: 'Message' }),
    format: select({ html: 'Formatted (HTML)', text: 'Plain text' }, { title: 'Format', default: 'html', group: 'Message', advanced: true }).optional(),
    importance: select({ low: 'Low', normal: 'Normal', high: 'High' }, { title: 'Importance', default: 'normal', group: 'Message', advanced: true }).optional(),
    attachments: attachmentsField('Attachments').optional(),
    replyTo: emails({ title: 'Reply to', group: 'Recipients', advanced: true }).optional()
};

type Compose = {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    format?: 'html' | 'text';
    importance?: 'low' | 'normal' | 'high';
    attachments?: unknown[];
    replyTo?: string[];
};

const recipientsRule = rules.atLeastOne(['to', 'cc', 'bcc'], 'Add at least one recipient');

/** A Graph message body for a composed form. */
function message(inputs: Ref<Compose>) {
    return {
        subject: inputs.subject,
        body: { contentType: expr`${inputs.format} == 'text' ? 'Text' : 'HTML'`, content: inputs.body },
        toRecipients: expr`recipients(${inputs.to})`,
        ccRecipients: expr`recipients(${inputs.cc})`,
        bccRecipients: expr`recipients(${inputs.bcc})`,
        replyTo: expr`recipients(${inputs.replyTo})`,
        importance: inputs.importance,
        attachments: expr`fileAttachments(${inputs.attachments})`
    };
}

/** `/me/messages/<id>[suffix]`, encoded. */
function messageUrl(id: Ref, suffix: unknown = '') {
    return $`/me/messages/${expr`urlEncode(${id})`}${suffix}`;
}

function notFound(response: Ref, field: string, what = 'message'): ErrorRuleDef {
    return { when: expr`${response.status} == 404`, error: 'notFound', field, message: `That ${what} does not exist` };
}

/** Graph rejects a malformed recipient with 400 ErrorInvalidRecipients. */
function recipientErrors(response: Ref): ErrorRuleDef[] {
    return [
        {
            when: expr`${response.status} == 400 && contains(['ErrorInvalidRecipients', 'ErrorInvalidRecipientsSmtpAddress'], ${response.body.error.code})`,
            error: 'validation',
            field: 'to',
            message: 'One of the recipients is not a valid address'
        }
    ];
}

const addressOutput = object({ name: string().optional(), address: string() });

const messageOutput = object({
    id: string(),
    conversationId: string().optional(),
    subject: string().optional(),
    from: addressOutput.optional(),
    to: array(addressOutput),
    cc: array(addressOutput),
    receivedAt: string().optional(),
    sentAt: string().optional(),
    isRead: boolean(),
    isDraft: boolean().optional(),
    importance: string().optional(),
    hasAttachments: boolean().optional(),
    preview: string().optional(),
    webLink: string().optional(),
    categories: array(string()),
    flagged: boolean(),
    folderId: string().optional()
});

// ── Connector ───────────────────────────────────────────────────────────

export default connector({
    id: 'microsoft-outlook',
    name: 'Microsoft Outlook',
    version: '1.0.0',
    description: 'Send, draft, reply, forward, search, read, file and delete email in Outlook (Microsoft 365 and Outlook.com).',
    categories: ['email', 'productivity'],
    brandColor: '#0f6cbd',
    homepage: 'https://outlook.office.com',
    helpUrl: 'https://learn.microsoft.com/graph/outlook-mail-concept-overview',
    config: { baseUrl: GRAPH, tenant: 'common' },
    functions: {
        recipients: {
            params: ['list'],
            description: 'Graph recipients from addresses; "Name <address>" keeps the name.',
            body: `list == undefined ? undefined : map(list, a => contains(a, '<')
                ? {emailAddress: {name: trim(replace(first(split(a, '<')), '"', '')), address: trim(replace(last(split(a, '<')), '>', ''))}}
                : {emailAddress: {address: trim(a)}})`
        },
        fileAttachments: {
            params: ['files'],
            description: 'Graph file attachments from file values.',
            body: `files == undefined ? undefined : map(files, f => {'@odata.type': '#microsoft.graph.fileAttachment', name: f.filename, contentType: default(f.contentType, 'application/octet-stream'), contentBytes: f.base64})`
        },
        addressOf: {
            params: ['r'],
            description: 'A Graph recipient as { name, address }.',
            body: 'r == undefined ? undefined : compactObject({name: r.emailAddress.name, address: r.emailAddress.address})'
        },
        messageOf: {
            params: ['m'],
            description: 'A Graph message, flattened.',
            body: `{
                id: m.id,
                conversationId: m.conversationId,
                subject: m.subject,
                from: addressOf(m.from),
                to: map(default(m.toRecipients, []), r => addressOf(r)),
                cc: map(default(m.ccRecipients, []), r => addressOf(r)),
                receivedAt: m.receivedDateTime,
                sentAt: m.sentDateTime,
                isRead: default(m.isRead, false),
                isDraft: m.isDraft,
                importance: m.importance,
                hasAttachments: m.hasAttachments,
                preview: m.bodyPreview,
                webLink: m.webLink,
                categories: default(m.categories, []),
                flagged: m.flag.flagStatus == 'flagged',
                folderId: m.parentFolderId
            } | compactObject`
        }
    },
    http: ({ config }) => ({
        baseUrl: config.baseUrl,
        headers: { Accept: 'application/json' },
        retry: graphRetry
    }),
    auth: [
        microsoftOAuth({
            scopes: SCOPES,
            helpUrl: 'https://learn.microsoft.com/graph/permissions-reference',
            setup: microsoftSetup('microsoft-outlook', SCOPES, ['Personal Outlook.com accounts work too when the app registration allows personal accounts.'])
        })
    ],
    operations: [
        action('send-email', {
            label: 'Send email',
            description: 'Send a message, with optional attachments (up to 3 MB each). A copy is kept in Sent Items.',
            group: 'Messages',
            inputs: composeFields,
            rules: [recipientsRule],
            outputs: object({ sent: boolean() }),
            request: ({ inputs }) => ({ method: 'POST', url: '/me/sendMail', body: { message: message(inputs), saveToSentItems: true } }),
            errors: ({ response }) => recipientErrors(response),
            output: () => ({ sent: true })
        }),

        action('create-draft', {
            label: 'Create draft',
            description: 'Save a message in Drafts without sending it.',
            group: 'Messages',
            inputs: composeFields,
            outputs: messageOutput,
            request: ({ inputs }) => ({ method: 'POST', url: '/me/messages', body: message(inputs) }),
            errors: ({ response }) => recipientErrors(response),
            output: ({ response }) => expr`messageOf(${response.body})`
        }),

        action('reply-to-message', {
            label: 'Reply to message',
            description: 'Reply in the conversation, to the sender or to everyone; Outlook quotes the original below.',
            group: 'Messages',
            inputs: {
                messageId: string({ title: 'Message' }),
                body: richtext({ title: 'Message' }),
                replyAll: boolean({ title: 'Reply to all', default: false }).optional()
            },
            outputs: object({ sent: boolean() }),
            request: ({ inputs }) => ({ method: 'POST', url: messageUrl(inputs.messageId, expr`${inputs.replyAll} ? '/replyAll' : '/reply'`), body: { comment: inputs.body } }),
            errors: ({ response }) => [notFound(response, 'messageId')],
            output: () => ({ sent: true })
        }),

        action('forward-message', {
            label: 'Forward message',
            group: 'Messages',
            inputs: {
                messageId: string({ title: 'Message' }),
                to: emails({ title: 'To', minItems: 1 }),
                body: richtext({ title: 'Message', description: 'Shown above the forwarded message.' }).optional()
            },
            outputs: object({ sent: boolean() }),
            request: ({ inputs }) => ({ method: 'POST', url: messageUrl(inputs.messageId, '/forward'), body: { toRecipients: expr`recipients(${inputs.to})`, comment: inputs.body } }),
            errors: ({ response }) => [notFound(response, 'messageId'), ...recipientErrors(response)],
            output: () => ({ sent: true })
        }),

        search('search-messages', {
            label: 'Search messages',
            description: 'Messages matching search text (as in Outlook’s search box), in one folder or the whole mailbox, newest first.',
            group: 'Messages',
            readOnly: true,
            inputs: {
                query: string({ title: 'Search', placeholder: 'from:ada@example.com subject:invoice' }).optional(),
                folderId: string({ title: 'Folder', description: 'Default: every folder.', options: folderOptions }).optional(),
                unreadOnly: boolean({ title: 'Unread only', default: false }).optional()
            },
            outputs: array(messageOutput),
            // Graph can't combine $search with $filter or $orderby: with search
            // text, unread is filtered from the results instead.
            request: ({ inputs }) => ({
                url: expr`isEmpty(${inputs.folderId}) ? '/me/messages' : '/me/mailFolders/' + urlEncode(${inputs.folderId}) + '/messages'`,
                query: {
                    $search: expr`isEmpty(${inputs.query}) ? undefined : '"' + replace(${inputs.query}, '"', '\\\\"') + '"'`,
                    $filter: expr`isEmpty(${inputs.query}) && ${inputs.unreadOnly} ? 'isRead eq false' : undefined`,
                    $orderby: expr`isEmpty(${inputs.query}) ? 'receivedDateTime desc' : undefined`,
                    $select: MESSAGE_FIELDS,
                    $top: 50
                }
            }),
            errors: ({ response }) => [notFound(response, 'folderId', 'folder')],
            paginate: ({ response }) => graphPaging(response, 20),
            output: ({ items, inputs }) => expr`${items} | filter(m => !(${inputs.unreadOnly} && m.isRead)) | map(m => messageOf(m))`
        }),

        action('get-message', {
            label: 'Get message',
            group: 'Messages',
            readOnly: true,
            inputs: {
                id: string({ title: 'Message' }),
                format: format.optional()
            },
            outputs: object({
                id: string(),
                subject: string().optional(),
                from: addressOutput.optional(),
                to: array(addressOutput),
                cc: array(addressOutput),
                receivedAt: string().optional(),
                isRead: boolean(),
                categories: array(string()),
                flagged: boolean(),
                bodyType: string(),
                body: string(),
                attachments: array(object({ id: string(), name: string(), contentType: string().optional(), size: integer(), inline: boolean() }))
            }),
            request: ({ inputs }) => ({
                url: messageUrl(inputs.id),
                query: { $select: `${MESSAGE_FIELDS},body`, $expand: 'attachments($select=id,name,contentType,size,isInline)' },
                headers: { Prefer: expr`'outlook.body-content-type="' + (${inputs.format} == 'text' ? 'text' : 'html') + '"'` }
            }),
            errors: ({ response }) => [notFound(response, 'id')],
            output: ({ response }) =>
                expr`merge(messageOf(${response.body}), {
                    bodyType: lower(${response.body.body.contentType}),
                    body: default(${response.body.body.content}, ''),
                    attachments: map(default(${response.body.attachments}, []), a => compactObject({id: a.id, name: a.name, contentType: a.contentType, size: a.size, inline: default(a.isInline, false)}))
                })`
        }),

        action('get-attachment', {
            label: 'Download attachment',
            description: 'An attachment of a message as a file value, ready to attach or upload elsewhere.',
            group: 'Messages',
            readOnly: true,
            inputs: { messageId: string({ title: 'Message' }), attachmentId: string({ title: 'Attachment' }) },
            outputs: object({ filename: string(), contentType: string(), base64: string(), size: integer() }),
            request: ({ inputs }) => ({ url: messageUrl(inputs.messageId, $`/attachments/${expr`urlEncode(${inputs.attachmentId})`}`) }),
            errors: ({ response }) => [
                notFound(response, 'attachmentId', 'attachment'),
                {
                    when: expr`${response.status} < 300 && ${response.body['@odata.type']} != '#microsoft.graph.fileAttachment'`,
                    error: 'validation',
                    field: 'attachmentId',
                    message: 'That attachment is an attached message or link, not a file'
                }
            ],
            output: ({ response }) => ({
                filename: response.body.name,
                contentType: expr`default(${response.body.contentType}, 'application/octet-stream')`,
                base64: response.body.contentBytes,
                size: response.body.size
            })
        }),

        options('list-folders', {
            label: 'Mail folders',
            readOnly: true,
            inputs: { query: string({ title: 'Search' }).optional() },
            request: { url: '/me/mailFolders', query: { $top: 100, $select: 'id,displayName,wellKnownName' } },
            paginate: ({ response }) => graphPaging(response, 5),
            // Top-level folders, the well-known ones (Inbox, Sent Items, …) first.
            output: ({ items, inputs }) =>
                expr`${items}
                    | filter(f => isEmpty(${inputs.query}) || contains(lower(f.displayName), lower(${inputs.query})))
                    | sortBy(f => (f.wellKnownName ? '0' : '1') + lower(f.displayName))
                    | map(f => {label: f.displayName, value: f.id})`
        }),

        action('move-message', {
            label: 'Move message',
            description: 'Move a message to another folder. The moved message has a new id, which is returned.',
            group: 'Messages',
            inputs: { id: string({ title: 'Message' }), folderId: string({ title: 'To folder', options: folderOptions }) },
            outputs: messageOutput,
            request: ({ inputs }) => ({ method: 'POST', url: messageUrl(inputs.id, '/move'), body: { destinationId: inputs.folderId } }),
            errors: ({ response }) => [
                notFound(response, 'id'),
                {
                    when: expr`${response.status} == 400 && contains(default(${response.body.error.code}, ''), 'Folder')`,
                    error: 'validation',
                    field: 'folderId',
                    message: 'That folder does not exist'
                }
            ],
            output: ({ response }) => expr`messageOf(${response.body})`
        }),

        action('update-message', {
            label: 'Mark, flag or categorize',
            description: 'Mark read or unread, flag, set categories or importance; only the fields given.',
            group: 'Messages',
            inputs: {
                id: string({ title: 'Message' }),
                isRead: boolean({ title: 'Read' }).optional(),
                flag: select({ flagged: 'Flagged', complete: 'Completed', notFlagged: 'Not flagged' }, { title: 'Flag' }).optional(),
                categories: array(string(), { title: 'Categories', description: 'Replaces the message’s categories.' }).optional(),
                importance: select({ low: 'Low', normal: 'Normal', high: 'High' }, { title: 'Importance' }).optional()
            },
            rules: [rules.check('{{ inputs.isRead != undefined || inputs.flag != undefined || inputs.categories != undefined || inputs.importance != undefined }}', 'Choose something to change', ['isRead', 'flag', 'categories', 'importance'])],
            outputs: messageOutput,
            request: ({ inputs }) => ({
                method: 'PATCH',
                url: messageUrl(inputs.id),
                body: {
                    isRead: inputs.isRead,
                    flag: expr`${inputs.flag} == undefined ? undefined : {flagStatus: ${inputs.flag}}`,
                    categories: inputs.categories,
                    importance: inputs.importance
                }
            }),
            errors: ({ response }) => [notFound(response, 'id')],
            output: ({ response }) => expr`messageOf(${response.body})`
        }),

        action('delete-message', {
            label: 'Delete message',
            description: 'Moves the message to Deleted Items.',
            group: 'Messages',
            destructive: true,
            inputs: { id: string({ title: 'Message' }) },
            outputs: object({ deleted: boolean(), id: string() }),
            request: ({ inputs }) => ({ method: 'DELETE', url: messageUrl(inputs.id) }),
            errors: ({ response }) => [notFound(response, 'id')],
            output: ({ inputs }) => ({ deleted: true, id: inputs.id })
        }),

        webhookTrigger('new-email', {
            label: 'New email',
            description: 'Fires when a message arrives in a folder (the Inbox by default), with its id — get the message for the rest.',
            group: 'Triggers',
            readOnly: true,
            inputs: { folderId: string({ title: 'Folder', description: 'Default: Inbox.', options: folderOptions }).optional() },
            outputs: object({ id: string(), changeType: string(), subscriptionId: string() }),
            trigger: graphSubscription({
                resource: ({ inputs }) => $`me/mailFolders('${expr`default(${inputs.folderId}, 'inbox')`}')/messages`,
                changeType: 'created',
                // Mail subscriptions live at most 10 080 minutes (7 days).
                lifetimeMinutes: 4320,
                renewEveryMinutes: 2880
            })
        })
    ]
});
