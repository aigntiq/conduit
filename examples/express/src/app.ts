/**
 * Conduit in an Express app.
 *
 *  - `/conduit/*` is Conduit's HTTP surface (connect accounts, OAuth
 *    callback, dynamic options) — mounted with `createNodeHandler`.
 *  - `/contacts` shows the other half: your own route calling
 *    `conduit.execute` server-side.
 *
 * Identity is the host's job. This demo reads the user from an
 * `x-demo-user` header; a real app reads its session instead.
 */
import express, { type Request } from 'express';
import { isConduitError, type Conduit } from '@aigntiq/conduit';
import { createNodeHandler } from '@aigntiq/conduit/node';

const currentUser = (req: Request | import('node:http').IncomingMessage): string | undefined => {
    const user = req.headers['x-demo-user'];
    return typeof user === 'string' && user ? user : undefined;
};

export function createApp(conduit: Conduit): express.Express {
    const app = express();
    // A body parser in front of Conduit is fine: the handler re-reads what it parsed.
    app.use(express.json());

    app.use(
        createNodeHandler(conduit, {
            basePath: '/conduit',
            resolveOwner: (req) => currentUser(req)
        })
    );

    app.get('/contacts', async (req, res) => {
        const owner = currentUser(req);
        if (!owner) return void res.status(401).json({ error: 'sign in first' });
        const [account] = await conduit.accounts.list({ owner, connector: 'acme-crm' });
        if (!account) return void res.status(404).json({ error: 'connect Acme first' });
        try {
            const { output } = await conduit.execute({ connector: 'acme-crm', operation: 'list-contacts', account: account.id, owner });
            res.json({ contacts: output });
        } catch (e) {
            res.status(502).json({ error: isConduitError(e) ? e.code : 'failed' });
        }
    });

    app.get('/done', (req, res) => {
        res.type('text').send(`connected ${String(req.query.conduit_account ?? '')}`);
    });

    return app;
}
