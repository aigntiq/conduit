/**
 * What every Microsoft 365 connector shares: sign-in through the Microsoft
 * identity platform, Microsoft Graph paging, and Graph change notifications
 * as a webhook trigger. Each connector is still its own grant.
 *
 * Not a connector — `_shared` has no `index.ts`, so the generator and the
 * build skip it.
 */
import { $, auth, email, expr, paging, string, type AuthScope, type Ref } from '@aigntiq/conduit/builder';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

type OAuth2Def = Exclude<Parameters<typeof auth.oauth2>[1], (scope: AuthScope) => unknown>;

/** The per-connector part of a Microsoft sign-in. */
export type MicrosoftOAuthDef = Pick<OAuth2Def, 'helpUrl' | 'setup'> & {
    /** Microsoft Graph permissions (delegated), e.g. `Mail.Send`. */
    scopes: string[];
};

/**
 * `Sign in with Microsoft`, as the `oauth` auth method. The tenant comes from
 * `config.tenant` — `common` (work, school and personal accounts),
 * `organizations`, `consumers`, or a tenant id or domain.
 */
export function microsoftOAuth(def: MicrosoftOAuthDef) {
    return auth.oauth2('oauth', ({ config, response }) => ({
        label: 'Sign in with Microsoft',
        authorizeUrl: $`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/authorize`,
        tokenUrl: $`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`,
        // Full resource URLs: a v2 token is for one resource, and a bare
        // "Mail.Send" would be read as Graph's anyway. offline_access yields
        // the refresh token; User.Read lets identity read /me.
        scopes: ['offline_access', 'https://graph.microsoft.com/User.Read', ...def.scopes.map((s) => `https://graph.microsoft.com/${s}`)],
        authorizeParams: { prompt: 'select_account' },
        identity: {
            request: { url: `${GRAPH}/me`, query: { $select: 'id,displayName,mail,userPrincipalName' } },
            // The object id is stable; a mailbox address can change.
            id: response.body.id,
            name: expr`default(${response.body.mail}, ${response.body.userPrincipalName})`
        },
        test: { url: `${GRAPH}/me`, query: { $select: 'id' } },
        helpUrl: def.helpUrl,
        setup: def.setup
    }));
}

/**
 * Graph's user segment for the account: `me` when a user signed in, and
 * `users/<mailbox>` for an app account. Spread into a connector's `functions`.
 */
export const graphFunctions = {
    graphUser: {
        params: ['account'],
        description: 'The Graph user segment: me (a signed-in user) or users/<mailbox> (an app account).',
        body: "account.method == 'app' ? 'users/' + urlEncode(account.data.mailbox) : 'me'"
    }
};

/** `/me` or `/users/<mailbox>`, as template text to start a request URL with. */
export const ME = '/{{graphUser(account)}}';

/** The per-connector part of an app-only sign-in. */
export interface MicrosoftAppDef {
    /** A cheap read inside the mailbox that proves access, after `/users/<mailbox>` — e.g. `/mailFolders/inbox`. */
    test: string;
    helpUrl?: string;
    setup: string;
}

/**
 * `Microsoft 365 app`, as the `app` auth method: OAuth client credentials,
 * no signed-in user. The account names its tenant and the one mailbox it acts
 * on; the app's Graph *application* permissions (admin-consented) decide what
 * it may do there.
 */
export function microsoftApp(def: MicrosoftAppDef) {
    return auth.oauth2('app', ({ inputs }) => ({
        label: 'Microsoft 365 app (no signed-in user)',
        grant: 'client_credentials',
        tokenUrl: $`https://login.microsoftonline.com/${inputs.tenantId}/oauth2/v2.0/token`,
        // Client credentials take the app's consented permissions as one scope.
        tokenParams: { scope: 'https://graph.microsoft.com/.default' },
        inputs: {
            tenantId: string({ title: 'Tenant', description: 'The directory (tenant) id, or a verified domain such as contoso.onmicrosoft.com.' }),
            mailbox: email({ title: 'Mailbox', description: 'The one mailbox this account acts on, e.g. shared@contoso.com.' })
        },
        // Named by the mailbox: reading the user object would need a directory permission.
        identity: {
            id: expr`lower(${inputs.mailbox})`,
            name: expr`lower(${inputs.mailbox})`,
            data: { mailbox: expr`lower(${inputs.mailbox})`, tenantId: inputs.tenantId }
        },
        test: { url: $`${GRAPH}/users/${expr`urlEncode(lower(${inputs.mailbox}))`}${def.test}` },
        helpUrl: def.helpUrl,
        setup: def.setup
    }));
}

/** Graph throttles with 429 and Retry-After (which Conduit honours); 503/504 are transient. */
export const graphRetry = { attempts: 3, initialDelayMs: 500, maxDelayMs: 30_000 };

/** Graph's paging: follow `@odata.nextLink` until there is none. */
export function graphPaging(response: Ref, maxPages = 20) {
    return paging.nextUrl({ items: response.body.value, next: response.body['@odata.nextLink'], maxPages });
}

/** The setup steps for the app-only (`app`) method: application permissions, admin consent, a scoped mailbox. */
export function microsoftAppSetup(id: string, scopes: readonly string[]): string {
    const list = scopes.map((s) => `\`${s}\``).join(', ');
    const key = /^[a-z_$][\w$]*$/i.test(id) ? id : `'${id}'`;
    return [
        '1. In the Microsoft Entra admin center, open **App registrations** and create (or reuse) a registration, with a **client secret** under **Certificates & secrets**.',
        `2. Under **API permissions**, add the Microsoft Graph *application* permissions ${list}, then **Grant admin consent**.`,
        '3. Application permissions reach every mailbox in the tenant. Limit the app to the mailboxes it should use, with RBAC for Applications in Exchange Online.',
        `4. Give the client id and secret to Conduit (\`createConduit({ clients: { ${key}: { id, secret } } })\`), and connect an account with method \`app\` and inputs \`{ tenantId, mailbox }\`.`
    ].join('\n');
}

/** The standard setup steps for a Microsoft 365 connector. `notes` follow after a blank line. */
export function microsoftSetup(id: string, scopes: readonly string[], notes: readonly string[] = []): string {
    const list = ['offline_access', 'User.Read', ...scopes].map((s) => `\`${s}\``).join(', ');
    const key = /^[a-z_$][\w$]*$/i.test(id) ? id : `'${id}'`;
    return [
        '1. In the Microsoft Entra admin center, open **App registrations** and create a **New registration**. Choose who may sign in (any organization and personal accounts suit `tenant: common`).',
        '2. Under **Authentication**, add a **Web** platform with your Conduit callback URL (for example `https://app.example/conduit/auth/callback`) as a redirect URI.',
        '3. Under **Certificates & secrets**, create a **client secret**.',
        `4. Under **API permissions**, add the Microsoft Graph *delegated* permissions ${list}.`,
        `5. Give the application (client) id and secret to Conduit: \`createConduit({ clients: { ${key}: { id, secret } } })\`. To limit sign-in to one organization, set \`config: { ${key}: { tenant: '<tenant id or domain>' } }\`.`,
        ...(notes.length ? ['', ...notes] : [])
    ].join('\n');
}

export interface GraphSubscriptionDef {
    /** The Graph resource to watch, e.g. `me/mailFolders('inbox')/messages`, built from the trigger's scope (start it with `graphUser(account)`). */
    resource: (scope: AuthScope) => unknown;
    /** `created`, `updated`, `deleted`, or a comma-separated mix. */
    changeType: string;
    /** How long a subscription lives; Graph caps it per resource (mail and events: 10 080 minutes). */
    lifetimeMinutes: number;
    /** Renew this often — well inside the lifetime. */
    renewEveryMinutes: number;
}

/**
 * A webhook trigger over Graph change notifications: subscribe, renew and
 * unsubscribe `/subscriptions`, echo the `validationToken` handshake, and
 * accept only notifications carrying this subscription's `clientState`.
 * Each event is `{ id, changeType, subscriptionId }` — Graph sends which item
 * changed, not the item.
 */
export function graphSubscription(def: GraphSubscriptionDef) {
    return (scope: AuthScope & { request: Ref; subscription: Ref }) => {
        const { subscription, request, response } = scope;
        return {
            subscribe: {
                method: 'POST' as const,
                url: `${GRAPH}/subscriptions`,
                body: {
                    changeType: def.changeType,
                    notificationUrl: subscription.callbackUrl,
                    resource: def.resource(scope),
                    expirationDateTime: expr`addTime(now(), ${def.lifetimeMinutes}, 'm')`,
                    clientState: subscription.secret
                },
                output: { id: response.body.id }
            },
            renew: {
                everyMinutes: def.renewEveryMinutes,
                request: {
                    method: 'PATCH' as const,
                    url: $`${GRAPH}/subscriptions/${expr`urlEncode(${subscription.data.id})`}`,
                    body: { expirationDateTime: expr`addTime(now(), ${def.lifetimeMinutes}, 'm')` }
                }
            },
            unsubscribe: { method: 'DELETE' as const, url: $`${GRAPH}/subscriptions/${expr`urlEncode(${subscription.data.id})`}` },
            // Graph proves the URL by POSTing ?validationToken=… and expects it back as text.
            handshake: {
                when: expr`${request.query.validationToken} != undefined`,
                respond: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: request.query.validationToken }
            },
            verify: {
                type: 'custom' as const,
                valid: expr`!isEmpty(${request.body.value}) && every(${request.body.value}, n => n.clientState == ${subscription.secret})`
            },
            event: expr`map(${request.body.value}, n => {id: n.resourceData.id, changeType: n.changeType, subscriptionId: n.subscriptionId})`,
            dedupeKey: expr`map(${request.body.value}, n => n.changeType + ':' + n.resourceData.id) | join(',')`
        };
    };
}
