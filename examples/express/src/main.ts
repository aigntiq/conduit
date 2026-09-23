/**
 * Run: CONDUIT_SECRET=… ACME_CLIENT_ID=… ACME_CLIENT_SECRET=… pnpm --filter conduit-example-express dev
 */
import { join } from 'node:path';
import { createConduit } from '@aigntiq/conduit';
import { fileSource } from '@aigntiq/conduit/node';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const secret = process.env.CONDUIT_SECRET;
if (!secret) throw new Error('set CONDUIT_SECRET to a random string of at least 32 characters');

const conduit = createConduit({
    // The fixture connectors from the package's tests: fictional APIs.
    sources: fileSource(join(import.meta.dirname, '..', '..', '..', 'packages', 'conduit', 'test', 'fixtures', 'connectors'), { watch: true }),
    secret,
    redirectUri: `http://localhost:${port}/conduit/auth/callback`,
    clients: { 'acme-crm': { id: process.env.ACME_CLIENT_ID ?? '', secret: process.env.ACME_CLIENT_SECRET } }
});

createApp(conduit).listen(port, () => {
    console.log(`listening on http://localhost:${port} — try GET /conduit/connectors with an x-demo-user header`);
});
