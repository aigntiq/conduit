/**
 * The plugin API — the familiar plugin shape:
 * `{ name, setup(registry) }`, where `setup` claims extension points.
 */
import type { ConduitError } from '../errors';
import type { ExprFunction } from '../expr/evaluate';
import type { RequestMiddleware } from '../http/perform';
import type { BodyEncoder } from '../http/request';
import type { AccountInfo } from './types';

export interface ExecuteEvent {
    connector: string;
    operation: string;
    account?: string;
    ok: boolean;
    durationMs: number;
    error?: ConduitError;
}

export interface AccountEvent {
    type: 'created' | 'updated' | 'refreshed' | 'needsReauth' | 'deleted';
    account: AccountInfo;
}

export interface RouteContext {
    params: Record<string, string>;
    /** The owner `resolveOwner` returned for this request, if any. */
    owner: string | undefined;
}

/** An extra HTTP route served by `createFetchHandler`, relative to its base path. */
export interface ConduitRoute {
    method: string;
    /** e.g. `/status` or `/things/:id`. */
    path: string;
    handle(request: Request, ctx: RouteContext): Promise<Response> | Response;
}

export interface PluginRegistry {
    /** Expression functions, available to every connector's templates. */
    addFunctions(functions: Record<string, ExprFunction>): void;
    /** A request body encoding, usable as `request.encoding`. */
    addEncoding(name: string, encoder: BodyEncoder): void;
    /** Wrap every outbound request — tracing, rate limiting, header rewriting, mocking. First registered is outermost. */
    useRequest(middleware: RequestMiddleware): void;
    onExecute(listener: (event: ExecuteEvent) => void): void;
    onAccountChanged(listener: (event: AccountEvent) => void): void;
    route(route: ConduitRoute): void;
}

export interface ConduitPlugin {
    readonly name: string;
    setup(registry: PluginRegistry): void;
}

export function definePlugin(plugin: ConduitPlugin): ConduitPlugin {
    return plugin;
}

export class PluginHost implements PluginRegistry {
    readonly functions = new Map<string, ExprFunction>();
    readonly encoders = new Map<string, BodyEncoder>();
    readonly middleware: RequestMiddleware[] = [];
    readonly routes: ConduitRoute[] = [];
    private readonly executeListeners: ((e: ExecuteEvent) => void)[] = [];
    private readonly accountListeners: ((e: AccountEvent) => void)[] = [];

    install(plugins: readonly ConduitPlugin[]): void {
        const names = new Set<string>();
        for (const plugin of plugins) {
            if (names.has(plugin.name)) throw new Error(`plugin "${plugin.name}" is installed twice`);
            names.add(plugin.name);
            plugin.setup(this);
        }
    }

    addFunctions(functions: Record<string, ExprFunction>): void {
        for (const [name, fn] of Object.entries(functions)) {
            if (this.functions.has(name)) throw new Error(`expression function "${name}" is registered twice`);
            this.functions.set(name, fn);
        }
    }

    addEncoding(name: string, encoder: BodyEncoder): void {
        if (this.encoders.has(name)) throw new Error(`encoding "${name}" is registered twice`);
        this.encoders.set(name, encoder);
    }

    useRequest(middleware: RequestMiddleware): void {
        this.middleware.push(middleware);
    }

    onExecute(listener: (event: ExecuteEvent) => void): void {
        this.executeListeners.push(listener);
    }

    onAccountChanged(listener: (event: AccountEvent) => void): void {
        this.accountListeners.push(listener);
    }

    route(route: ConduitRoute): void {
        this.routes.push(route);
    }

    emitExecute(event: ExecuteEvent): void {
        for (const l of this.executeListeners) {
            try {
                l(event);
            } catch {
                // A listener must never break a call.
            }
        }
    }

    emitAccount(event: AccountEvent): void {
        for (const l of this.accountListeners) {
            try {
                l(event);
            } catch {
                // as above
            }
        }
    }
}
