import { join } from 'node:path';
import { createConduit, memoryAccounts, type AccountStore, type Conduit, type ConduitOptions } from '@aigntiq/conduit';
import { fileSource } from '@aigntiq/conduit/node';
import { mockProvider, type MockProvider } from '@aigntiq/conduit/test/mock-provider';

export const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'connectors');
export const SECRET = 'test-secret-that-is-at-least-32-characters-long';
export const REDIRECT = 'https://app.example/conduit/auth/callback';

export interface Harness {
    provider: MockProvider;
    conduit: Conduit;
    accounts: AccountStore;
    clock: { now: number };
    /** Run the full OAuth redirect round-trip and return the new account id. */
    connectOAuth(owner?: string): Promise<string>;
    close(): Promise<void>;
}

export async function harness(overrides: Partial<ConduitOptions> = {}, providerOptions: Parameters<typeof mockProvider>[0] = {}): Promise<Harness> {
    const provider = await mockProvider(providerOptions);
    const accounts = memoryAccounts();
    const clock = { now: Date.UTC(2026, 8, 19, 12, 0, 0) };
    const conduit = createConduit({
        sources: fileSource(FIXTURES),
        secret: SECRET,
        accounts,
        redirectUri: REDIRECT,
        clients: { 'acme-crm': { id: provider.clientId, secret: provider.clientSecret } },
        config: {
            'acme-crm': { baseUrl: provider.url, authUrl: provider.url },
            weather: { baseUrl: `${provider.url}/weather` }
        },
        now: () => clock.now,
        ...overrides
    });
    return {
        provider,
        conduit,
        accounts,
        clock,
        async connectOAuth(owner = 'user-1') {
            const begun = await conduit.auth.begin({ connector: 'acme-crm', method: 'oauth', owner, returnTo: '/settings' });
            if (begun.type !== 'redirect') throw new Error('expected a redirect');
            const callback = await provider.approve(begun.url);
            const { account } = await conduit.auth.complete({ callbackUrl: callback });
            return account.id;
        },
        async close() {
            conduit.close();
            await provider.close();
        }
    };
}
