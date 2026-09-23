import { describe, expect, it } from 'vitest';
import { evaluateExpression, standardRegistry } from '@aigntiq/conduit/expr';

const mime = async (message: Record<string, unknown>) => String(await evaluateExpression('mime(m)', { m: message }, { functions: standardRegistry }));

/** Split a message into its header block (unfolded) and body. */
function parse(raw: string) {
    const [head, ...rest] = raw.split('\r\n\r\n');
    const headers: Record<string, string> = {};
    for (const line of head!.split('\r\n')) {
        const i = line.indexOf(':');
        headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    return { headers, body: rest.join('\r\n\r\n') };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('mime()', () => {
    it('builds a plain single-part message', async () => {
        const raw = await mime({ from: 'Ada <ada@example.com>', to: ['b@example.com', 'C D <c@example.com>'], subject: 'Hello', text: 'Hi there' });
        const { headers, body } = parse(raw);
        expect(headers).toMatchObject({
            from: '"Ada" <ada@example.com>',
            to: 'b@example.com, "C D" <c@example.com>',
            subject: 'Hello',
            'mime-version': '1.0',
            'content-type': 'text/plain; charset=UTF-8',
            'content-transfer-encoding': 'base64'
        });
        expect(Buffer.from(body, 'base64').toString()).toBe('Hi there');
        expect(raw).not.toMatch(/[^\r]\n/);
    });

    it('encodes non-ASCII headers and display names (RFC 2047)', async () => {
        const { headers } = parse(await mime({ to: 'Åsa Öberg <asa@example.com>', subject: 'Möte på fredag 🎉', html: '<p>x</p>' }));
        expect(headers.subject).toBe(`=?UTF-8?B?${b64('Möte på fredag 🎉')}?=`);
        expect(headers.to).toBe(`=?UTF-8?B?${b64('Åsa Öberg')}?= <asa@example.com>`);
        expect(headers['content-type']).toBe('text/html; charset=UTF-8');
    });

    it('refuses header injection through any value', async () => {
        const raw = await mime({ to: 'a@example.com\r\nBcc: victim@example.com', subject: 'x\nX-Evil: 1', text: 'y', headers: { 'X-Tag': 'ok\r\nX-Other: 2' } });
        const lines = raw.split('\r\n\r\n')[0]!.split('\r\n');
        expect(lines.some((l) => /^(Bcc|X-Evil|X-Other):/i.test(l))).toBe(false);
        await expect(mime({ headers: { 'Bad Name': 'x' } })).rejects.toThrow(/invalid header name/);
    });

    it('nests text + html as alternative, inside mixed with attachments', async () => {
        const raw = await mime({
            to: 'a@example.com',
            subject: 'Report',
            text: 'plain',
            html: '<b>rich</b>',
            attachments: [{ filename: 'räkning.pdf', contentType: 'application/pdf', base64: b64('%PDF-1.7') }],
            inReplyTo: '<m1@example.com>',
            references: ['<m0@example.com>', '<m1@example.com>']
        });
        const { headers, body } = parse(raw);
        expect(headers['in-reply-to']).toBe('<m1@example.com>');
        expect(headers.references).toBe('<m0@example.com> <m1@example.com>');
        const outer = /boundary="([^"]+)"/.exec(headers['content-type']!)![1]!;
        expect(headers['content-type']).toMatch(/^multipart\/mixed;/);
        const parts = body.split(`--${outer}`).slice(1, -1);
        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatch(/Content-Type: multipart\/alternative; boundary="/);
        expect(parts[0]).toContain(b64('plain'));
        expect(parts[0]).toContain(b64('<b>rich</b>'));
        expect(parts[1]).toContain(`Content-Disposition: attachment; filename*=UTF-8''r%C3%A4kning.pdf`);
        expect(parts[1]).toContain(b64('%PDF-1.7'));
        expect(body.trimEnd().endsWith(`--${outer}--`)).toBe(true);
    });

    it('wraps base64 at 76 characters and accepts url-safe attachment data', async () => {
        const big = 'x'.repeat(500);
        const raw = await mime({ text: big, attachments: [{ filename: 'a.bin', base64: Buffer.from([251, 255, 254]).toString('base64url') }] });
        for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
        expect(raw.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]{77,}$/.test(l))).toEqual([]);
        expect(raw).toContain(Buffer.from([251, 255, 254]).toString('base64'));
    });

    it('pipes into base64url for raw-message APIs', async () => {
        const raw = String(await evaluateExpression("mime({to: 'a@example.com', text: 'x'}) | base64url", {}, { functions: standardRegistry }));
        expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(Buffer.from(raw, 'base64url').toString()).toMatch(/^To: a@example.com\r\n/);
    });
});

describe('flattenTree()', () => {
    it('lists every node depth first', async () => {
        const payload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain' }, { mimeType: 'text/html' }] }, { mimeType: 'application/pdf' }] };
        expect(await evaluateExpression("flattenTree(p) | map('mimeType')", { p: payload }, { functions: standardRegistry })).toEqual([
            'multipart/mixed',
            'multipart/alternative',
            'text/plain',
            'text/html',
            'application/pdf'
        ]);
        expect(await evaluateExpression("flattenTree(p, 'children') | length", { p: { children: [{}, { children: [{}] }] } }, { functions: standardRegistry })).toBe(4);
    });
});
