import type { ResponseType } from '../spec/types';

/** A fully read response, as templates see it (`response.*`). */
export interface ResponseView {
    status: number;
    ok: boolean;
    /** Lower-cased names. Repeated headers are joined with ", ". */
    headers: Record<string, string>;
    body: unknown;
    url: string;
}

const JSON_TYPE = /[/+]json\b/i;
const TEXT_TYPE = /^text\/|[/+]xml\b|x-www-form-urlencoded/i;

export async function readResponse(response: Response, type: ResponseType, method: string): Promise<ResponseView> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
    });
    const view = { status: response.status, ok: response.ok, headers, url: response.url };

    if (method === 'HEAD' || response.status === 204 || response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        return { ...view, body: undefined };
    }

    if (type === 'binary') return { ...view, body: new Uint8Array(await response.arrayBuffer()) };
    const contentType = headers['content-type'] ?? '';
    if (type === 'auto' && contentType && !JSON_TYPE.test(contentType) && !TEXT_TYPE.test(contentType)) {
        return { ...view, body: new Uint8Array(await response.arrayBuffer()) };
    }

    const text = await response.text();
    if (type === 'text') return { ...view, body: text };
    if (text === '') return { ...view, body: undefined };
    if (type === 'json' || JSON_TYPE.test(contentType) || (!contentType && /^\s*[[{"]/.test(text))) {
        try {
            return { ...view, body: JSON.parse(text) };
        } catch {
            // A JSON content type with a non-JSON body (an HTML error page, say): keep the text.
            return { ...view, body: text };
        }
    }
    return { ...view, body: text };
}

/** Parse `Retry-After` (seconds or an HTTP date) into milliseconds from now. */
export function retryAfterMs(headers: Record<string, string>, now: number): number | undefined {
    const value = headers['retry-after'];
    if (!value) return undefined;
    if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The `rel="next"` target of an RFC 8288 `Link` header. */
export function nextLink(headers: Record<string, string>): string | undefined {
    const link = headers['link'];
    if (!link) return undefined;
    for (const part of link.split(/,(?=\s*<)/)) {
        const m = /<([^>]+)>\s*;(.*)/.exec(part.trim());
        if (m && /\brel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?/i.test(m[2]!)) return m[1];
    }
    return undefined;
}
