/**
 * What every Google connector shares: the OAuth endpoints, offline access and
 * the retry policy. Each connector is still its own grant with its own scopes.
 *
 * Not a connector — `_shared` has no `index.ts`, so the generator and the
 * build skip it.
 */
import { auth, type AuthScope } from '@aigntiq/conduit/builder';

type OAuth2Def = Exclude<Parameters<typeof auth.oauth2>[1], (scope: AuthScope) => unknown>;

/** The per-connector part of a Google sign-in. */
export type GoogleOAuthDef = Pick<OAuth2Def, 'scopes' | 'identity' | 'test' | 'helpUrl' | 'setup'>;

/** `Sign in with Google`, as the `oauth` auth method. */
export function googleOAuth(def: GoogleOAuthDef | ((scope: AuthScope) => GoogleOAuthDef)) {
    return auth.oauth2('oauth', (scope) => {
        const { scopes, identity, test, helpUrl, setup } = typeof def === 'function' ? def(scope) : def;
        return {
            label: 'Sign in with Google',
            authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            revokeUrl: 'https://oauth2.googleapis.com/revoke',
            scopes,
            // Offline access + consent every time: Google only returns a
            // refresh token on consent.
            authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
            identity,
            test,
            helpUrl,
            setup
        };
    });
}

/** Google's APIs rate-limit with 429/503; back off generously. */
export const googleRetry = { attempts: 3, initialDelayMs: 500, maxDelayMs: 20_000 };

/**
 * The standard setup steps for a Google connector: enable the API, add the
 * scopes, create a web OAuth client and hand it to Conduit. `notes` follow
 * after a blank line.
 */
export function googleSetup(api: string, id: string, scopes: readonly string[], notes: readonly string[] = []): string {
    const list = scopes.map((s) => `\`${s}\``).join(', ');
    // `google-drive` needs quotes as an object key; `gmail` doesn't.
    const key = /^[a-z_$][\w$]*$/i.test(id) ? id : `'${id}'`;
    return [
        `1. In the Google Cloud console, create (or pick) a project and **enable the ${api}**.`,
        `2. Configure the **OAuth consent screen** and add the scope${scopes.length > 1 ? 's' : ''} ${list}.`,
        '3. Create an **OAuth client ID** of type *Web application*. Add your Conduit callback URL (for example `https://app.example/conduit/auth/callback`) as an **authorized redirect URI**.',
        `4. Give the client id and secret to Conduit: \`createConduit({ clients: { ${key}: { id, secret } } })\`.`,
        ...(notes.length ? ['', ...notes] : [])
    ].join('\n');
}
