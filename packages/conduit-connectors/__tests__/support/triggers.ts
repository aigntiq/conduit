/**
 * Trigger templates, rendered without the trigger runtime (not released yet)
 * and with the scope and connector `functions` they get at run time:
 *
 * - `renderPoll()`: one poll — the request for a `state` and, given the
 *   provider's answer, the items, next cursor, dedupe keys and events.
 * - `renderWebhook()`: the subscription requests, and what a delivery turns
 *   into — a handshake answer, or a verdict, events and a dedupe key.
 */
import type { ConnectorSpec, PollTrigger, TriggerOperation, WebhookTrigger } from '@aigntiq/conduit';
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

function triggerOf(spec: ConnectorSpec, operation: string, type: 'poll' | 'webhook') {
    const op = spec.operations.find((o): o is TriggerOperation => o.id === operation && o.kind === 'trigger');
    if (op?.trigger.type !== type) throw new Error(`${spec.id}/${operation} is not a ${type} trigger`);
    return op.trigger;
}

export interface PollStep {
    /** The rendered request (method, url, query, …). */
    request: Record<string, unknown>;
    /** Render what the trigger makes of the provider's answer. */
    answer(body: unknown, status?: number): Promise<{ response: { url: string }; items: unknown[]; cursor: unknown; keys: unknown[]; events: unknown[] }>;
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
    const trigger = triggerOf(spec, operation, 'poll') as PollTrigger;
    const env = options.env ?? {};
    const functions = registryFor(spec, env);
    // The poll scope at run time: inputs auth account config env state (+ response, item).
    const scope = { inputs: options.inputs ?? {}, auth: options.auth ?? {}, account: options.account ?? {}, config: spec.config ?? {}, env, state: options.state ?? {} };
    const render = (template: unknown, extra: Record<string, unknown> = {}) => renderTemplate(template, { ...scope, ...extra }, { functions });
    const rendered = (await render(trigger.request)) as Record<string, unknown>;
    /** Where the request went, as ResponseView.url has it: against the base URL, with the query. */
    const absoluteUrl = async () => {
        const base = spec.http?.baseUrl === undefined ? undefined : String(await render(spec.http.baseUrl));
        const path = String(rendered.url ?? '');
        const url = new URL(/^https?:\/\//.test(path) || !base ? path : `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
        for (const [key, value] of Object.entries((rendered.query ?? {}) as Record<string, unknown>)) {
            for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined && v !== null) url.searchParams.append(key, String(v));
        }
        return url.toString();
    };
    return {
        request: rendered,
        async answer(body, status = 200) {
            // The ResponseView templates see at run time (url: where the request went).
            const response = { status, ok: status < 400, headers: {}, body, url: await absoluteUrl() };
            const items = ((await render(trigger.items, { response })) as unknown[]) ?? [];
            const cursor = trigger.cursor === undefined ? undefined : await render(trigger.cursor, { response });
            const keys = await Promise.all(items.map((item) => render(trigger.dedupeKey, { response, item })));
            const events = await Promise.all(items.map((item) => (trigger.event === undefined ? item : render(trigger.event, { response, item }))));
            return { response, items, cursor, keys, events };
        }
    };
}

export interface RenderWebhookOptions {
    inputs?: Record<string, unknown>;
    /** `{ callbackUrl, secret, data }` — `data` is what `subscribe.output` returned. */
    subscription?: Record<string, unknown>;
    env?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    account?: Record<string, unknown>;
}

/** A delivery to the callback URL, as `request` reads it. */
export interface Delivery {
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
}

export interface WebhookRender {
    subscribe(): Promise<Record<string, unknown> | undefined>;
    renew(): Promise<{ everyMinutes: number; request: Record<string, unknown> } | undefined>;
    unsubscribe(): Promise<Record<string, unknown> | undefined>;
    /** A handshake answer, or — for a notification — whether it verifies, and its events and dedupe key. */
    deliver(delivery: Delivery): Promise<{ handshake?: unknown; valid?: boolean; accepted?: boolean; events?: unknown[]; dedupeKey?: unknown }>;
}

export async function renderWebhook(spec: ConnectorSpec, operation: string, options: RenderWebhookOptions = {}): Promise<WebhookRender> {
    const trigger = triggerOf(spec, operation, 'webhook') as WebhookTrigger;
    const env = options.env ?? {};
    const functions = registryFor(spec, env);
    // The webhook scope at run time: inputs auth account config env subscription (+ request on delivery).
    const scope = { inputs: options.inputs ?? {}, auth: options.auth ?? {}, account: options.account ?? {}, config: spec.config ?? {}, env, subscription: options.subscription ?? {} };
    const render = (template: unknown, extra: Record<string, unknown> = {}) => renderTemplate(template, { ...scope, ...extra }, { functions });
    return {
        subscribe: async () => (trigger.subscribe === undefined ? undefined : ((await render(trigger.subscribe)) as Record<string, unknown>)),
        renew: async () =>
            trigger.renew === undefined ? undefined : { everyMinutes: trigger.renew.everyMinutes, request: (await render(trigger.renew.request)) as Record<string, unknown> },
        unsubscribe: async () => (trigger.unsubscribe === undefined ? undefined : ((await render(trigger.unsubscribe)) as Record<string, unknown>)),
        async deliver(delivery) {
            const request = { query: {}, headers: {}, ...delivery };
            if (trigger.handshake && (await render(trigger.handshake.when, { request }))) return { handshake: await render(trigger.handshake.respond, { request }) };
            // Only custom verification is rendered here; hmac/token checks are the runtime's.
            const valid = trigger.verify?.type === 'custom' ? Boolean(await render(trigger.verify.valid, { request })) : true;
            const accepted = trigger.filter === undefined ? true : Boolean(await render(trigger.filter, { request }));
            if (!valid || !accepted) return { valid, accepted };
            const event = await render(trigger.event, { request });
            const dedupeKey = trigger.dedupeKey === undefined ? undefined : await render(trigger.dedupeKey, { request });
            return { valid, accepted, events: Array.isArray(event) ? event : [event], dedupeKey };
        }
    };
}
