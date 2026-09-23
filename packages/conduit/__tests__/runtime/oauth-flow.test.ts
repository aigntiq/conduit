import { afterEach, describe, expect, it } from 'vitest';
import { ConduitAuthError } from '@aigntiq/conduit';
import { harness, REDIRECT, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
    await h?.close();
});

describe('the OAuth authorization-code round trip', () => {
    it('redirects with PKCE, exchanges the code, identifies the account and seals the tokens', async () => {
        h = await harness();
        const begun = await h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'user-1', returnTo: '/settings' });
        expect(begun.type).toBe('redirect');
        if (begun.type !== 'redirect') return;

        const url = new URL(begun.url);
        expect(url.origin + url.pathname).toBe(`${h.provider.url}/oauth/authorize`);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            response_type: 'code',
            client_id: h.provider.clientId,
            redirect_uri: REDIRECT,
            scope: 'contacts:read contacts:write offline_access',
            code_challenge_method: 'S256',
            prompt: 'consent',
            state: begun.state
        });

        const { account, returnTo } = await h.conduit.auth.complete({ callbackUrl: await h.provider.approve(begun.url) });
        expect(returnTo).toBe('/settings');
        expect(account).toMatchObject({
            owner: 'user-1',
            connector: 'acme-crm',
            method: 'oauth',
            status: 'active',
            externalId: 'u-oauth',
            displayName: 'u-oauth@acme.example',
            data: { region: 'eu' }
        });
        expect(account).not.toHaveProperty('credentials');
        expect(h.provider.grants.authorization_code).toBe(1);

        // The token request carried the PKCE verifier (the mock verifies it).
        const tokenCall = h.provider.requests.find((r) => r.path === '/oauth/token')!;
        expect(new URLSearchParams(tokenCall.body).get('code_verifier')).toMatch(/^[\w-]{43,}$/);

        // At rest the credentials are sealed: no token appears in the store.
        const stored = (await h.accounts.get(account.id))!;
        expect(stored.credentials).toMatch(/^v1\./);
        const issued = h.provider.requests.filter((r) => r.path.startsWith('/v2/')).map((r) => r.headers.authorization);
        for (const header of issued) expect(stored.credentials).not.toContain(header!.slice(7));
    });

    it('refuses a replayed callback', async () => {
        h = await harness();
        const begun = await h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'u' });
        if (begun.type !== 'redirect') throw new Error();
        const callback = await h.provider.approve(begun.url);
        await h.conduit.auth.complete({ callbackUrl: callback });
        await expect(h.conduit.auth.complete({ callbackUrl: callback })).rejects.toThrow(/already used or has expired/);
    });

    it('refuses a tampered or expired state', async () => {
        h = await harness();
        const begun = await h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'u' });
        if (begun.type !== 'redirect') throw new Error();
        const sig = begun.state.split('.')[1];
        const forged = `${Buffer.from(JSON.stringify({ n: 'x', c: 'acme-crm', m: 'oauth', o: 'attacker', exp: 9e15 })).toString('base64url')}.${sig}`;
        await expect(h.conduit.auth.complete({ params: { state: forged, code: 'c' } })).rejects.toThrow(/signature mismatch/);

        h.clock.now += 11 * 60_000;
        await expect(h.conduit.auth.complete({ params: { state: begun.state, code: 'c' } })).rejects.toThrow(/state expired/);
    });

    it('reports a denied consent', async () => {
        h = await harness();
        const begun = await h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'u' });
        if (begun.type !== 'redirect') throw new Error();
        const err = await h.conduit.auth
            .complete({ params: { state: begun.state, error: 'access_denied', error_description: 'user said no' } })
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitAuthError);
        expect((err as Error).message).toMatch(/access_denied — user said no/);
    });

    it('updates the same account when the same external account connects again, or on reconnect', async () => {
        h = await harness();
        const first = await h.connectOAuth('user-1');
        const second = await h.connectOAuth('user-1');
        expect(second).toBe(first);
        expect(await h.conduit.accounts.list({ owner: 'user-1' })).toHaveLength(1);

        const begun = await h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'user-1', account: first });
        if (begun.type !== 'redirect') throw new Error();
        const { account } = await h.conduit.auth.complete({ callbackUrl: await h.provider.approve(begun.url) });
        expect(account.id).toBe(first);

        // A different owner gets their own account.
        expect(await h.connectOAuth('user-2')).not.toBe(first);
    });

    it('needs an OAuth client and a redirect URI', async () => {
        h = await harness({ clients: undefined });
        await expect(h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'u' })).rejects.toThrow(/no OAuth client/);
        await h.close();
        h = await harness({ redirectUri: undefined });
        await expect(h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'u' })).rejects.toThrow(/no redirectUri/);
    });

    it('revokes at the provider and deletes the account', async () => {
        h = await harness();
        const id = await h.connectOAuth();
        await h.conduit.auth.revoke(id);
        expect(h.provider.grants.revoke).toBe(1);
        expect(await h.conduit.accounts.get(id)).toBeUndefined();
    });
});

describe('token lifecycle', () => {
    it('refreshes early, exactly once, under concurrent calls', async () => {
        h = await harness({}, { expiresIn: 3600 });
        const id = await h.connectOAuth();
        // Within the 60 s skew of expiry: every call wants a refresh.
        h.clock.now += 3600_000 - 30_000;
        const results = await Promise.all(
            Array.from({ length: 20 }, () => h.conduit.execute({ connector: 'acme-crm', operation: 'list-owners', account: id }))
        );
        expect(results).toHaveLength(20);
        expect(h.provider.grants.refresh_token).toBe(1);
        const info = (await h.conduit.accounts.get(id))!;
        expect(info.expiresAt).toBe(h.clock.now + 3600_000);
    });

    it('recovers from a 401 with one forced refresh and a replay', async () => {
        h = await harness();
        const id = await h.connectOAuth();
        h.provider.expireAccessTokens();
        const { output, trace } = await h.conduit.execute({ connector: 'acme-crm', operation: 'list-owners', account: id });
        expect(output).toEqual([
            { label: 'Grace', value: 'u1' },
            { label: 'Linus', value: 'u2' }
        ]);
        expect(h.provider.grants.refresh_token).toBe(1);
        expect(trace.map((t) => [t.label, t.status, t.outcome])).toEqual([
            ['request', 401, 'refresh'],
            ['refresh', 200, 'ok'],
            ['request', 200, 'ok']
        ]);
    });

    it('marks the account for reconnection when the refresh is refused', async () => {
        h = await harness();
        const id = await h.connectOAuth();
        h.provider.revokeAll();
        const err = await h.conduit.execute({ connector: 'acme-crm', operation: 'list-owners', account: id }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitAuthError);
        expect((err as ConduitAuthError).needsReauth).toBe(true);
        expect((await h.conduit.accounts.get(id))?.status).toBe('needsReauth');
        await expect(h.conduit.execute({ connector: 'acme-crm', operation: 'list-owners', account: id })).rejects.toThrow(/needs to be reconnected/);

        // Reconnecting reactivates it.
        const begun = await h.conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner: 'user-1', account: id });
        if (begun.type !== 'redirect') throw new Error();
        await h.conduit.auth.complete({ callbackUrl: await h.provider.approve(begun.url) });
        expect((await h.conduit.accounts.get(id))?.status).toBe('active');
    });

    it('refreshes on demand', async () => {
        h = await harness();
        const id = await h.connectOAuth();
        await h.conduit.auth.refresh(id);
        expect(h.provider.grants.refresh_token).toBe(1);
        expect(await h.conduit.auth.test(id)).toEqual({ ok: true });
    });
});
