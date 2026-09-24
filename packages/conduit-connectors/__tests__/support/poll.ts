/**
 * One step of a poll trigger, rendered without the trigger runtime: the
 * request it would send for a `state`, and — given the provider's answer —
 * the items, the next cursor, and each item's dedupe key and event. The
 * connector's own `functions` are available, as they are at run time.
 */
import type { ConnectorSpec, TriggerOperation } from '@aigntiq/conduit';
import { createFunctionRegistry, evaluateExpression, renderTemplate, type ExprFunction } from '@aigntiq/conduit/expr';

function registryFor(spec: ConnectorSpec, env: Record<string, unknown>) {
    const functions = createFunctionRegistry();
    for (const [name, fn] of Object.entries(spec.functions ?? {})) {
        const entry: ExprFunction = {
            signature: `${name}(${fn.params.join(', ')})`,
            description: fn.description,
            maxArgs: fn.params.length,
            call: (args) => {
                // As at run time: a function sees config and env besides its params.
                const scope: Record<string, unknown> = { config: spec.config ?? {}, env };
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

export interface RenderPollOptions {
    inputs?: Record<string, unknown>;
    state?: Record<string, unknown>;
    /** What the host passes as `env`. */
    env?: Record<string, unknown>;
    /** The account's credentials and data, as templates read them. */
    auth?: Record<string, unknown>;
    account?: Record<string, unknown>;
}

export async function renderPoll(spec: ConnectorSpec, operation: string, options: RenderPollOptions = {}): Promise<PollStep> {
    const op = spec.operations.find((o): o is TriggerOperation => o.id === operation && o.kind === 'trigger');
    const trigger = op?.trigger;
    if (trigger?.type !== 'poll') throw new Error(`${spec.id}/${operation} is not a poll trigger`);
    const env = options.env ?? {};
    const functions = registryFor(spec, env);
    // The poll scope at run time: inputs auth account config env state (+ response, item).
    const scope = { inputs: options.inputs ?? {}, auth: options.auth ?? {}, account: options.account ?? {}, config: spec.config ?? {}, env, state: options.state ?? {} };
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
