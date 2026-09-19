/**
 * The connector registry: loads specs from the sources, validates each once,
 * and prepares what every call needs — merged config, the expression
 * function registry (standard + plugin + connector functions) and the
 * static part of the host guard.
 */
import { ConduitError, ConduitSpecError, type Diagnostic } from '../errors';
import type { ExprFunction, FunctionRegistry } from '../expr/evaluate';
import { evaluateExpression } from '../expr/template';
import { createFunctionRegistry } from '../expr/stdlib';
import { HostGuard } from '../http/guard';
import type { ConnectorSource } from '../spec/source';
import type { AuthMethod, ConnectorSpec, OperationSpec } from '../spec/types';
import { validateConnector } from '../spec/validate';

export interface LoadedConnector {
    readonly spec: ConnectorSpec;
    /** `spec.config` merged with the host's per-connector overrides. */
    readonly config: Record<string, unknown>;
    readonly functions: FunctionRegistry;
    /** Hosts allowed before any per-call URL is rendered. */
    readonly guard: HostGuard;
    readonly warnings: readonly Diagnostic[];
    operation(id: string): OperationSpec;
    method(id: string): AuthMethod;
}

export interface RegistryOptions {
    sources: readonly ConnectorSource[];
    pluginFunctions: () => ReadonlyMap<string, ExprFunction>;
    config: Record<string, Record<string, unknown>>;
    env: Record<string, unknown>;
    allowHosts: readonly string[];
}

function literalHost(template: string | undefined): string | undefined {
    if (!template || template.includes('{{')) return undefined;
    try {
        return new URL(template).host;
    } catch {
        return undefined;
    }
}

export class ConnectorRegistry {
    private readonly cache = new Map<string, Promise<LoadedConnector>>();
    private readonly unwatch: (() => void)[] = [];

    constructor(private readonly options: RegistryOptions) {
        for (const source of options.sources) {
            const stop = source.watch?.((id) => this.invalidate(id));
            if (stop) this.unwatch.push(stop);
        }
    }

    invalidate(id?: string): void {
        if (id === undefined) this.cache.clear();
        else this.cache.delete(id);
    }

    close(): void {
        this.unwatch.forEach((stop) => stop());
        this.unwatch.length = 0;
    }

    private async find(id: string): Promise<ConnectorSpec | undefined> {
        for (const source of this.options.sources) {
            const spec = await source.get(id);
            if (spec) return spec;
        }
        return undefined;
    }

    async ids(): Promise<string[]> {
        const seen = new Set<string>();
        for (const source of this.options.sources) for (const spec of await source.list()) seen.add(spec.id);
        return [...seen];
    }

    /** Load a connector, validating it. Throws `ConduitSpecError` for an invalid one. */
    get(id: string): Promise<LoadedConnector> {
        let entry = this.cache.get(id);
        if (!entry) {
            entry = this.load(id);
            this.cache.set(id, entry);
            // Do not cache a failed lookup of an unknown id forever.
            entry.catch((e) => {
                if (e instanceof ConduitError && e.code === 'connector_unknown') this.cache.delete(id);
            });
        }
        return entry;
    }

    /** Validation diagnostics for every connector the sources provide. */
    async diagnostics(): Promise<Record<string, Diagnostic[]>> {
        const out: Record<string, Diagnostic[]> = {};
        for (const id of await this.ids()) {
            try {
                out[id] = [...(await this.get(id)).warnings];
            } catch (e) {
                out[id] = e instanceof ConduitSpecError ? [...e.diagnostics] : [{ path: '', code: 'load_failed', message: String((e as Error).message), severity: 'error' }];
            }
        }
        return out;
    }

    private async load(id: string): Promise<LoadedConnector> {
        const spec = await this.find(id);
        if (!spec) throw new ConduitError('connector_unknown', `no connector "${id}"`);

        const plugin = this.options.pluginFunctions();
        const result = validateConnector(spec, { functions: plugin });
        if (!result.valid) {
            const errors = result.diagnostics.filter((d) => d.severity === 'error');
            const lines = errors.slice(0, 10).map((d) => `  ${d.path || '(root)'}: ${d.message}`);
            throw new ConduitSpecError([`connector "${id}" is invalid`, ...lines].join('\n'), result.diagnostics);
        }

        const config = { ...spec.config, ...this.options.config[id] };
        const env = this.options.env;
        const functions = createFunctionRegistry(plugin);
        for (const [name, fn] of Object.entries(spec.functions ?? {})) {
            const entry: ExprFunction = {
                signature: `${name}(${fn.params.join(', ')})`,
                description: fn.description,
                maxArgs: fn.params.length,
                call: (args) => {
                    const scope: Record<string, unknown> = { config, env };
                    fn.params.forEach((p, i) => (scope[p] = args[i]));
                    return evaluateExpression(fn.body, scope, { functions });
                }
            };
            functions.set(name, entry);
        }

        const guard = new HostGuard(this.options.allowHosts);
        for (const host of spec.http?.allowHosts ?? []) guard.allow(host);
        const baseHost = literalHost(spec.http?.baseUrl);
        if (baseHost) guard.allow(baseHost);

        const operations = new Map(spec.operations.map((o) => [o.id, o]));
        const methods = new Map((spec.auth ?? []).map((m) => [m.id, m]));
        return {
            spec,
            config,
            functions,
            guard,
            warnings: result.diagnostics,
            operation(opId) {
                const op = operations.get(opId);
                if (!op) throw new ConduitError('operation_unknown', `connector "${id}" has no operation "${opId}"`);
                return op;
            },
            method(methodId) {
                const m = methods.get(methodId);
                if (!m) throw new ConduitError('auth_method_unknown', `connector "${id}" has no auth method "${methodId}"`);
                return m;
            }
        };
    }
}
