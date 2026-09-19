/**
 * `@sigx/conduit/oauth` — standalone OAuth 2.0 helpers. The runtime uses
 * these; hosts can too, without the rest of Conduit.
 */
import { fromBase64, fromUtf8, randomBytes, timingSafeEqual, toBase64Url, utf8 } from '../util/bytes';
import { digest } from '../util/crypto';

type Bytes = Uint8Array<ArrayBuffer>;
const bs = (b: Uint8Array): Bytes => b as Bytes;

/** A random URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
    return toBase64Url(randomBytes(bytes));
}

export interface Pkce {
    verifier: string;
    challenge: string;
    method: 'S256';
}

/** RFC 7636 PKCE pair (S256). */
export async function createPkce(): Promise<Pkce> {
    const verifier = randomToken(48);
    return { verifier, challenge: await pkceChallenge(verifier), method: 'S256' };
}

export async function pkceChallenge(verifier: string): Promise<string> {
    return toBase64Url(await digest('SHA-256', verifier));
}

async function hmacKey(secret: string | CryptoKey): Promise<CryptoKey> {
    if (typeof secret !== 'string') return secret;
    return crypto.subtle.importKey('raw', bs(utf8(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Seal a payload into a tamper-proof, expiring `state` value:
 * `base64url(json).base64url(hmac-sha256)`. Not encrypted — do not put
 * secrets in it.
 */
export async function sealState(payload: Record<string, unknown>, secret: string | CryptoKey, options: { ttlMs: number; now?: number }): Promise<string> {
    const body = toBase64Url(utf8(JSON.stringify({ ...payload, exp: (options.now ?? Date.now()) + options.ttlMs })));
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), bs(utf8(body))));
    return `${body}.${toBase64Url(sig)}`;
}

/** Verify and decode a sealed state. Throws on a bad signature, bad shape or expiry. */
export async function openState<T extends Record<string, unknown>>(state: string, secret: string | CryptoKey, options: { now?: number } = {}): Promise<T> {
    const dot = state.indexOf('.');
    if (dot <= 0 || dot !== state.lastIndexOf('.')) throw new Error('malformed state');
    const body = state.slice(0, dot);
    let given: Uint8Array;
    try {
        given = fromBase64(state.slice(dot + 1));
    } catch {
        throw new Error('malformed state');
    }
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), bs(utf8(body))));
    if (!timingSafeEqual(given, expected)) throw new Error('state signature mismatch');
    const payload = JSON.parse(fromUtf8(fromBase64(body))) as T & { exp?: number };
    if (typeof payload.exp !== 'number' || payload.exp <= (options.now ?? Date.now())) throw new Error('state expired');
    return payload;
}

/** Append parameters to a URL, dropping null/undefined values; existing params are kept. */
export function buildUrl(base: string, params: Record<string, unknown>): string {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
    }
    return url.toString();
}

/**
 * Parse a token endpoint response body. Most providers answer JSON; some
 * answer `application/x-www-form-urlencoded`. Returns an object either way.
 */
export function parseTokenResponse(body: unknown, contentType = ''): Record<string, unknown> {
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
    if (typeof body === 'string') {
        const text = body.trim();
        if (text.startsWith('{')) {
            try {
                return JSON.parse(text) as Record<string, unknown>;
            } catch {
                // fall through
            }
        }
        if (contentType.includes('x-www-form-urlencoded') || /^[\w.-]+=/.test(text)) {
            return Object.fromEntries(new URLSearchParams(text));
        }
    }
    return {};
}

/** Read the callback parameters from a full redirect URL. */
export function callbackParams(callbackUrl: string): Record<string, string> {
    const url = new URL(callbackUrl);
    const params = Object.fromEntries(url.searchParams);
    // Some providers return the result in the fragment.
    if (url.hash.length > 1) Object.assign(params, Object.fromEntries(new URLSearchParams(url.hash.slice(1))));
    return params;
}
