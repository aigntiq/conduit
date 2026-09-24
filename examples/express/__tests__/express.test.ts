import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConduit, type Conduit } from '@aigntiq/conduit';
import { fileSource } from '@aigntiq/conduit/node';
import { mockProvider, type MockProvider } from '@aigntiq/conduit/test/mock-provider';
import { createApp } from '../src/app';

const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'conduit', 'test', 'fixtures', 'connectors');

let provider: MockProvider;
let conduit: Conduit;
let server: Server;
let base: string;

const as = (user?: string, json?: unknown, method = json === undefined ? 'GET' : 'POST'): RequestInit => ({
    method,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
    body: json === undefined ? undefined : JSON.stringify(json),
    redirect: 'manual'
});

beforeAll(async () => {
    provider = await mockProvider();
    // Listen first: the redirect URI needs the port.
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    conduit = createConduit({
        sources: fileSource(FIXTURES),
        secret: 'an-example-secret-that-is-long-enough-for-conduit',
        redirectUri: `${base}/conduit/auth/callback`,
        clients: { 'acme-crm': { id: provider.clientId, secret: provider.clientSecret } },
        config: { 'acme-crm': { baseUrl: provider.url, authUrl: provider.url } }
    });
    server.on('request', createApp(conduit));
});

afterAll(async () => {
    conduit.close();
    await new Promise((r) => server.close(r));
    await provider.close();
});

describe('Conduit in Express', () => {
    let accountId: string;

    it('lists connectors for a signed-in user only', async () => {
        expect((await fetch(`${base}/conduit/connectors`, as())).status).toBe(401);
        const res = await fetch(`${base}/conduit/connectors`, as('ada'));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { connectors: { id: string }[] }).connectors.map((c) => c.id)).toEqual(['acme-crm', 'weather']);
    });

    it('connects an account through the full OAuth redirect', async () => {
        const start = await fetch(`${base}/conduit/auth/acme-crm/oauth/start`, as('ada', { returnTo: '/done' }));
        const { type, url } = (await start.json()) as { type: string; url: string };
        expect(type).toBe('redirect');

        const callback = await provider.approve(url);
        expect(callback.startsWith(`${base}/conduit/auth/callback?`)).toBe(true);
        const landed = await fetch(callback, { redirect: 'manual' });
        expect(landed.status).toBe(302);
        const location = landed.headers.get('location')!;
        expect(location).toMatch(/^\/done\?conduit_account=acc_/);
        accountId = new URLSearchParams(location.split('?')[1]).get('conduit_account')!;

        const accounts = (await (await fetch(`${base}/conduit/accounts`, as('ada'))).json()) as { accounts: { id: string }[] };
        expect(accounts.accounts.map((a) => a.id)).toEqual([accountId]);
    });

    it('also starts from a plain link', async () => {
        const res = await fetch(`${base}/conduit/auth/acme-crm/oauth/start?returnTo=https://evil.example/`, as('ada'));
        expect(res.status).toBe(302);
        const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
        // An absolute returnTo is dropped — never an open redirect.
        expect(JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString()).r).toBeUndefined();
    });

    it('serves dynamic options, scoped to the owner', async () => {
        const res = await fetch(`${base}/conduit/options/acme-crm/list-owners`, as('ada', { account: accountId }));
        expect(await res.json()).toEqual({ options: [{ label: 'Grace', value: 'u1' }, { label: 'Linus', value: 'u2' }] });
        const other = await fetch(`${base}/conduit/options/acme-crm/list-owners`, as('mallory', { account: accountId }));
        expect(other.status).toBe(404);
    });

    it('calls operations server-side from the host routes', async () => {
        const res = await fetch(`${base}/contacts`, as('ada'));
        expect(((await res.json()) as { contacts: unknown[] }).contacts).toHaveLength(5);
    });

    it('does not expose execute unless asked to', async () => {
        const res = await fetch(`${base}/conduit/execute`, as('ada', { connector: 'acme-crm', operation: 'list-contacts', account: accountId }));
        expect(res.status).toBe(404);
    });

    it('accepts only JSON bodies on state-changing routes', async () => {
        const res = await fetch(`${base}/conduit/accounts`, {
            method: 'POST',
            headers: { 'x-demo-user': 'ada', 'content-type': 'application/x-www-form-urlencoded' },
            body: 'connector=acme-crm&method=key'
        });
        expect(res.status).toBe(415);
    });

    it('connects API-key accounts and reports input errors', async () => {
        const bad = await fetch(`${base}/conduit/accounts`, as('bob', { connector: 'acme-crm', method: 'key', inputs: { apiKey: 'short' } }));
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: { issues: unknown[] } }).error.issues).toHaveLength(1);
        const ok = await fetch(`${base}/conduit/accounts`, as('bob', { connector: 'acme-crm', method: 'key', inputs: { apiKey: 'key-abcdefgh' } }));
        expect(ok.status).toBe(201);
    });

    it('revokes an account', async () => {
        expect((await fetch(`${base}/conduit/accounts/${accountId}`, as('mallory', undefined, 'DELETE'))).status).toBe(404);
        expect((await fetch(`${base}/conduit/accounts/${accountId}`, as('ada', undefined, 'DELETE'))).status).toBe(204);
        expect(provider.grants.revoke).toBe(1);
    });

    it('falls through to the app for paths Conduit does not serve', async () => {
        expect(await (await fetch(`${base}/done?conduit_account=x`)).text()).toBe('connected x');
    });
});
