/**
 * One step of a poll trigger, rendered without the trigger runtime: the
 * request it would send for a `state`, and — given the provider's answer —
 * the items, the next cursor, and each item's dedupe key and event. The
 * connector's own `functions` are available, as they are at run time.
 */
import type { ConnectorSpec, TriggerOperation } from '@aigntiq/conduit';
import { createFunctionRegistry, evaluateExpression, renderTemplate, type ExprFunction } from '@aigntiq/conduit/expr';

function registryFor(spec: ConnectorSpec) {
    const functions = createFunctionRegistry();
    for (const [name, fn] of Object.entries(spec.functions ?? {})) {
        const entry: ExprFunction = {
            signature: `${name}(${fn.params.join(', ')})`,
            description: fn.description,
            maxArgs: fn.params.length,
            call: (args) => {
                const scope: Record<string, unknown> = { config: spec.config };
                fn.params.forEach((p, i) => (scope[p] = args[i]));
                return evaluateExpression(fn.body, scope, { functions });
            }
        };
        functions.set(name, entry);
    }
    return functions;
}

export interface PollStep {
    /** The rendered request (method, url, query, …). */
    request: Record<string, unknown>;
    /** Render what the trigger makes of the provider's answer. */
    answer(body: unknown, status?: number): Promise<{ items: unknown[]; cursor: unknown; keys: unknown[]; events: unknown[] }>;
}

export async function renderPoll(spec: ConnectorSpec, operation: string, options: { inputs?: Record<string, unknown>; state?: Record<string, unknown> } = {}): Promise<PollStep> {
    const op = spec.operations.find((o): o is TriggerOperation => o.id === operation && o.kind === 'trigger');
    const trigger = op?.trigger;
    if (trigger?.type !== 'poll') throw new Error(`${spec.id}/${operation} is not a poll trigger`);
    const functions = registryFor(spec);
    const scope = { inputs: options.inputs ?? {}, state: options.state ?? {}, config: spec.config ?? {} };
    const render = (template: unknown, extra: Record<string, unknown> = {}) => renderTemplate(template, { ...scope, ...extra }, { functions });
    return {
        request: (await render(trigger.request)) as Record<string, unknown>,
        async answer(body, status = 200) {
            const response = { status, ok: status < 400, headers: {}, body };
            const items = ((await render(trigger.items, { response })) as unknown[]) ?? [];
            const cursor = trigger.cursor === undefined ? undefined : await render(trigger.cursor, { response });
            const keys = await Promise.all(items.map((item) => render(trigger.dedupeKey, { response, item })));
            const events = await Promise.all(items.map((item) => (trigger.event === undefined ? item : render(trigger.event, { response, item }))));
            return { items, cursor, keys, events };
        }
    };
}
