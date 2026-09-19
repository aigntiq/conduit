/**
 * `createNodeHandler` — mounts Conduit's HTTP surface on Node's `http`
 * server, Express, Connect, or Fastify (via `@fastify/middie`):
 *
 *     app.use(createNodeHandler(conduit, { resolveOwner: (req) => ... }));
 *
 * It is a thin bridge over `createFetchHandler`: requests Conduit does not
 * serve fall through to `next()`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Conduit } from '../runtime/conduit';
import { createFetchHandler, type FetchHandlerOptions } from '../server';

export interface NodeHandlerOptions extends Omit<FetchHandlerOptions, 'resolveOwner'> {
    /** Who is calling — read your session from the Node request. */
    resolveOwner: (req: IncomingMessage, request: Request) => string | undefined | Promise<string | undefined>;
    /**
     * Trust `X-Forwarded-Proto` / `X-Forwarded-Host` when rebuilding the
     * request URL. Enable only behind a proxy you control. Default false.
     */
    trustProxy?: boolean;
}

export type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => void;

function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value?.split(',')[0]?.trim();
}

/** Build a WinterCG `Request` from a Node request. Handles bodies already consumed by a parser. */
export function toRequest(req: IncomingMessage & { body?: unknown; originalUrl?: string }, trustProxy = false): Request {
    const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
    const proto = (trustProxy && first(req.headers['x-forwarded-proto'])) || (encrypted ? 'https' : 'http');
    const host = (trustProxy && first(req.headers['x-forwarded-host'])) || req.headers.host || 'localhost';
    // Express rewrites req.url under a mount path; originalUrl keeps it whole.
    const url = new URL(req.originalUrl ?? req.url ?? '/', `${proto}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
        else headers.set(key, value);
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const init: RequestInit & { duplex?: 'half' } = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
        if (req.body !== undefined && (req.readableEnded || req.complete)) {
            // A body parser got there first: re-serialize what it produced.
            const body = req.body;
            init.body = typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body);
            headers.delete('content-length');
        } else {
            init.body = Readable.toWeb(req) as unknown as ReadableStream;
            init.duplex = 'half';
        }
    }
    return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (!response.body) {
        res.end();
        return;
    }
    res.end(Buffer.from(await response.arrayBuffer()));
}

export function createNodeHandler(conduit: Conduit, options: NodeHandlerOptions): NodeRequestHandler {
    const owners = new WeakMap<Request, IncomingMessage>();
    const handler = createFetchHandler(conduit, {
        ...options,
        resolveOwner: (request) => options.resolveOwner(owners.get(request)!, request)
    });

    return (req, res, next) => {
        const request = toRequest(req, options.trustProxy);
        owners.set(request, req);
        handler
            .route(request)
            .then(async (response) => {
                if (!response) {
                    if (next) next();
                    else {
                        res.writeHead(404, { 'content-type': 'application/json' });
                        res.end('{"error":{"code":"not_found","message":"no such route"}}');
                    }
                    return;
                }
                await writeResponse(res, response);
            })
            .catch((error: unknown) => {
                if (next) next(error);
                else {
                    res.writeHead(500);
                    res.end();
                }
            });
    };
}
