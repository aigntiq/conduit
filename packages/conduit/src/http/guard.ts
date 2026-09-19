/**
 * The host guard: requests may only reach hosts the connector declared.
 *
 * Without it, any template that lands in a URL — `"url": "{{inputs.link}}"`,
 * a `nextUrl` from a response, a redirect — could point the runtime at
 * internal addresses (cloud metadata, admin ports). Allowed hosts are the
 * rendered `baseUrl` host, the connector's auth endpoint hosts,
 * `http.allowHosts`, and the host's own `allowHosts`.
 */
import { ConduitRequestError } from '../errors';

export class HostGuard {
    private readonly exact = new Set<string>();
    private readonly suffixes: string[] = [];
    private open = false;

    constructor(patterns: Iterable<string> = []) {
        for (const p of patterns) this.allow(p);
    }

    /** `api.example.com`, `*.example.com`, a URL (its host is taken), or `*` (anything). */
    allow(pattern: string): this {
        let p = pattern.trim().toLowerCase();
        if (!p) return this;
        if (p === '*') {
            this.open = true;
            return this;
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//.test(p)) {
            try {
                p = new URL(p).host;
            } catch {
                return this;
            }
        }
        if (p.startsWith('*.')) this.suffixes.push(p.slice(1));
        else this.exact.add(p);
        return this;
    }

    allows(url: URL): boolean {
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
        if (this.open) return true;
        const host = url.host.toLowerCase();
        const hostname = url.hostname.toLowerCase();
        if (this.exact.has(host) || this.exact.has(hostname)) return true;
        return this.suffixes.some((s) => hostname.endsWith(s));
    }

    check(url: URL): void {
        if (!this.allows(url)) {
            throw new ConduitRequestError('fatal', `request to ${url.protocol}//${url.host} is not allowed by this connector`, {
                retryable: false
            });
        }
    }

    /** A copy with more patterns. */
    with(patterns: Iterable<string>): HostGuard {
        const next = new HostGuard();
        next.open = this.open;
        this.exact.forEach((h) => next.exact.add(h));
        next.suffixes.push(...this.suffixes);
        for (const p of patterns) next.allow(p);
        return next;
    }
}
