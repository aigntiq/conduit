/**
 * `mime({...})` — build an RFC 5322 email message.
 *
 * Several mail APIs accept a raw message (often base64url-encoded) rather
 * than JSON fields, so this lives in the standard library:
 *
 *     "raw": "{{ mime({to: inputs.to, subject: inputs.subject, html: inputs.body}) | base64url }}"
 *
 * The output is 7-bit ASCII with CRLF line endings:
 *  - non-ASCII header text is RFC 2047 encoded (`=?UTF-8?B?…?=`), including
 *    address display names; filenames use RFC 2231 (`filename*=UTF-8''…`);
 *  - bodies and attachments are base64, wrapped at 76 characters;
 *  - text + html become multipart/alternative; attachments wrap it all in
 *    multipart/mixed;
 *  - CR and LF are stripped from every header value, so an input cannot
 *    inject headers.
 */
import { fromBase64, randomBytes, toBase64, toHex, utf8 } from '../util/bytes';

export interface MimeAttachment {
    filename: string;
    contentType?: string;
    /** Standard or url-safe base64. */
    base64: string;
    /** Set for inline parts referenced by `cid:` from the html. */
    contentId?: string;
}

export interface MimeMessage {
    from?: string;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    attachments?: MimeAttachment[];
    inReplyTo?: string;
    references?: string | string[];
    messageId?: string;
    date?: string;
    /** Extra headers. */
    headers?: Record<string, string>;
}

const CRLF = '\r\n';
// oxlint-disable-next-line no-control-regex
const NON_ASCII = /[^\x20-\x7e]/;

function clean(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
}

function encodeWord(text: string): string {
    return NON_ASCII.test(text) ? `=?UTF-8?B?${toBase64(utf8(text))}?=` : text;
}

function encodeAddress(address: string): string {
    const a = clean(address);
    const m = /^(.*?)\s*<([^<>]+)>$/.exec(a);
    if (!m) return a;
    const name = m[1]!.replace(/^"(.*)"$/, '$1');
    if (!name) return `<${m[2]}>`;
    return NON_ASCII.test(name) ? `${encodeWord(name)} <${m[2]}>` : `"${name.replace(/["\\]/g, '\\$&')}" <${m[2]}>`;
}

function addressList(value: string | string[] | undefined): string | undefined {
    if (value === undefined || value === null) return undefined;
    const list = (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string' && v.trim() !== '');
    return list.length ? list.map(encodeAddress).join(', ') : undefined;
}

function wrap76(b64: string): string {
    return b64.replace(/.{1,76}/g, (line) => line + CRLF).trimEnd();
}

function encodedFilename(name: string): string {
    const safe = clean(name);
    if (!NON_ASCII.test(safe) && !/["\\]/.test(safe)) return `filename="${safe}"`;
    return `filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function boundary(): string {
    return `=_conduit_${toHex(randomBytes(12))}`;
}

function part(headers: string[], body: string): string {
    return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

function textPart(type: 'plain' | 'html', content: string): string {
    return part([`Content-Type: text/${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64'], wrap76(toBase64(utf8(content))));
}

function multipart(kind: 'alternative' | 'mixed' | 'related', parts: string[]): { header: string; body: string } {
    const b = boundary();
    const body = parts.map((p) => `--${b}${CRLF}${p}`).join(CRLF) + `${CRLF}--${b}--`;
    return { header: `multipart/${kind}; boundary="${b}"`, body };
}

export function buildMime(message: MimeMessage): string {
    const m = message ?? {};
    const headers: string[] = [];
    const add = (name: string, value: string | undefined) => {
        if (value !== undefined && value !== '') headers.push(`${name}: ${value}`);
    };
    add('From', addressList(m.from));
    add('To', addressList(m.to));
    add('Cc', addressList(m.cc));
    add('Bcc', addressList(m.bcc));
    add('Reply-To', addressList(m.replyTo));
    add('Subject', m.subject === undefined ? undefined : encodeWord(clean(String(m.subject))));
    add('Date', m.date === undefined ? undefined : clean(m.date));
    add('Message-ID', m.messageId === undefined ? undefined : clean(m.messageId));
    add('In-Reply-To', m.inReplyTo === undefined ? undefined : clean(m.inReplyTo));
    const refs = m.references === undefined ? undefined : (Array.isArray(m.references) ? m.references : [m.references]).map(clean).filter(Boolean).join(' ');
    add('References', refs || undefined);
    for (const [name, value] of Object.entries(m.headers ?? {})) {
        if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`invalid header name "${name}"`);
        add(name, encodeWord(clean(String(value))));
    }
    headers.push('MIME-Version: 1.0');

    const text = typeof m.text === 'string' ? m.text : undefined;
    const html = typeof m.html === 'string' ? m.html : undefined;

    // The body entity: text, html, or both as multipart/alternative.
    let entity: { headers: string[]; content: string };
    if (text !== undefined && html !== undefined) {
        const alt = multipart('alternative', [textPart('plain', text), textPart('html', html)]);
        entity = { headers: [`Content-Type: ${alt.header}`], content: alt.body };
    } else {
        const type = html !== undefined ? 'html' : 'plain';
        entity = {
            headers: [`Content-Type: text/${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64'],
            content: wrap76(toBase64(utf8(html ?? text ?? '')))
        };
    }

    const attachments = (m.attachments ?? []).filter((a) => a && typeof a.base64 === 'string');
    if (!attachments.length) return [...headers, ...entity.headers, '', entity.content].join(CRLF);

    const files = attachments.map((a) => {
        const name = a.filename || 'attachment';
        const type = clean(a.contentType || 'application/octet-stream');
        const h = [
            `Content-Type: ${type}; name="${clean(name).replace(/"/g, '')}"`,
            `Content-Disposition: ${a.contentId ? 'inline' : 'attachment'}; ${encodedFilename(name)}`,
            'Content-Transfer-Encoding: base64'
        ];
        if (a.contentId) h.push(`Content-ID: <${clean(a.contentId).replace(/[<>]/g, '')}>`);
        return part(h, wrap76(toBase64(fromBase64(a.base64))));
    });
    const mixed = multipart('mixed', [part(entity.headers, entity.content), ...files]);
    return [...headers, `Content-Type: ${mixed.header}`, '', mixed.body].join(CRLF);
}

/**
 * Depth-first list of a tree's nodes (the root included), following
 * `childrenKey`. For walking nested MIME parts and similar structures.
 */
export function flattenTree(root: unknown, childrenKey = 'parts', limit = 10_000): unknown[] {
    const out: unknown[] = [];
    const visit = (node: unknown, depth: number) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
        if (out.length >= limit || depth > 50) throw new Error('tree is too large or too deep');
        out.push(node);
        const children = (node as Record<string, unknown>)[childrenKey];
        if (Array.isArray(children)) for (const child of children) visit(child, depth + 1);
    };
    if (Array.isArray(root)) root.forEach((n) => visit(n, 0));
    else visit(root, 0);
    return out;
}
