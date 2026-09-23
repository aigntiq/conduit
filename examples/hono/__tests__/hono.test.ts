import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConduit, type Conduit } from '@aigntiq/conduit';
import { fileSource } from '@aigntiq/conduit/node';
import { mockProvider, type MockProvider } from '@aigntiq/conduit/testing';
import { createApp } from '../src/app';

const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'conduit', 'test', 'fixtures', 'connectors');
const APP = 'https://app.example';

let provider: MockProvider;
let conduit: Conduit;
let app: ReturnType<typeof createApp>;

// No server needed: Hono apps are fetch handlers.
const call = (path: string, init: { user?: string; json?: unknown; method?: string } = {}) =>
    app.fetch(
        new Request(`${APP}${path}`, {
            method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
            headers: { ...(init.user ? { 'x-demo-user': init.user } : {}), ...(init.json === undefined ? {} : { 'content-type': 'application/json' }) },
            body: init.json === undefined ? undefined : JSON.stringify(init.json)
        })
    );

beforeAll(async () => {
    provider = await mockProvider();
    conduit = createConduit({
        sources: fileSource(FIXTURES),
        secret: 'an-example-secret-that-is-long-enough-for-conduit',
        redirectUri: `${APP}/conduit/auth/callback`,
        clients: { 'acme-crm': { id: provider.clientId, secret: provider.clientSecret } },
        config: { 'acme-crm': { baseUrl: provider.url, authUrl: provider.url }, weather: { baseUrl: `${provider.url}/weather` } }
    });
    app = createApp(conduit);
});

afterAll(async () => {
    conduit.close();
    await provider.close();
});

describe('Conduit in Hono', () => {
    it('runs the OAuth round trip and executes over HTTP', async () => {
        const start = (await (await call('/conduit/auth/acme-crm/oauth/start', { user: 'ada', json: {} })).json()) as { url: string };
        const callbackUrl = await provider.approve(start.url);

        // Without a returnTo the callback answers with a popup-friendly page.
        const page = await app.fetch(new Request(callbackUrl));
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toMatch(/text\/html/);
        const html = await page.text();
        expect(html).toContain('"type":"conduit:auth"');
        const account = /"account":"(acc_[^"]+)"/.exec(html)![1]!;

        const res = await call('/conduit/execute', {
            user: 'ada',
            json: { connector: 'acme-crm', operation: 'list-contacts', account, paging: { mode: 'page' } }
        });
        const body = (await res.json()) as { output: unknown[]; next: string; trace?: unknown };
        expect(body.output).toHaveLength(2);
        expect(body.next).toBe('2');
        expect(body.trace).toBeUndefined();
    });

    it('maps failures to HTTP statuses', async () => {
        const noAccount = await call('/conduit/execute', { user: 'ada', json: { connector: 'acme-crm', operation: 'list-contacts' } });
        expect(noAccount.status).toBe(400);
        const unknown = await call('/conduit/connectors/nope', { user: 'ada' });
        expect(unknown.status).toBe(404);
        const wrongMethod = await call('/conduit/connectors', { user: 'ada', json: {} });
        expect(wrongMethod.status).toBe(405);
        const invalid = await call('/conduit/execute', { user: 'ada', json: { connector: 'weather', operation: 'forecast', account: 'x', inputs: {} } });
        expect(invalid.status).toBe(404);
    });

    it('shows a failed callback without leaking details into a redirect', async () => {
        const res = await app.fetch(new Request(`${APP}/conduit/auth/callback?state=forged.sig&code=x`));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('Connection failed');
    });

    it('serves the form model a UI renders from, and the auth form', async () => {
        const form = (await (await call('/conduit/connectors/acme-crm/forms/create-contact', { user: 'ada' })).json()) as {
            groups: { fields: { name: string; widget: string; options?: unknown }[] }[];
        };
        expect(form.groups[0]!.fields.map((f) => [f.name, f.widget])).toEqual([
            ['email', 'email'],
            ['firstName', 'text'],
            ['lastName', 'text'],
            ['ownerId', 'select'],
            ['tags', 'list']
        ]);
        const auth = (await (await call('/conduit/connectors/acme-crm/auth/key/form', { user: 'ada' })).json()) as { groups: { fields: { name: string; widget: string }[] }[] };
        expect(auth.groups[0]!.fields.map((f) => [f.name, f.widget])).toEqual([
            ['apiKey', 'password'],
            ['region', 'select']
        ]);
    });

    it('leaves other routes to the app', async () => {
        expect(await (await app.fetch(new Request(`${APP}/`))).text()).toBe('ok');
    });
});
