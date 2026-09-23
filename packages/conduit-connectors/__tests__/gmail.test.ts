/**
 * Gmail against a scripted stand-in for Google's OAuth and Gmail endpoints.
 * Every request is recorded, so the tests assert what would go on the wire —
 * including the decoded MIME message Gmail receives in `raw`.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ConduitRequestError, ConduitValidationError, createConduit, type CatalogOf, type HttpClient } from '@aigntiq/conduit';
import { connectorCatalog, type Connectors } from '@aigntiq/conduit-connectors';

const SECRET = 'gmail-connector-tests-secret-long-enough';
const REDIRECT = 'https://app.example/conduit/auth/callback';
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

interface Seen {
    method: string;
    url: URL;
    body: string;
}

function gmailStub() {
    const seen: Seen[] = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const http: HttpClient = async (request) => {
        const url = new URL(request.url);
        const body = request.body ? await request.text() : '';
        seen.push({ method: request.method, url, body });
        const path = url.pathname.replace('/gmail/v1', '');
        const route = `${request.method} ${url.host}${path}`;

        if (route === 'POST oauth2.googleapis.com/token') return json({ access_token: 'ya29.token', refresh_token: '1//refresh', expires_in: 3599, token_type: 'Bearer' });
        if (route === 'POST oauth2.googleapis.com/revoke') return json({});
        if (url.host !== 'gmail.googleapis.com') return json({ error: { message: 'unexpected host' } }, 500);
        if (request.headers.get('authorization') !== 'Bearer ya29.token') return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);

        switch (`${request.method} ${path}`) {
            case 'GET /users/me/profile':
                return json({ emailAddress: 'ada@example.com', messagesTotal: 10 });
            case 'POST /users/me/messages/send': {
                const raw = Buffer.from(JSON.parse(body).raw, 'base64url').toString();
                if (/^To: .*bad@/m.test(raw)) return json({ error: { code: 400, message: 'Invalid To header', status: 'INVALID_ARGUMENT' } }, 400);
                return json({ id: 'm-sent', threadId: JSON.parse(body).threadId ?? 't-new', labelIds: ['SENT'] });
            }
            case 'POST /users/me/drafts':
                return json({ id: 'd1', message: { id: 'm-draft', threadId: 't-draft' } });
            case 'GET /users/me/messages/orig':
                return json({
                    id: 'orig',
                    threadId: 't-orig',
                    payload: {
                        headers: [
                            { name: 'Subject', value: 'Quarterly numbers' },
                            { name: 'From', value: 'Grace <grace@example.com>' },
                            { name: 'To', value: 'ada@example.com' },
                            { name: 'Cc', value: 'linus@example.com' },
                            { name: 'Message-ID', value: '<orig@mail.example>' },
                            { name: 'References', value: '<root@mail.example>' }
                        ]
                    }
                });
            case 'GET /users/me/messages': {
                const token = url.searchParams.get('pageToken');
                if (!token) return json({ messages: [{ id: 'a', threadId: 'ta' }, { id: 'b', threadId: 'tb' }], nextPageToken: 'p2' });
                return json({ messages: [{ id: 'c', threadId: 'tc' }] });
            }
            case 'GET /users/me/messages/m1':
                return json({
                    id: 'm1',
                    threadId: 't1',
                    labelIds: ['INBOX', 'UNREAD'],
                    snippet: 'Hello there',
                    internalDate: '1767225600000',
                    payload: {
                        mimeType: 'multipart/mixed',
                        headers: [
                            { name: 'From', value: 'Grace <grace@example.com>' },
                            { name: 'To', value: 'ada@example.com' },
                            { name: 'Subject', value: 'Hello' },
                            { name: 'Message-ID', value: '<m1@mail.example>' }
                        ],
                        parts: [
                            {
                                mimeType: 'multipart/alternative',
                                filename: '',
                                parts: [
                                    { mimeType: 'text/plain', filename: '', body: { size: 5, data: b64url('Hej ✓') } },
                                    { mimeType: 'text/html', filename: '', body: { size: 12, data: b64url('<p>Hej ✓</p>') } }
                                ]
                            },
                            { mimeType: 'application/pdf', filename: 'report.pdf', body: { size: 2048, attachmentId: 'att-1' } }
                        ]
                    }
                });
            case 'GET /users/me/messages/m1/attachments/att-1':
                return json({ size: 3, data: b64url('PDF') });
            case 'GET /users/me/labels':
                return json({
                    labels: [
                        { id: 'Label_2', name: 'Receipts', type: 'user' },
                        { id: 'INBOX', name: 'INBOX', type: 'system' },
                        { id: 'Label_1', name: 'Projects', type: 'user' }
                    ]
                });
            case 'POST /users/me/messages/m1/modify':
                return json({ id: 'm1', threadId: 't1', labelIds: ['INBOX', ...(JSON.parse(body).addLabelIds ?? [])] });
            case 'POST /users/me/messages/m1/trash':
                return json({ id: 'm1', threadId: 't1', labelIds: ['TRASH'] });
            case 'POST /users/me/messages/gone/trash':
                return json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
        }
        return json({ error: { message: `no route ${request.method} ${path}` } }, 404);
    };
    return { http, seen };
}

async function setup() {
    const stub = gmailStub();
    const conduit = createConduit<CatalogOf<Connectors>>({
        sources: connectorCatalog({ include: ['gmail'] }),
        secret: SECRET,
        http: stub.http,
        redirectUri: REDIRECT,
        clients: { gmail: { id: 'client.apps.googleusercontent.com', secret: 'gcs' } }
    });
    const begun = await conduit.auth.begin({ connector: 'gmail', method: 'oauth', owner: 'u1' });
    if (begun.type !== 'redirect') throw new Error('expected a redirect');
    const { account } = await conduit.auth.complete({ params: { state: begun.state, code: 'auth-code' } });
    return { conduit, seen: stub.seen, account: account.id, authorizeUrl: new URL(begun.url) };
}

/** Decode the MIME message of the last send/draft request. */
function lastRaw(seen: Seen[]): string {
    const last = [...seen].reverse().find((s) => s.method === 'POST' && /\/(send|drafts)$/.test(s.url.pathname))!;
    const body = JSON.parse(last.body);
    return Buffer.from(body.raw ?? body.message.raw, 'base64url').toString();
}

const header = (raw: string, name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(raw.split('\r\n\r\n')[0]!)?.[1];

describe('Gmail: connecting', () => {
    it('asks Google for offline access with PKCE and identifies the mailbox', async () => {
        const { conduit, account, authorizeUrl } = await setup();
        expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
            client_id: 'client.apps.googleusercontent.com',
            scope: 'https://www.googleapis.com/auth/gmail.modify',
            access_type: 'offline',
            prompt: 'consent',
            code_challenge_method: 'S256',
            redirect_uri: REDIRECT
        });
        expect(await conduit.accounts.get(account)).toMatchObject({ externalId: 'ada@example.com', displayName: 'ada@example.com' });
    });
});

describe('Gmail: sending', () => {
    it('refuses a message without recipients before calling Google', async () => {
        const { conduit, account, seen } = await setup();
        const before = seen.length;
        const err = await conduit.execute({ connector: 'gmail', operation: 'send-email', account, inputs: { subject: 'x', body: 'y' } }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitValidationError);
        expect((err as ConduitValidationError).issues).toEqual([{ path: 'inputs.to', code: 'rule', message: 'Add at least one recipient', params: { fields: ['to', 'cc', 'bcc'] } }]);
        expect(seen.length).toBe(before);
    });

    it('sends a correctly built MIME message', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'gmail',
            operation: 'send-email',
            account,
            inputs: {
                to: ['Grace Hopper <grace@example.com>', 'linus@example.com'],
                bcc: ['audit@example.com'],
                subject: 'Möte på fredag',
                body: '<p>See <b>attached</b></p>',
                attachments: [{ filename: 'agenda.txt', contentType: 'text/plain', base64: Buffer.from('1. Budget').toString('base64') }]
            }
        });
        expectTypeOf(output).toEqualTypeOf<{ id: string; threadId: string; labelIds?: string[] }>();
        expect(output).toEqual({ id: 'm-sent', threadId: 't-new', labelIds: ['SENT'] });

        const raw = lastRaw(seen);
        expect(header(raw, 'To')).toBe('"Grace Hopper" <grace@example.com>, linus@example.com');
        expect(header(raw, 'Bcc')).toBe('audit@example.com');
        expect(header(raw, 'Subject')).toBe(`=?UTF-8?B?${Buffer.from('Möte på fredag').toString('base64')}?=`);
        expect(header(raw, 'Content-Type')).toMatch(/^multipart\/mixed; boundary="/);
        expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
        expect(raw).toContain(Buffer.from('<p>See <b>attached</b></p>').toString('base64'));
        expect(raw).toContain('Content-Disposition: attachment; filename="agenda.txt"');
        expect(raw).toContain(Buffer.from('1. Budget').toString('base64'));
    });

    it('sends plain text when asked, and threads into a conversation', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'gmail',
            operation: 'send-email',
            account,
            inputs: { to: ['a@example.com'], subject: 'Hi', body: 'plain words', format: 'text', threadId: 't9' }
        });
        expect(output).toMatchObject({ threadId: 't9' });
        const raw = lastRaw(seen);
        expect(header(raw, 'Content-Type')).toBe('text/plain; charset=UTF-8');
        expect(JSON.parse(seen.at(-1)!.body).threadId).toBe('t9');
    });

    it('turns a rejected recipient into an issue on the To field', async () => {
        const { conduit, account } = await setup();
        const err = await conduit.execute({ connector: 'gmail', operation: 'send-email', account, inputs: { to: ['bad@example.com'], subject: 's', body: 'b' } }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitRequestError);
        expect((err as ConduitRequestError).issues).toEqual([{ path: 'inputs.to', code: 'remote', message: 'One of the To addresses is not valid' }]);
    });

    it('creates drafts', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'gmail', operation: 'create-draft', account, inputs: { to: ['a@example.com'], subject: 'Draft', body: 'wip' } });
        expect(output).toEqual({ draftId: 'd1', messageId: 'm-draft', threadId: 't-draft' });
        expect(header(lastRaw(seen), 'Subject')).toBe('Draft');
    });

    it('replies with threading headers, to Reply-To/From, and everyone on reply-all', async () => {
        const { conduit, account, seen } = await setup();
        await conduit.execute({ connector: 'gmail', operation: 'reply-to-message', account, inputs: { messageId: 'orig', body: 'Thanks!', replyAll: true } });
        const lookup = seen.find((s) => s.url.pathname.endsWith('/messages/orig'))!;
        expect(lookup.url.searchParams.getAll('metadataHeaders')).toContain('Message-ID');

        const send = seen.at(-1)!;
        expect(JSON.parse(send.body).threadId).toBe('t-orig');
        const raw = lastRaw(seen);
        expect(header(raw, 'To')).toBe('"Grace" <grace@example.com>');
        expect(header(raw, 'Cc')).toBe('ada@example.com, linus@example.com');
        expect(header(raw, 'Subject')).toBe('Re: Quarterly numbers');
        expect(header(raw, 'In-Reply-To')).toBe('<orig@mail.example>');
        expect(header(raw, 'References')).toBe('<root@mail.example> <orig@mail.example>');
    });
});

describe('Gmail: reading', () => {
    it('searches across pages with pageToken', async () => {
        const { conduit, account, seen } = await setup();
        const { output, pages } = await conduit.execute({
            connector: 'gmail',
            operation: 'search-messages',
            account,
            inputs: { query: 'is:unread', labelIds: ['INBOX', 'Label_1'] }
        });
        expect(pages).toBe(2);
        expect(output).toEqual([
            { id: 'a', threadId: 'ta' },
            { id: 'b', threadId: 'tb' },
            { id: 'c', threadId: 'tc' }
        ]);
        const calls = seen.filter((s) => s.url.pathname.endsWith('/users/me/messages'));
        expect(calls[0]!.url.searchParams.get('q')).toBe('is:unread');
        expect(calls[0]!.url.searchParams.getAll('labelIds')).toEqual(['INBOX', 'Label_1']);
        expect(calls[1]!.url.searchParams.get('pageToken')).toBe('p2');
    });

    it('maps a full message: headers, decoded bodies, attachments', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({ connector: 'gmail', operation: 'get-message', account, inputs: { id: 'm1' } });
        expect(output).toEqual({
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'Hello there',
            receivedAt: '2026-01-01T00:00:00.000Z',
            from: 'Grace <grace@example.com>',
            to: 'ada@example.com',
            subject: 'Hello',
            messageId: '<m1@mail.example>',
            text: 'Hej ✓',
            html: '<p>Hej ✓</p>',
            attachments: [{ attachmentId: 'att-1', filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }]
        });
    });

    it('downloads an attachment as a file value', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({
            connector: 'gmail',
            operation: 'get-attachment',
            account,
            inputs: { messageId: 'm1', attachmentId: 'att-1', filename: 'report.pdf', contentType: 'application/pdf' }
        });
        expect(output).toEqual({ filename: 'report.pdf', contentType: 'application/pdf', base64: b64url('PDF'), size: 3 });
    });
});

describe('Gmail: labels and trash', () => {
    it('offers labels, system labels first, filtered by the search text', async () => {
        const { conduit, account } = await setup();
        expect(await conduit.options({ connector: 'gmail', operation: 'list-labels', account })).toEqual([
            { label: 'INBOX', value: 'INBOX', system: true },
            { label: 'Projects', value: 'Label_1', system: false },
            { label: 'Receipts', value: 'Label_2', system: false }
        ]);
        expect(await conduit.options({ connector: 'gmail', operation: 'list-labels', account, inputs: { query: 'rec' } })).toEqual([
            { label: 'Receipts', value: 'Label_2', system: false }
        ]);
    });

    it('adds and removes labels, and requires at least one change', async () => {
        const { conduit, account, seen } = await setup();
        await expect(conduit.execute({ connector: 'gmail', operation: 'modify-labels', account, inputs: { messageId: 'm1' } })).rejects.toBeInstanceOf(
            ConduitValidationError
        );
        const { output } = await conduit.execute({ connector: 'gmail', operation: 'modify-labels', account, inputs: { messageId: 'm1', add: ['Label_1'], remove: ['UNREAD'] } });
        expect(output).toMatchObject({ labelIds: ['INBOX', 'Label_1'] });
        expect(JSON.parse(seen.at(-1)!.body)).toEqual({ addLabelIds: ['Label_1'], removeLabelIds: ['UNREAD'] });
    });

    it('trashes messages, marked destructive for UIs', async () => {
        const { conduit, account } = await setup();
        expect((await conduit.connectors.describe('gmail')).operations.find((o) => o.id === 'trash-message')).toMatchObject({ kind: 'action', group: 'Messages', destructive: true });
        expect((await conduit.connectors.get('gmail')).operations.find((o) => o.id === 'trash-message')).toMatchObject({ destructive: true });
        const { output } = await conduit.execute({ connector: 'gmail', operation: 'trash-message', account, inputs: { id: 'm1' } });
        expect(output).toMatchObject({ labelIds: ['TRASH'] });
        const err = await conduit.execute({ connector: 'gmail', operation: 'trash-message', account, inputs: { id: 'gone' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.id', code: 'remote' }] });
    });
});

describe('Gmail: read and write intent', () => {
    it('marks exactly the pure reads readOnly, and none of them destructive', async () => {
        const { conduit } = await setup();
        const ops = (await conduit.connectors.get('gmail')).operations;
        expect(ops.filter((o) => o.readOnly).map((o) => o.id)).toEqual([
            'search-messages',
            'get-message',
            'get-thread',
            'get-attachment',
            'list-labels',
            'new-email'
        ]);
        expect(ops.filter((o) => o.readOnly && o.destructive)).toEqual([]);
        const described = (await conduit.connectors.describe('gmail')).operations;
        expect(described.filter((o) => o.readOnly).map((o) => o.id)).toEqual(ops.filter((o) => o.readOnly).map((o) => o.id));
    });
});

describe('Gmail: forms and typing', () => {
    it('describes a composable send form', async () => {
        const { conduit } = await setup();
        const form = await conduit.connectors.form('gmail', { operation: 'send-email' });
        expect(form.groups.map((g) => [g.name ?? '(default)', g.advanced, g.fields.map((f) => `${f.name}:${f.widget}`)])).toEqual([
            ['(default)', true, ['threadId:text']],
            ['Recipients', false, ['to:emails']],
            ['Recipients', true, ['cc:emails', 'bcc:emails', 'replyTo:emails']],
            ['Message', false, ['subject:text', 'body:richtext']],
            ['Message', true, ['format:select', 'from:email']],
            ['Attachments', false, ['attachments:file']]
        ]);
        const labels = (await conduit.connectors.form('gmail', { operation: 'modify-labels' })).groups[0]!.fields.find((f) => f.name === 'add')!;
        expect(labels).toMatchObject({ widget: 'multiselect', options: { operation: 'list-labels', search: 'query' } });
    });

    it('types every operation through the catalog', async () => {
        const { conduit, account } = await setup();
        // @ts-expect-error — not a Gmail operation
        void (() => conduit.execute({ connector: 'gmail', operation: 'delete-everything', account }));
        // @ts-expect-error — subject is required
        void (() => conduit.execute({ connector: 'gmail', operation: 'create-draft', account, inputs: { body: 'x' } }));
        // @ts-expect-error — format is 'html' | 'text'
        void (() => conduit.execute({ connector: 'gmail', operation: 'send-email', account, inputs: { subject: 's', body: 'b', format: 'pdf' } }));
    });
});
