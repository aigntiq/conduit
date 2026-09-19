/**
 * `@sigx/conduit-connectors` — ready-made connectors in one package. Pick
 * the ones you use; only those are loaded:
 *
 *     createConduit({ sources: connectorCatalog({ include: ['gmail'] }), … })
 *
 * Each connector is also its own subpath (`@sigx/conduit-connectors/gmail`)
 * for bundlers and edge runtimes, and plain JSON under `json/`.
 */
import type { ConnectorSource, ConnectorSpec, ConnectorSummary } from '@sigx/conduit';
import { loaders, summaries } from './generated/registry';

export type { Connectors } from './generated/registry';

export type ConnectorId = keyof typeof loaders;

/** Every connector in the package (id, name, version, description, icon, categories). */
export const catalog: readonly ConnectorSummary[] = summaries;

export interface CatalogOptions {
    /** The connectors to serve, or `'*'` for all of them. */
    include: readonly ConnectorId[] | '*';
}

/** A `ConnectorSource` serving the chosen connectors, each loaded on first use. */
export function connectorCatalog(options: CatalogOptions): ConnectorSource {
    const available = Object.keys(loaders) as ConnectorId[];
    const ids = options.include === '*' ? available : [...new Set(options.include)];
    for (const id of ids) {
        if (!available.includes(id)) throw new Error(`no connector "${String(id)}" in @sigx/conduit-connectors (available: ${available.join(', ')})`);
    }
    const cache = new Map<string, Promise<ConnectorSpec>>();
    const load = (id: ConnectorId) => {
        let entry = cache.get(id);
        if (!entry) {
            entry = loaders[id]().then((m) => m.default as ConnectorSpec);
            cache.set(id, entry);
        }
        return entry;
    };
    return {
        async list() {
            return Promise.all(ids.map(load));
        },
        async get(id) {
            return (ids as string[]).includes(id) ? load(id as ConnectorId) : undefined;
        }
    };
}
