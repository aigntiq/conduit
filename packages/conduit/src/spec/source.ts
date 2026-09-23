/**
 * Connector sources — where specs come from. A port: hosts can serve specs
 * from anywhere (a database, a registry, a bundle) by implementing
 * `ConnectorSource`. Core ships in-memory and composite sources; the
 * filesystem source lives in `@aigntiq/conduit/node`.
 */
import type { ConnectorSpec } from './types';

export interface ConnectorSource {
    /** Every connector this source provides. May be called often; cache if it is expensive. */
    list(): Promise<readonly ConnectorSpec[]>;
    get(id: string): Promise<ConnectorSpec | undefined>;
    /**
     * Subscribe to changes. `id` is the changed connector, or undefined when
     * the whole source should be re-read. Returns an unsubscribe function.
     */
    watch?(onChange: (id?: string) => void): () => void;
}

/** A mutable in-memory source. `set`/`delete` notify watchers. */
export interface MemorySource extends ConnectorSource {
    set(spec: ConnectorSpec): void;
    delete(id: string): boolean;
}

export function memorySource(specs: Iterable<ConnectorSpec> = []): MemorySource {
    const byId = new Map<string, ConnectorSpec>();
    for (const s of specs) byId.set(s.id, s);
    const listeners = new Set<(id?: string) => void>();
    const notify = (id: string) => listeners.forEach((l) => l(id));
    return {
        async list() {
            return [...byId.values()];
        },
        async get(id) {
            return byId.get(id);
        },
        watch(onChange) {
            listeners.add(onChange);
            return () => listeners.delete(onChange);
        },
        set(spec) {
            byId.set(spec.id, spec);
            notify(spec.id);
        },
        delete(id) {
            const had = byId.delete(id);
            if (had) notify(id);
            return had;
        }
    };
}

/** Several sources as one. For a duplicate id, the earliest source wins. */
export function compositeSource(...sources: ConnectorSource[]): ConnectorSource {
    return {
        async list() {
            const seen = new Map<string, ConnectorSpec>();
            for (const source of sources) {
                for (const spec of await source.list()) if (!seen.has(spec.id)) seen.set(spec.id, spec);
            }
            return [...seen.values()];
        },
        async get(id) {
            for (const source of sources) {
                const spec = await source.get(id);
                if (spec) return spec;
            }
            return undefined;
        },
        watch(onChange) {
            const stops = sources.map((s) => s.watch?.(onChange)).filter((s): s is () => void => !!s);
            return () => stops.forEach((stop) => stop());
        }
    };
}
