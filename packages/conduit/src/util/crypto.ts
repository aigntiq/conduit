/**
 * WebCrypto-backed primitives: digests, HMAC, and JWT signing.
 *
 * Everything here is async because `crypto.subtle` is — which is why the
 * expression evaluator is async end to end.
 */
import { concatBytes, fromBase64, toBase64Url, utf8 } from './bytes';

// WebCrypto's BufferSource typing is stricter than Uint8Array under recent
// lib.dom; every call site passes a fresh, non-shared Uint8Array.
type Bytes = Uint8Array<ArrayBuffer>;
const bs = (b: Uint8Array): Bytes => b as Bytes;

export type DigestAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

const toBytes = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? utf8(data) : data);

export async function digest(algorithm: DigestAlgorithm, data: string | Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest(algorithm, bs(toBytes(data))));
}

export async function hmac(
    algorithm: DigestAlgorithm,
    key: string | Uint8Array,
    data: string | Uint8Array
): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        bs(toBytes(key)),
        { name: 'HMAC', hash: algorithm },
        false,
        ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, bs(toBytes(data))));
}

export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384';

export const JWT_ALGORITHMS: readonly JwtAlgorithm[] = [
    'HS256',
    'HS384',
    'HS512',
    'RS256',
    'RS384',
    'RS512',
    'ES256',
    'ES384'
];

const HASH_FOR: Record<string, DigestAlgorithm> = { '256': 'SHA-256', '384': 'SHA-384', '512': 'SHA-512' };

/**
 * Sign a compact JWS. `key` is the shared secret for `HS*`, or a PEM private
 * key for `RS*`/`ES*` (PKCS#8 `BEGIN PRIVATE KEY`, or PKCS#1
 * `BEGIN RSA PRIVATE KEY` — the format many providers hand out).
 */
export async function signJwt(
    claims: Record<string, unknown>,
    key: string,
    algorithm: JwtAlgorithm = 'RS256',
    header: Record<string, unknown> = {}
): Promise<string> {
    if (!JWT_ALGORITHMS.includes(algorithm)) throw new Error(`unsupported JWT algorithm "${algorithm}"`);
    const head = toBase64Url(utf8(JSON.stringify({ alg: algorithm, typ: 'JWT', ...header })));
    const body = toBase64Url(utf8(JSON.stringify(claims)));
    const signingInput = `${head}.${body}`;
    const hash = HASH_FOR[algorithm.slice(2)]!;

    let signature: Uint8Array;
    if (algorithm.startsWith('HS')) {
        signature = await hmac(hash, key, signingInput);
    } else if (algorithm.startsWith('RS')) {
        const cryptoKey = await crypto.subtle.importKey(
            'pkcs8',
            bs(pemToPkcs8(key, 'rsa')),
            { name: 'RSASSA-PKCS1-v1_5', hash },
            false,
            ['sign']
        );
        signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, bs(utf8(signingInput))));
    } else {
        const namedCurve = algorithm === 'ES256' ? 'P-256' : 'P-384';
        const cryptoKey = await crypto.subtle.importKey(
            'pkcs8',
            bs(pemToPkcs8(key, 'ec')),
            { name: 'ECDSA', namedCurve },
            false,
            ['sign']
        );
        // WebCrypto emits ECDSA signatures as raw r||s, which is exactly JWS.
        signature = new Uint8Array(
            await crypto.subtle.sign({ name: 'ECDSA', hash }, cryptoKey, bs(utf8(signingInput)))
        );
    }
    return `${signingInput}.${toBase64Url(signature)}`;
}

/** Decode a PEM private key to PKCS#8 DER, wrapping PKCS#1 RSA keys on the way. */
export function pemToPkcs8(pem: string, kind: 'rsa' | 'ec'): Uint8Array {
    const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem.replace(/\\n/g, '\n'));
    if (!match) throw new Error('key is not a PEM block');
    const label = match[1]!;
    const der = fromBase64(match[2]!);
    if (label === 'PRIVATE KEY') return der;
    if (label === 'RSA PRIVATE KEY' && kind === 'rsa') return wrapPkcs1(der);
    throw new Error(`unsupported PEM key type "${label}" — use a PKCS#8 "PRIVATE KEY"`);
}

// PKCS#8 PrivateKeyInfo around a PKCS#1 RSAPrivateKey:
//   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { key } }
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
]);
const VERSION_ZERO = new Uint8Array([0x02, 0x01, 0x00]);

function derLength(length: number): Uint8Array {
    if (length < 0x80) return new Uint8Array([length]);
    const bytes: number[] = [];
    for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Uint8Array): Uint8Array {
    return concatBytes(new Uint8Array([tag]), derLength(content.length), content);
}

function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
    return derTag(0x30, concatBytes(VERSION_ZERO, RSA_ALGORITHM_IDENTIFIER, derTag(0x04, pkcs1)));
}
