import { afterEach, describe, expect, it } from 'vitest';
import {
    ConduitError,
    ConduitRateLimitError,
    ConduitRequestError,
    ConduitValidationError,
    createConduit,
    definePlugin,
    memorySource,
    type ConnectorSpec,
    type ExecuteEvent
} from '@aigntiq/conduit';
import { harness, SECRET, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
    await h?.close();
});

const acme = (h: Harness, account: string) => ({
    run: (operation: string, inputs?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        h.conduit.execute({ connector: 'acme-crm', operation, account, inputs, ...extra })
});

describe('operations', () => {
    it('maps inputs into the request and the response through connector functions', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        const { output } = await api.run('create-contact', { email: 'Ada@Lovelace.example', firstName: 'Ada', tags: ['vip'] });
        expect(output).toEqual({ id: 'c6', email: 'ada@lovelace.example', name: 'Ada', ownerId: undefined, createdAt: '2026-09-01T00:00:00.000Z' });

        const sent = h.provider.requests.find((r) => r.method === 'POST' && r.path === '/v2/contacts')!;
        // Inputs that were not given are dropped, not sent as null.
        expect(JSON.parse(sent.body)).toEqual({ email: 'Ada@Lovelace.example', first_name: 'Ada', tags: ['vip'] });
        expect(sent.headers['content-type']).toBe('application/json');
        expect(sent.headers['x-acme-region']).toBe('eu');
    });

    it('validates inputs before sending anything', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        const before = h.provider.requests.length;
        const err = await api.run('create-contact', { email: 'x' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitValidationError);
        expect((err as ConduitValidationError).issues).toEqual([{ path: 'inputs.email', code: 'minLength', params: { limit: 3 }, message: 'must be at least 3 characters' }]);
        expect(h.provider.requests.length).toBe(before);
    });

    it('runs steps only when their condition holds', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        expect((await api.run('get-contact', { id: 'c2' })).output).toMatchObject({ id: 'c2', ownerName: undefined });
        const { output, trace } = await api.run('get-contact', { id: 'c2', ownerId: 'u2' });
        expect(output).toMatchObject({ id: 'c2', ownerName: 'Linus' });
        expect(trace.map((t) => t.label)).toEqual(['step owner', 'request']);
    });

    it('follows cursor pagination across pages', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        const { output, pages } = await api.run('list-contacts');
        expect(pages).toBe(3);
        expect((output as { id: string }[]).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
        const listCalls = h.provider.requests.filter((r) => r.path === '/v2/contacts' && r.method === 'GET');
        expect(listCalls.map((r) => r.query)).toEqual([{ limit: '2' }, { limit: '2', cursor: '2' }, { limit: '2', cursor: '4' }]);
    });

    it('fetches one page at a time and resumes from the returned cursor', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        const first = await api.run('list-contacts', {}, { paging: { mode: 'page' } });
        expect((first.output as unknown[]).length).toBe(2);
        expect(first.next).toBe('2');
        const last = await api.run('list-contacts', {}, { paging: { mode: 'page', cursor: '4' } });
        expect((last.output as { id: string }[]).map((c) => c.id)).toEqual(['c5']);
        expect(last.next).toBeUndefined();
    });

    it('caps pagination at maxPages', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        const { pages, output } = await api.run('list-contacts', {}, { paging: { maxPages: 2 } });
        expect(pages).toBe(2);
        expect((output as unknown[]).length).toBe(4);
    });

    it('normalizes options', async () => {
        h = await harness();
        const account = await h.connectOAuth();
        expect(await h.conduit.options({ connector: 'acme-crm', operation: 'list-owners', account })).toEqual([
            { label: 'Grace', value: 'u1' },
            { label: 'Linus', value: 'u2' }
        ]);
        await expect(h.conduit.options({ connector: 'acme-crm', operation: 'get-contact', account })).rejects.toThrow(/not options/);
    });

    it('refuses to execute a trigger', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        await expect(api.run('contact-created')).rejects.toThrow(/triggers are delivered/);
    });
});

describe('error classification and retries', () => {
    it('applies operation rules, connector rules and defaults', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        const conflict = await api.run('create-contact', { email: 'person1@example.com' }).catch((e: unknown) => e);
        expect(conflict).toMatchObject({ kind: 'conflict', status: 409, message: 'A contact with person1@example.com already exists' });

        const soft = await api.run('create-contact', { email: 'x@soft-fail.example' }).catch((e: unknown) => e);
        expect(soft).toMatchObject({ kind: 'validation', status: 200, message: 'mailbox rejected' });

        const missing = await api.run('get-contact', { id: 'nope' }).catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(ConduitRequestError);
        expect(missing).toMatchObject({ kind: 'notFound', message: 'No contact nope', retryable: false });
    });

    it('retries rate limits honouring Retry-After, and transient failures', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        h.provider.failNext('/v2/owners', { status: 429, headers: { 'retry-after': '0' } });
        h.provider.failNext('/v2/owners', { status: 503 });
        const { trace } = await api.run('list-owners');
        expect(trace.map((t) => [t.status, t.outcome])).toEqual([
            [429, 'retry'],
            [503, 'retry'],
            [200, 'ok']
        ]);
    });

    it('gives up after the configured attempts', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        h.provider.failNext('/v2/owners', { status: 429, headers: { 'retry-after': '0' }, times: 5 });
        const err = await api.run('list-owners').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitRateLimitError);
        expect((err as ConduitRateLimitError).retryAfterMs).toBe(0);
        expect(h.provider.requests.filter((r) => r.path === '/v2/owners')).toHaveLength(3);
    });

    it('does not retry non-retryable failures', async () => {
        h = await harness();
        const api = acme(h, await h.connectOAuth());
        h.provider.failNext('/v2/owners', { status: 400, body: { message: 'bad things' } });
        await expect(api.run('list-owners')).rejects.toMatchObject({ kind: 'validation', message: 'request failed with status 400: bad things' });
        expect(h.provider.requests.filter((r) => r.path === '/v2/owners')).toHaveLength(1);
    });
});

describe('API keys, owners and auth-free operations', () => {
    it('connects with an API key after testing it, and never duplicates', async () => {
        h = await harness();
        const account = await h.conduit.auth.connect({ connector: 'acme-crm', method: 'key', owner: 'o', inputs: { apiKey: 'key-abcdefgh', region: 'us' } });
        expect(account).toMatchObject({ method: 'key', externalId: 'key-user', data: { region: 'us' } });
        expect((await acme(h, account.id).run('list-owners')).output).toHaveLength(2);
        const me = h.provider.requests.find((r) => r.path === '/v2/me')!;
        expect(me.headers.authorization).toBe('Token key-abcdefgh');

        await expect(
            h.conduit.auth.connect({ connector: 'acme-crm', method: 'key', owner: 'o', inputs: { apiKey: 'wrong-key-123' } })
        ).rejects.toMatchObject({ kind: 'auth' });
        await expect(h.conduit.auth.connect({ connector: 'acme-crm', method: 'key', owner: 'o', inputs: { apiKey: 'short' } })).rejects.toBeInstanceOf(ConduitValidationError);
        expect(await h.conduit.accounts.list({ owner: 'o' })).toHaveLength(1);
    });

    it('scopes accounts to their owner', async () => {
        h = await harness();
        const account = await h.connectOAuth('alice');
        await expect(h.conduit.execute({ connector: 'acme-crm', operation: 'list-owners', account, owner: 'mallory' })).rejects.toMatchObject({
            code: 'account_unknown'
        });
        expect(await h.conduit.accounts.get(account, 'mallory')).toBeUndefined();
        expect(await h.conduit.accounts.delete(account, 'mallory')).toBe(false);
    });

    it('requires an account where the operation needs one, and not where it does not', async () => {
        h = await harness();
        await expect(h.conduit.execute({ connector: 'acme-crm', operation: 'list-owners' })).rejects.toMatchObject({ code: 'account_required' });
        const { output } = await h.conduit.execute({ connector: 'weather', operation: 'status' });
        expect(output).toBe('all good');
    });

    it('puts query-string keys on the request and masks them in the trace', async () => {
        h = await harness();
        const account = await h.conduit.auth.connect({ connector: 'weather', method: 'key', owner: 'o', inputs: { apiKey: 'wx-key-123456' } });
        const { output, trace } = await h.conduit.execute({ connector: 'weather', operation: 'forecast', account: account.id, inputs: { city: 'Oslo', days: '2' } });
        expect(output).toEqual([
            { date: '2026-01-01', temp: 20 },
            { date: '2026-01-02', temp: 21 }
        ]);
        expect(trace[0]!.url).toContain('appid=***');
        expect(trace[0]!.url).not.toContain('wx-key-123456');
        expect(h.provider.requests.at(-1)!.query).toEqual({ q: 'Oslo', cnt: '2', units: 'metric', appid: 'wx-key-123456' });
    });

    it('rejects an account from another connector', async () => {
        h = await harness();
        const account = await h.connectOAuth();
        await expect(h.conduit.execute({ connector: 'weather', operation: 'forecast', account, inputs: { city: 'x' } })).rejects.toMatchObject({
            code: 'account_mismatch'
        });
    });
});

describe('the host guard', () => {
    const spec: ConnectorSpec = {
        spec: 'conduit/1',
        id: 'fetcher',
        name: 'Fetcher',
        version: '1.0.0',
        http: { baseUrl: 'https://api.fetcher.example' },
        operations: [
            {
                id: 'get',
                kind: 'action',
                label: 'Get',
                inputs: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
                request: { url: '{{inputs.url}}' }
            }
        ]
    };

    it('blocks requests to undeclared hosts before a socket opens', async () => {
        const calls: string[] = [];
        const conduit = createConduit({
            sources: memorySource([spec]),
            secret: SECRET,
            http: async (r) => {
                calls.push(r.url);
                return new Response('{}', { headers: { 'content-type': 'application/json' } });
            }
        });
        await expect(conduit.execute({ connector: 'fetcher', operation: 'get', inputs: { url: 'http://169.254.169.254/latest/meta-data' } })).rejects.toThrow(
            /not allowed by this connector/
        );
        await expect(conduit.execute({ connector: 'fetcher', operation: 'get', inputs: { url: 'file:///etc/passwd' } })).rejects.toThrow(/unsupported URL scheme/);
        await conduit.execute({ connector: 'fetcher', operation: 'get', inputs: { url: '/relative/ok' } });
        await conduit.execute({ connector: 'fetcher', operation: 'get', inputs: { url: 'https://api.fetcher.example/abs' } });
        expect(calls).toEqual(['https://api.fetcher.example/relative/ok', 'https://api.fetcher.example/abs']);
    });

    it('checks every redirect hop and strips credentials across origins', async () => {
        const seen: { url: string; auth: string | null }[] = [];
        const withAuth: ConnectorSpec = {
            ...spec,
            http: { ...spec.http, allowHosts: ['cdn.fetcher.example'] },
            auth: [{ id: 'token', type: 'bearer' }]
        };
        const conduit = createConduit({
            sources: memorySource([withAuth]),
            secret: SECRET,
            http: async (r) => {
                seen.push({ url: r.url, auth: r.headers.get('authorization') });
                if (r.url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: 'https://cdn.fetcher.example/file' } });
                if (r.url.endsWith('/evil')) return new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } });
                return new Response('"ok"', { headers: { 'content-type': 'application/json' } });
            }
        });
        const account = await conduit.auth.connect({ connector: 'fetcher', method: 'token', owner: 'o', inputs: { token: 'tok-secret' } });
        const { output } = await conduit.execute({ connector: 'fetcher', operation: 'get', account: account.id, inputs: { url: '/start' } });
        expect(output).toBe('ok');
        expect(seen).toEqual([
            { url: 'https://api.fetcher.example/start', auth: 'Bearer tok-secret' },
            { url: 'https://cdn.fetcher.example/file', auth: null }
        ]);
        await expect(conduit.execute({ connector: 'fetcher', operation: 'get', account: account.id, inputs: { url: '/evil' } })).rejects.toThrow(/not allowed/);
    });
});

describe('plugins', () => {
    it('adds functions, wraps requests and reports calls and account changes', async () => {
        const events: ExecuteEvent[] = [];
        const accountEvents: string[] = [];
        const plugin = definePlugin({
            name: 'test',
            setup(r) {
                r.addFunctions({ shout: { minArgs: 1, maxArgs: 1, call: ([v]) => `${String(v).toUpperCase()}!` } });
                r.useRequest(async (request, next, info) => {
                    const copy = new Request(request, { headers: new Headers(request.headers) });
                    copy.headers.set('x-purpose', info.purpose);
                    return next(copy);
                });
                r.onExecute((e) => events.push(e));
                r.onAccountChanged((e) => accountEvents.push(e.type));
            }
        });
        const spec: ConnectorSpec = {
            spec: 'conduit/1',
            id: 'echo',
            name: 'Echo',
            version: '1.0.0',
            http: { baseUrl: 'https://echo.example' },
            auth: [{ id: 'k', type: 'apiKey', name: 'X-Key' }],
            operations: [{ id: 'say', kind: 'action', label: 'Say', request: { method: 'POST', url: '/say', body: { text: '{{ shout(inputs.text) }}' } } }]
        };
        const conduit = createConduit({
            sources: memorySource([spec]),
            secret: SECRET,
            plugins: [plugin],
            http: async (r) =>
                new Response(JSON.stringify({ body: await r.json(), purpose: r.headers.get('x-purpose'), key: r.headers.get('x-key') }), {
                    headers: { 'content-type': 'application/json' }
                })
        });
        const account = await conduit.auth.connect({ connector: 'echo', method: 'k', owner: 'o', inputs: { apiKey: 'abc12345' } });
        const { output } = await conduit.execute({ connector: 'echo', operation: 'say', account: account.id, inputs: { text: 'hi' } });
        expect(output).toEqual({ body: { text: 'HI!' }, purpose: 'operation', key: 'abc12345' });
        expect(events).toEqual([expect.objectContaining({ connector: 'echo', operation: 'say', ok: true, account: account.id })]);
        await conduit.auth.revoke(account.id);
        expect(accountEvents).toEqual(['created', 'deleted']);
    });

    it('lets a plugin add a request encoding that connectors can use', async () => {
        const csv = definePlugin({
            name: 'csv',
            setup: (r) =>
                r.addEncoding('csv', (body, headers) => {
                    headers.set('content-type', 'text/csv');
                    return (body as unknown[][]).map((row) => row.join(',')).join('\n');
                })
        });
        const spec: ConnectorSpec = {
            spec: 'conduit/1',
            id: 'importer',
            name: 'Importer',
            version: '1.0.0',
            http: { baseUrl: 'https://import.example' },
            operations: [
                { id: 'upload', kind: 'action', label: 'Upload', request: { method: 'POST', url: '/rows', encoding: 'csv', body: '{{inputs.rows}}' } }
            ]
        };
        const conduit = createConduit({
            sources: memorySource([spec]),
            secret: SECRET,
            plugins: [csv],
            http: async (r) => Response.json({ type: r.headers.get('content-type'), body: await r.text() })
        });
        const { output } = await conduit.execute({ connector: 'importer', operation: 'upload', inputs: { rows: [['a', 1], ['b', 2]] } });
        expect(output).toEqual({ type: 'text/csv', body: 'a,1\nb,2' });
        // Without the plugin the connector does not validate.
        const plain = createConduit({ sources: memorySource([spec]), secret: SECRET });
        await expect(plain.connectors.get('importer')).rejects.toThrow(/no request encoding "csv"/);
    });

    it('rejects duplicate plugins and duplicate functions', () => {
        const p = definePlugin({ name: 'p', setup: (r) => r.addFunctions({ f: { call: () => 1 } }) });
        expect(() => createConduit({ sources: memorySource(), secret: SECRET, plugins: [p, p] })).toThrow(/installed twice/);
        const q = definePlugin({ name: 'q', setup: (r) => r.addFunctions({ f: { call: () => 2 } }) });
        expect(() => createConduit({ sources: memorySource(), secret: SECRET, plugins: [p, q] })).toThrow(/registered twice/);
    });
});

describe('catalog', () => {
    it('describes connectors for UIs and tool catalogs', async () => {
        h = await harness();
        const list = await h.conduit.connectors.list();
        expect(list.map((c) => c.id)).toEqual(['acme-crm', 'weather']);
        const acmeDescription = await h.conduit.connectors.describe('acme-crm');
        expect(acmeDescription.auth).toEqual([
            expect.objectContaining({ id: 'oauth', type: 'oauth2', redirect: true, inputs: { type: 'object', properties: {} } }),
            expect.objectContaining({ id: 'key', type: 'apiKey', redirect: false })
        ]);
        expect(acmeDescription.operations.find((o) => o.id === 'list-owners')).toMatchObject({ kind: 'options', hidden: true, auth: ['oauth', 'key'] });
        const weather = await h.conduit.connectors.describe('weather');
        expect(weather.operations.find((o) => o.id === 'status')).toMatchObject({ auth: false });
    });

    it('carries group, destructive and readOnly, and omits them when the spec does', async () => {
        const spec: ConnectorSpec = {
            spec: 'conduit/1',
            id: 'hints',
            name: 'Hints',
            version: '1.0.0',
            http: { baseUrl: 'https://hints.example' },
            operations: [
                { id: 'read', kind: 'action', label: 'Read', group: 'Items', readOnly: true, request: { url: '/items' } },
                { id: 'wipe', kind: 'action', label: 'Wipe', group: 'Items', destructive: true, readOnly: false, request: { method: 'DELETE', url: '/items' } },
                { id: 'plain', kind: 'action', label: 'Plain', request: { url: '/plain' } }
            ]
        };
        const conduit = createConduit({ sources: memorySource([spec]), secret: SECRET });
        const ops = (await conduit.connectors.describe('hints')).operations;
        expect(ops[0]).toMatchObject({ group: 'Items', readOnly: true });
        expect(ops[0]).not.toHaveProperty('destructive');
        expect(ops[1]).toMatchObject({ group: 'Items', destructive: true, readOnly: false });
        expect(ops[2]).not.toHaveProperty('group');
        expect(ops[2]).not.toHaveProperty('destructive');
        expect(ops[2]).not.toHaveProperty('readOnly');
    });

    it('hides invalid connectors from the list but reports them', async () => {
        const good: ConnectorSpec = { spec: 'conduit/1', id: 'good', name: 'Good', version: '1.0.0', operations: [] };
        const bad = { ...good, id: 'bad', name: 'Bad', operations: [{ id: 'x', kind: 'action', label: 'X', request: { url: '{{ nope( }}' } }] } as ConnectorSpec;
        const conduit = createConduit({ sources: memorySource([good, bad]), secret: SECRET });
        expect((await conduit.connectors.list()).map((c) => c.id)).toEqual(['good']);
        await expect(conduit.connectors.get('bad')).rejects.toThrow(/connector "bad" is invalid/);
        const diagnostics = await conduit.connectors.diagnostics();
        expect(diagnostics.good).toEqual([]);
        expect(diagnostics.bad?.[0]).toMatchObject({ code: 'expression_invalid', severity: 'error' });
        await expect(conduit.connectors.get('ghost')).rejects.toBeInstanceOf(ConduitError);
    });

    it('picks up changes from a watched source', async () => {
        const source = memorySource([{ spec: 'conduit/1', id: 'live', name: 'Before', version: '1.0.0', operations: [] }]);
        const conduit = createConduit({ sources: source, secret: SECRET });
        expect((await conduit.connectors.get('live')).name).toBe('Before');
        source.set({ spec: 'conduit/1', id: 'live', name: 'After', version: '1.0.1', operations: [] });
        expect((await conduit.connectors.get('live')).name).toBe('After');
    });
});
