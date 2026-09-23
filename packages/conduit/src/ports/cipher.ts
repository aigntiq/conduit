/**
 * `webCryptoCipher` — AES-256-GCM over WebCrypto, keyed from a secret string
 * through HKDF-SHA256. Output: `v1.<base64url(iv ‖ ciphertext+tag)>`.
 *
 * The `v1.` prefix leaves room to rotate the format; `keyId` lets several
 * keys coexist during a rotation (`previous` keys still open old values).
 */
import { concatBytes, fromBase64, fromUtf8, randomBytes, toBase64Url, utf8 } from '../util/bytes';
import type { SecretCipher } from './types';

type Bytes = Uint8Array<ArrayBuffer>;
const bs = (b: Uint8Array): Bytes => b as Bytes;

/** Derive an AES-GCM key (or HMAC key) from a secret with HKDF, bound to a purpose label. */
export async function deriveKey(secret: string, purpose: string, usage: 'aes' | 'hmac'): Promise<CryptoKey> {
    if (secret.length < 32) throw new Error('secret must be at least 32 characters');
    const material = await crypto.subtle.importKey('raw', bs(utf8(secret)), 'HKDF', false, ['deriveKey']);
    const params = { name: 'HKDF', hash: 'SHA-256', salt: bs(utf8('aigntiq-conduit')), info: bs(utf8(purpose)) };
    return usage === 'aes'
        ? crypto.subtle.deriveKey(params, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        : crypto.subtle.deriveKey(params, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

export interface WebCryptoCipherOptions {
    /** Older secrets that can still OPEN values sealed before a rotation. */
    previous?: string[];
}

export function webCryptoCipher(secret: string, options: WebCryptoCipherOptions = {}): SecretCipher {
    const current = deriveKey(secret, 'credentials/v1', 'aes');
    const all = [current, ...(options.previous ?? []).map((s) => deriveKey(s, 'credentials/v1', 'aes'))];
    // Surface a short secret on first use rather than as an unhandled rejection.
    all.forEach((p) => p.catch(() => undefined));

    return {
        async seal(plaintext) {
            const iv = randomBytes(12);
            const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, await current, bs(utf8(plaintext))));
            return `v1.${toBase64Url(concatBytes(iv, data))}`;
        },
        async open(sealed) {
            if (!sealed.startsWith('v1.')) throw new Error('unrecognised sealed value');
            const bytes = fromBase64(sealed.slice(3));
            const iv = bytes.subarray(0, 12);
            const data = bytes.subarray(12);
            for (const keyPromise of all) {
                try {
                    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv) }, await keyPromise, bs(data));
                    return fromUtf8(new Uint8Array(plain));
                } catch {
                    // wrong key — try the next
                }
            }
            throw new Error('sealed value could not be opened with any configured key');
        }
    };
}
