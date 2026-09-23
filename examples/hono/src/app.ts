/**
 * Conduit in a Hono app. `createFetchHandler` is a plain
 * `Request → Response` function, so it mounts on any fetch-style router —
 * and this file runs unchanged on Node, Bun, Deno or Cloudflare Workers
 * (bring a durable `AccountStore`/`TransientStore` there).
 */
import { Hono } from 'hono';
import type { Conduit } from '@aigntiq/conduit';
import { createFetchHandler } from '@aigntiq/conduit/server';

export function createApp(conduit: Conduit): Hono {
    const app = new Hono();

    const conduitHandler = createFetchHandler(conduit, {
        basePath: '/conduit',
        // Demo identity. A real app reads its session (cookie, JWT, …) here.
        resolveOwner: (request) => request.headers.get('x-demo-user') ?? undefined,
        exposeExecute: true
    });
    app.all('/conduit/*', (c) => conduitHandler(c.req.raw));

    app.get('/', (c) => c.text('ok'));
    return app;
}
