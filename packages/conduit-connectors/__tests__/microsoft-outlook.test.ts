/**
 * Microsoft Outlook against a scripted stand-in for the Microsoft identity
 * platform and Microsoft Graph. Every request is recorded, so the tests
 * assert the Graph JSON that would go on the wire as well as the mapping.
 */
import { describe, expect, it } from 'vitest';
import { createConduit, type CatalogOf } from '@aigntiq/conduit';
import { toolDefinitions } from '@aigntiq/conduit/schema';
import { connectorCatalog, type Connectors } from '@aigntiq/conduit-connectors';
import outlook from '@aigntiq/conduit-connectors/microsoft-outlook';
import { connect, json, last, REDIRECT, scriptedHttp, SECRET } from './support/stub';
import { renderWebhook } from './support/triggers';

const inbox = { id: 'AAMk-inbox', displayName: 'Inbox', wellKnownName: 'inbox' };

const m1 = {
    id: 'AAMk-m1',
    conversationId: 'conv-1',
    subject: 'Quarterly numbers',
    from: { emailAddress: { name: 'Grace Hopper', address: 'grace@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Ada', address: 'ada@example.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-05-04T08:00:00Z',
    sentDateTime: '2026-05-04T07:59:58Z',
    isRead: false,
    isDraft: false,
    importance: 'normal',
    hasAttachments: true,
    bodyPreview: 'Here they are',
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMk-m1',
    categories: ['Finance'],
    flag: { flagStatus: 'flagged' },
    parentFolderId: 'AAMk-inbox'
};
const m2 = { ...m1, id: 'AAMk-m2', subject: 'Lunch?', isRead: true, hasAttachments: false, categories: [], flag: { flagStatus: 'notFlagged' } };

function graphStub() {
    return scriptedHttp({
        tokenEndpoint: ['login.microsoftonline.com/common/oauth2/v2.0/token', 'login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token'],
        accessToken: 'eyJ0eXAi.graph',
        hosts: ['graph.microsoft.com'],
        prefix: '/v1.0',
        routes: ({ route: asked, url, body, headers }) => {
            // An app account's /users/<mailbox>/… answers as /me/… does.
            const route = asked.replace('/users/shared%40contoso.example', '/me');
            switch (route) {
                case 'GET /me/mailFolders/inbox':
                    return json(inbox);
                case 'GET /me':
                    return json({ id: 'user-object-id', displayName: 'Ada Lovelace', mail: null, userPrincipalName: 'ada@contoso.example' });
                case 'POST /me/sendMail': {
                    const to = JSON.parse(body).message.toRecipients ?? [];
                    if (to.some((r: { emailAddress: { address: string } }) => r.emailAddress.address.endsWith('.invalid'))) {
                        return json({ error: { code: 'ErrorInvalidRecipients', message: 'At least one recipient is not valid.' } }, 400);
                    }
                    return new Response(null, { status: 202 });
                }
                case 'POST /me/messages':
                    return json({ ...m1, id: 'AAMk-draft', isDraft: true, subject: JSON.parse(body).subject, flag: { flagStatus: 'notFlagged' } }, 201);
                case 'POST /me/messages/AAMk-m1/reply':
                case 'POST /me/messages/AAMk-m1/replyAll':
                case 'POST /me/messages/AAMk-m1/forward':
                    return new Response(null, { status: 202 });
                case 'POST /me/messages/missing/reply':
                    return json({ error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, 404);
                case 'GET /me/messages':
                    if (!url.searchParams.get('$skip')) {
                        // Graph's nextLink keeps the query and adds $skip.
                        const next = new URL(url);
                        next.searchParams.set('$skip', '1');
                        return json({ value: [m1], '@odata.nextLink': next.toString() });
                    }
                    return json({ value: [m2] });
                case 'GET /me/mailFolders/AAMk-inbox/messages':
                    return json({ value: [m1, m2] });
                case 'GET /me/messages/AAMk-m1':
                    return json({
                        ...m1,
                        body: headers.get('prefer')?.includes('"text"') ? { contentType: 'text', content: 'Here they are.' } : { contentType: 'html', content: '<p>Here they are.</p>' },
                        attachments: [{ id: 'att-1', name: 'numbers.xlsx', contentType: 'application/vnd.ms-excel', size: 2048, isInline: false }]
                    });
                case 'GET /me/messages/AAMk-m1/attachments/att-1':
                    return json({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'att-1', name: 'numbers.xlsx', contentType: 'application/vnd.ms-excel', size: 3, contentBytes: 'QUJD' });
                case 'GET /me/messages/AAMk-m1/attachments/att-item':
                    return json({ '@odata.type': '#microsoft.graph.itemAttachment', id: 'att-item', name: 'Fwd: meeting', size: 900 });
                case 'GET /me/mailFolders':
                    return json({ value: [{ id: 'f-projects', displayName: 'Projects' }, inbox, { id: 'f-sent', displayName: 'Sent Items', wellKnownName: 'sentitems' }] });
                case 'POST /me/messages/AAMk-m1/move':
                    return json({ ...m1, id: 'AAMk-m1-moved', parentFolderId: JSON.parse(body).destinationId }, 201);
                case 'PATCH /me/messages/AAMk-m1':
                    return json({ ...m1, ...JSON.parse(body) });
                case 'DELETE /me/messages/AAMk-m1':
                    return new Response(null, { status: 204 });
            }
            return undefined;
        }
    });
}

async function setup() {
    const stub = graphStub();
    return { ...(await connect('microsoft-outlook', stub.http)), seen: stub.seen };
}

/** An app account: client credentials for the contoso tenant, acting on one shared mailbox. */
async function connectApp(stub = graphStub()) {
    const conduit = createConduit<CatalogOf<Connectors>>({
        sources: connectorCatalog({ include: ['microsoft-outlook'] }),
        secret: SECRET,
        http: stub.http,
        redirectUri: REDIRECT,
        clients: { 'microsoft-outlook': { id: 'app-id', secret: 'app-secret' } }
    });
    const begun = await conduit.auth.begin({
        connector: 'microsoft-outlook',
        method: 'app',
        owner: 'automation',
        inputs: { tenantId: 'contoso.onmicrosoft.com', mailbox: 'Shared@contoso.example' }
    });
    if (begun.type !== 'connected') throw new Error('expected an immediate connection');
    return { conduit, account: begun.account.id, seen: stub.seen };
}

describe('Microsoft Outlook: app-only accounts', () => {
    it('connect with client credentials for the tenant and prove access to the mailbox', async () => {
        const { conduit, account, seen } = await connectApp();
        const token = last(seen, 'POST', /\/token$/);
        expect(token.url.pathname).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/token');
        expect(Object.fromEntries(new URLSearchParams(token.body))).toMatchObject({
            grant_type: 'client_credentials',
            scope: 'https://graph.microsoft.com/.default',
            client_id: 'app-id'
        });
        expect(last(seen, 'GET', /mailFolders\/inbox$/).url.pathname).toBe('/v1.0/users/shared%40contoso.example/mailFolders/inbox');
        expect(await conduit.accounts.get(account)).toMatchObject({
            method: 'app',
            externalId: 'shared@contoso.example',
            displayName: 'shared@contoso.example',
            data: { mailbox: 'shared@contoso.example', tenantId: 'contoso.onmicrosoft.com' }
        });
    });

    it('act on /users/<mailbox> instead of /me', async () => {
        const { conduit, account, seen } = await connectApp();
        await conduit.execute({ connector: 'microsoft-outlook', operation: 'send-email', account, inputs: { to: ['ada@example.com'], subject: 's', body: 'b' } });
        expect(last(seen, 'POST', /sendMail$/).url.pathname).toBe('/v1.0/users/shared%40contoso.example/sendMail');
        await conduit.execute({ connector: 'microsoft-outlook', operation: 'search-messages', account, inputs: { folderId: 'AAMk-inbox' }, paging: { maxPages: 1 } });
        expect(last(seen, 'GET', /\/messages$/).url.pathname).toBe('/v1.0/users/shared%40contoso.example/mailFolders/AAMk-inbox/messages');
        const { output } = await conduit.execute({ connector: 'microsoft-outlook', operation: 'get-message', account, inputs: { id: 'AAMk-m1' } });
        expect(output).toMatchObject({ id: 'AAMk-m1' });
        expect(last(seen, 'GET', /AAMk-m1$/).url.pathname).toBe('/v1.0/users/shared%40contoso.example/messages/AAMk-m1');
        expect(await conduit.options({ connector: 'microsoft-outlook', operation: 'list-folders', account })).toHaveLength(3);
    });

    it('subscribe to the mailbox, not /me', async () => {
        const account = { method: 'app', data: { mailbox: 'shared@contoso.example' } };
        const subscription = { callbackUrl: 'https://app.example/hooks/x', secret: 's', data: { id: 'sub' } };
        const created = (await (await renderWebhook(outlook, 'new-email', { account, subscription })).subscribe()) as { body: { resource: string } };
        expect(created.body.resource).toBe("users/shared%40contoso.example/mailFolders('inbox')/messages");
    });
});

describe('Microsoft Outlook: connecting', () => {
    it('signs in through the common tenant with offline access and identifies the account by object id', async () => {
        const { conduit, account, authorizeUrl } = await setup();
        expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
        expect(authorizeUrl.searchParams.get('scope')).toBe(
            'offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send'
        );
        expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
        expect(await conduit.accounts.get(account)).toMatchObject({ externalId: 'user-object-id', displayName: 'ada@contoso.example' });
    });

    it('signs in through the tenant a host configures', async () => {
        const stub = graphStub();
        const conduit = createConduit<CatalogOf<Connectors>>({
            sources: connectorCatalog({ include: ['microsoft-outlook'] }),
            secret: SECRET,
            http: stub.http,
            redirectUri: REDIRECT,
            clients: { 'microsoft-outlook': { id: 'app-id', secret: 'app-secret' } },
            config: { 'microsoft-outlook': { tenant: 'contoso.onmicrosoft.com' } }
        });
        const begun = await conduit.auth.begin({ connector: 'microsoft-outlook', method: 'oauth', owner: 'u1' });
        expect(begun.type === 'redirect' && new URL(begun.url).pathname).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    });
});

describe('Microsoft Outlook: sending', () => {
    it('refuses a message without recipients before calling Graph', async () => {
        const { conduit, account, seen } = await setup();
        const before = seen.length;
        const err = await conduit.execute({ connector: 'microsoft-outlook', operation: 'send-email', account, inputs: { subject: 'x', body: 'y' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'inputs_invalid' });
        expect(seen.length).toBe(before);
    });

    it('sends Graph JSON: named recipients, HTML body, file attachments', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'microsoft-outlook',
            operation: 'send-email',
            account,
            inputs: {
                to: ['"Grace Hopper" <grace@example.com>', 'linus@example.com'],
                subject: 'Numbers',
                body: '<p>Attached.</p>',
                importance: 'high',
                attachments: [{ filename: 'n.csv', contentType: 'text/csv', base64: 'YSxi' }]
            }
        });
        expect(output).toEqual({ sent: true });
        expect(JSON.parse(last(seen, 'POST', /sendMail$/).body)).toEqual({
            message: {
                subject: 'Numbers',
                body: { contentType: 'HTML', content: '<p>Attached.</p>' },
                toRecipients: [{ emailAddress: { name: 'Grace Hopper', address: 'grace@example.com' } }, { emailAddress: { address: 'linus@example.com' } }],
                importance: 'high',
                attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'n.csv', contentType: 'text/csv', contentBytes: 'YSxi' }]
            },
            saveToSentItems: true
        });
    });

    it('checks addresses locally, and puts one Graph refuses on the to field', async () => {
        const { conduit, account } = await setup();
        const err = await conduit
            .execute({ connector: 'microsoft-outlook', operation: 'send-email', account, inputs: { to: ['Nobody <nobody@example.invalid>'], subject: 's', body: 'b', format: 'text' } })
            .catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.to', code: 'remote' }] });
        const local = await conduit.execute({ connector: 'microsoft-outlook', operation: 'send-email', account, inputs: { to: ['nobody'], subject: 's', body: 'b' } }).catch((e: unknown) => e);
        expect(local).toMatchObject({ code: 'inputs_invalid', issues: [{ path: 'inputs.to[0]', code: 'format' }] });
    });

    it('saves drafts, replies (to all), and forwards', async () => {
        const { conduit, account, seen } = await setup();
        const draft = await conduit.execute({ connector: 'microsoft-outlook', operation: 'create-draft', account, inputs: { subject: 'Later', body: 'text', format: 'text' } });
        expect(JSON.parse(last(seen, 'POST', /\/me\/messages$/).body).body).toEqual({ contentType: 'Text', content: 'text' });
        expect(draft.output).toMatchObject({ id: 'AAMk-draft', isDraft: true, subject: 'Later' });

        await conduit.execute({ connector: 'microsoft-outlook', operation: 'reply-to-message', account, inputs: { messageId: 'AAMk-m1', body: 'Thanks!' } });
        expect(JSON.parse(last(seen, 'POST', /\/reply$/).body)).toEqual({ comment: 'Thanks!' });
        await conduit.execute({ connector: 'microsoft-outlook', operation: 'reply-to-message', account, inputs: { messageId: 'AAMk-m1', body: 'All: thanks', replyAll: true } });
        expect(last(seen, 'POST', /replyAll$/)).toBeDefined();

        await conduit.execute({ connector: 'microsoft-outlook', operation: 'forward-message', account, inputs: { messageId: 'AAMk-m1', to: ['linus@example.com'], body: 'FYI' } });
        expect(JSON.parse(last(seen, 'POST', /forward$/).body)).toEqual({ toRecipients: [{ emailAddress: { address: 'linus@example.com' } }], comment: 'FYI' });

        const err = await conduit.execute({ connector: 'microsoft-outlook', operation: 'reply-to-message', account, inputs: { messageId: 'missing', body: 'x' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.messageId', code: 'remote' }] });
    });
});

describe('Microsoft Outlook: reading', () => {
    it('lists the mailbox newest first across pages, flattened', async () => {
        const { conduit, account, seen } = await setup();
        const { output, pages } = await conduit.execute({ connector: 'microsoft-outlook', operation: 'search-messages', account });
        expect(pages).toBe(2);
        const params = Object.fromEntries(seen.find((s) => s.url.pathname === '/v1.0/me/messages')!.url.searchParams);
        expect(params).toMatchObject({ $orderby: 'receivedDateTime desc', $top: '50' });
        expect(params).not.toHaveProperty('$search');
        expect(output[0]).toEqual({
            id: 'AAMk-m1',
            conversationId: 'conv-1',
            subject: 'Quarterly numbers',
            from: { name: 'Grace Hopper', address: 'grace@example.com' },
            to: [{ name: 'Ada', address: 'ada@example.com' }],
            cc: [],
            receivedAt: '2026-05-04T08:00:00Z',
            sentAt: '2026-05-04T07:59:58Z',
            isRead: false,
            isDraft: false,
            importance: 'normal',
            hasAttachments: true,
            preview: 'Here they are',
            webLink: 'https://outlook.office365.com/owa/?ItemID=AAMk-m1',
            categories: ['Finance'],
            flagged: true,
            folderId: 'AAMk-inbox'
        });
        expect(output.map((m) => m.id)).toEqual(['AAMk-m1', 'AAMk-m2']);
    });

    it('searches a folder with quoted text, filtering unread from the results', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-outlook', operation: 'search-messages', account, inputs: { query: 'subject:"q1"', folderId: 'AAMk-inbox', unreadOnly: true } });
        const params = Object.fromEntries(last(seen, 'GET', /mailFolders\/AAMk-inbox\/messages$/).url.searchParams);
        expect(params.$search).toBe('"subject:\\"q1\\""');
        expect(params).not.toHaveProperty('$filter');
        expect(params).not.toHaveProperty('$orderby');
        expect(output.map((m) => m.id)).toEqual(['AAMk-m1']);

        await conduit.execute({ connector: 'microsoft-outlook', operation: 'search-messages', account, inputs: { unreadOnly: true } });
        expect(last(seen, 'GET', /\/me\/messages$/).url.searchParams.get('$filter')).toBe('isRead eq false');
    });

    it('gets a message with its body as HTML or text, and its attachment list', async () => {
        const { conduit, account, seen } = await setup();
        const html = await conduit.execute({ connector: 'microsoft-outlook', operation: 'get-message', account, inputs: { id: 'AAMk-m1' } });
        expect(html.output).toMatchObject({
            id: 'AAMk-m1',
            bodyType: 'html',
            body: '<p>Here they are.</p>',
            attachments: [{ id: 'att-1', name: 'numbers.xlsx', contentType: 'application/vnd.ms-excel', size: 2048, inline: false }]
        });
        expect(last(seen, 'GET', /AAMk-m1$/).headers.get('prefer')).toBe('outlook.body-content-type="html"');
        const text = await conduit.execute({ connector: 'microsoft-outlook', operation: 'get-message', account, inputs: { id: 'AAMk-m1', format: 'text' } });
        expect(text.output).toMatchObject({ bodyType: 'text', body: 'Here they are.' });
    });

    it('downloads a file attachment as a file value, and refuses an attached message', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-outlook', operation: 'get-attachment', account, inputs: { messageId: 'AAMk-m1', attachmentId: 'att-1' } });
        expect(output).toEqual({ filename: 'numbers.xlsx', contentType: 'application/vnd.ms-excel', base64: 'QUJD', size: 3 });
        const err = await conduit.execute({ connector: 'microsoft-outlook', operation: 'get-attachment', account, inputs: { messageId: 'AAMk-m1', attachmentId: 'att-item' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.attachmentId' }] });
    });

    it('offers folders, the standard ones first', async () => {
        const { conduit, account } = await setup();
        expect(await conduit.options({ connector: 'microsoft-outlook', operation: 'list-folders', account })).toEqual([
            { label: 'Inbox', value: 'AAMk-inbox' },
            { label: 'Sent Items', value: 'f-sent' },
            { label: 'Projects', value: 'f-projects' }
        ]);
        expect(await conduit.options({ connector: 'microsoft-outlook', operation: 'list-folders', account, inputs: { query: 'proj' } })).toEqual([{ label: 'Projects', value: 'f-projects' }]);
    });
});

describe('Microsoft Outlook: filing', () => {
    it('moves a message and returns its new id', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-outlook', operation: 'move-message', account, inputs: { id: 'AAMk-m1', folderId: 'f-projects' } });
        expect(JSON.parse(last(seen, 'POST', /move$/).body)).toEqual({ destinationId: 'f-projects' });
        expect(output).toMatchObject({ id: 'AAMk-m1-moved', folderId: 'f-projects' });
    });

    it('marks, flags and categorizes only what is given, and needs something', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-outlook', operation: 'update-message', account, inputs: { id: 'AAMk-m1', isRead: true, flag: 'complete' } });
        expect(JSON.parse(last(seen, 'PATCH', /AAMk-m1$/).body)).toEqual({ isRead: true, flag: { flagStatus: 'complete' } });
        expect(output).toMatchObject({ isRead: true, flagged: false });
        const cleared = await conduit.execute({ connector: 'microsoft-outlook', operation: 'update-message', account, inputs: { id: 'AAMk-m1', categories: [] } });
        expect(JSON.parse(last(seen, 'PATCH', /AAMk-m1$/).body)).toEqual({ categories: [] });
        expect(cleared.output.categories).toEqual([]);
        const err = await conduit.execute({ connector: 'microsoft-outlook', operation: 'update-message', account, inputs: { id: 'AAMk-m1' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'inputs_invalid' });
    });

    it('deletes (to Deleted Items), marked destructive', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({ connector: 'microsoft-outlook', operation: 'delete-message', account, inputs: { id: 'AAMk-m1' } });
        expect(output).toEqual({ deleted: true, id: 'AAMk-m1' });
    });
});

describe('Microsoft Outlook: new-email trigger', () => {
    const subscription = { callbackUrl: 'https://app.example/conduit/hooks/abc', secret: 'client-state-secret', data: { id: 'sub-1' } };
    const hook = (inputs: Record<string, unknown> = {}) => renderWebhook(outlook, 'new-email', { inputs, subscription });

    it('subscribes a folder (the Inbox by default) for created messages, and renews and ends that subscription', async () => {
        const inbox = (await (await hook()).subscribe()) as { url: string; body: Record<string, string> };
        expect(inbox.url).toBe('https://graph.microsoft.com/v1.0/subscriptions');
        expect(inbox.body).toMatchObject({
            changeType: 'created',
            notificationUrl: 'https://app.example/conduit/hooks/abc',
            resource: "me/mailFolders('inbox')/messages",
            clientState: 'client-state-secret'
        });
        const expires = Date.parse(inbox.body.expirationDateTime!) - Date.now();
        expect(expires / 60_000).toBeGreaterThan(4300);
        expect(expires / 60_000).toBeLessThanOrEqual(10_080);
        const folder = (await (await hook({ folderId: 'f-projects' })).subscribe()) as { body: { resource: string } };
        expect(folder.body.resource).toBe("me/mailFolders('f-projects')/messages");
        const renew = await (await hook()).renew();
        expect(renew!.everyMinutes).toBeLessThan(4320);
        expect(renew!.request).toMatchObject({ method: 'PATCH', url: 'https://graph.microsoft.com/v1.0/subscriptions/sub-1' });
        expect(await (await hook()).unsubscribe()).toMatchObject({ method: 'DELETE', url: 'https://graph.microsoft.com/v1.0/subscriptions/sub-1' });
    });

    it('echoes the validation token, and accepts only notifications with its clientState', async () => {
        const webhook = await hook();
        expect(await webhook.deliver({ query: { validationToken: 'Validation: token 123' } })).toEqual({
            handshake: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'Validation: token 123' }
        });

        const note = (clientState: string, id: string) => ({ subscriptionId: 'sub-1', clientState, changeType: 'created', resource: `me/messages/${id}`, resourceData: { id } });
        expect(await webhook.deliver({ body: { value: [note('client-state-secret', 'AAMk-a'), note('client-state-secret', 'AAMk-b')] } })).toEqual({
            valid: true,
            accepted: true,
            events: [
                { id: 'AAMk-a', changeType: 'created', subscriptionId: 'sub-1' },
                { id: 'AAMk-b', changeType: 'created', subscriptionId: 'sub-1' }
            ],
            dedupeKey: 'created:AAMk-a,created:AAMk-b'
        });
        expect(await webhook.deliver({ body: { value: [note('client-state-secret', 'AAMk-a'), note('guess', 'AAMk-x')] } })).toMatchObject({ valid: false });
        expect(await webhook.deliver({ body: {} })).toMatchObject({ valid: false });
    });
});

describe('Microsoft Outlook: intent and typing', () => {
    it('marks the pure reads readOnly and only delete destructive', async () => {
        const { conduit } = await setup();
        const ops = (await conduit.connectors.describe('microsoft-outlook')).operations;
        expect(ops.filter((o) => o.readOnly).map((o) => o.id)).toEqual(['search-messages', 'get-message', 'get-attachment', 'list-folders', 'new-email']);
        expect(ops.filter((o) => o.destructive).map((o) => o.id)).toEqual(['delete-message']);
        const tools = toolDefinitions(await conduit.connectors.describe('microsoft-outlook'));
        expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/"x-/);
    });

    it('types every operation through the catalog', async () => {
        const { conduit, account } = await setup();
        // @ts-expect-error — not an Outlook operation
        void (() => conduit.execute({ connector: 'microsoft-outlook', operation: 'empty-deleted-items', account }));
        // @ts-expect-error — flag is flagged | complete | notFlagged
        void (() => conduit.execute({ connector: 'microsoft-outlook', operation: 'update-message', account, inputs: { id: 'm', flag: 'red' } }));
    });
});
