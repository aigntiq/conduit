/**
 * `fileSource(dir)` — load connectors from the filesystem.
 *
 * Two layouts are accepted under `dir`, side by side:
 *
 *     connectors/
 *       acme-crm/                 a directory per connector
 *         connector.json          everything except auth and operations
 *         auth.json               [ …methods ]  or  { "methods": [ … ] }
 *         operations/*.json       one operation per file; id defaults to the file name
 *         icon.svg | icon.png     inlined as a data: URI when connector.json has no icon
 *       weather.json              or a whole connector in one file
 *
 * Loading assembles specs; it does not validate them — `createConduit`
 * validates everything it loads, so one rule applies to every source.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { ConduitSpecError } from '../errors';
import type { ConnectorSource } from '../spec/source';
import type { ConnectorSpec } from '../spec/types';

export interface FileSourceOptions {
    /** Re-read on changes (recursive `fs.watch`). Default false. */
    watch?: boolean;
}

const ICON_TYPES: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
};

async function readJson(path: string): Promise<unknown> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (e) {
        throw new ConduitSpecError(`cannot read ${path}: ${(e as Error).message}`, [], { cause: e });
    }
    try {
        return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (e) {
        throw new ConduitSpecError(`${path} is not valid JSON: ${(e as Error).message}`, [], { cause: e });
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function dataUri(path: string): Promise<string | undefined> {
    const type = ICON_TYPES[extname(path).toLowerCase()];
    if (!type || !(await exists(path))) return undefined;
    return `data:${type};base64,${(await readFile(path)).toString('base64')}`;
}

async function loadDirectory(dir: string): Promise<ConnectorSpec> {
    const manifest = (await readJson(join(dir, 'connector.json'))) as Record<string, unknown>;
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        throw new ConduitSpecError(`${join(dir, 'connector.json')} must contain an object`);
    }
    const spec: Record<string, unknown> = { ...manifest };

    const authPath = join(dir, 'auth.json');
    if (await exists(authPath)) {
        const auth = await readJson(authPath);
        const methods = Array.isArray(auth) ? auth : (auth as { methods?: unknown })?.methods;
        if (!Array.isArray(methods)) throw new ConduitSpecError(`${authPath} must be an array or { "methods": [...] }`);
        spec.auth = [...((spec.auth as unknown[]) ?? []), ...methods];
    }

    const opsDir = join(dir, 'operations');
    if (await exists(opsDir)) {
        const files = (await readdir(opsDir)).filter((f) => f.endsWith('.json')).sort();
        const ops: unknown[] = [...((spec.operations as unknown[]) ?? [])];
        for (const file of files) {
            const op = (await readJson(join(opsDir, file))) as Record<string, unknown>;
            ops.push({ id: basename(file, '.json'), ...op });
        }
        spec.operations = ops;
    }
    spec.operations ??= [];

    if (typeof spec.icon === 'string' && !/^(https?:|data:)/.test(spec.icon)) {
        spec.icon = (await dataUri(resolve(dir, spec.icon))) ?? spec.icon;
    } else if (spec.icon === undefined) {
        for (const ext of Object.keys(ICON_TYPES)) {
            const uri = await dataUri(join(dir, `icon${ext}`));
            if (uri) {
                spec.icon = uri;
                break;
            }
        }
    }
    return spec as unknown as ConnectorSpec;
}

async function loadAll(root: string): Promise<Map<string, ConnectorSpec>> {
    const out = new Map<string, ConnectorSpec>();
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(root, entry.name);
        let spec: ConnectorSpec | undefined;
        if (entry.isDirectory() && (await exists(join(path, 'connector.json')))) {
            spec = await loadDirectory(path);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
            const json = (await readJson(path)) as ConnectorSpec;
            if (json && typeof json === 'object' && (json as { spec?: unknown }).spec !== undefined) spec = json;
        }
        if (!spec) continue;
        if (typeof spec.id !== 'string') throw new ConduitSpecError(`${path}: connector has no "id"`);
        if (out.has(spec.id)) throw new ConduitSpecError(`${path}: connector id "${spec.id}" is used twice`);
        out.set(spec.id, spec);
    }
    return out;
}

export function fileSource(dir: string, options: FileSourceOptions = {}): ConnectorSource {
    const root = resolve(dir);
    let cache: Promise<Map<string, ConnectorSpec>> | undefined;
    const load = () => (cache ??= loadAll(root).catch((e) => {
        cache = undefined;
        throw e;
    }));

    const listeners = new Set<(id?: string) => void>();
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ensureWatcher = () => {
        if (!options.watch || watcher) return;
        watcher = fsWatch(root, { recursive: true }, () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                cache = undefined;
                listeners.forEach((l) => l());
            }, 100);
        });
        watcher.unref?.();
    };

    return {
        async list() {
            return [...(await load()).values()];
        },
        async get(id) {
            return (await load()).get(id);
        },
        watch(onChange) {
            listeners.add(onChange);
            ensureWatcher();
            return () => {
                listeners.delete(onChange);
                if (listeners.size === 0 && watcher) {
                    watcher.close();
                    watcher = undefined;
                    clearTimeout(timer);
                }
            };
        }
    };
}
