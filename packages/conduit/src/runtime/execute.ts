/**
 * Operation execution: resolve → authorize → inputs → steps → request
 * (paged) → output. One path for every operation kind the runtime runs.
 */
import { ConduitAuthError, ConduitError, ConduitPolicyError, ConduitRequestError, isConduitError } from '../errors';
import { describeType, display, isPlainObject } from '../expr/evaluate';
import { renderTemplate } from '../expr/template';
import { resolveRetry, type TraceEntry } from '../http/perform';
import { nextLink, type ResponseView } from '../http/response';
import { assertInputs } from '../spec/inputs';
import type { AuthMethod, OperationSpec, PaginateSpec, RequestSpec, StepSpec } from '../spec/types';
import { ensureFresh, loadAccount, open, toInfo, type Fresh } from './accounts';
import { describeOperation } from './describe';
import { accountScope, authScope, maskerFor, send, type CallContext, type Kernel } from './kernel';
import { evaluatePolicy } from './policy';
import type { LoadedConnector } from './registry';
import type { ExecuteRequest, ExecuteResult, OptionItem } from './types';

type Scope = Record<string, unknown>;

interface Prepared {
    loaded: LoadedConnector;
    op: Exclude<OperationSpec, { kind: 'trigger' }>;
    method?: AuthMethod;
    fresh?: Fresh;
    inputs: Record<string, unknown>;
    env: Record<string, unknown>;
    ctx: CallContext;
}

async function prepare(k: Kernel, req: ExecuteRequest, trace: TraceEntry[]): Promise<Prepared> {
    const loaded = await k.registry.get(req.connector);
    const op = loaded.operation(req.operation);
    if (op.kind === 'trigger') {
        throw new ConduitError('operation_not_callable', `"${op.id}" is a trigger — triggers are delivered, not executed`);
    }

    const needsAuth = op.auth !== false && (loaded.spec.auth?.length ?? 0) > 0;
    let method: AuthMethod | undefined;
    let fresh: Fresh | undefined;
    if (needsAuth || req.account) {
        if (!req.account) throw new ConduitError('account_required', `"${loaded.spec.id}/${op.id}" needs an account`);
        const account = await loadAccount(k, req.account, req.owner);
        if (account.connector !== loaded.spec.id) {
            throw new ConduitError('account_mismatch', `account "${account.id}" belongs to connector "${account.connector}", not "${loaded.spec.id}"`);
        }
        if (Array.isArray(op.auth) && !op.auth.includes(account.method)) {
            throw new ConduitError('account_mismatch', `"${op.id}" does not support auth method "${account.method}"`);
        }
        if (account.status === 'needsReauth') {
            throw new ConduitAuthError(`account "${account.id}" needs to be reconnected`, { accountId: account.id, needsReauth: true });
        }
        method = loaded.method(account.method);
        fresh = { account, credentials: await open(k, account) };
    }

    const inputs = await assertInputs(op.inputs, req.inputs, 'inputs', { functions: loaded.functions });
    const env = { ...k.env, ...req.env };

    const ctx: CallContext = {
        loaded,
        guard: loaded.guard,
        method,
        credentials: fresh?.credentials,
        info: { connector: loaded.spec.id, operation: op.id, account: fresh?.account.id },
        trace,
        signal: req.signal,
        mask: maskerFor(method, fresh?.credentials),
        retry: resolveRetry(loaded.spec.http?.retry, op.retry),
        rules: op.errors
    };
    return { loaded, op, method, fresh, inputs, env, ctx };
}

/**
 * Ask the host's policy about this call — after the inputs are validated,
 * before any credential is renewed or request sent.
 */
async function enforcePolicy(k: Kernel, req: ExecuteRequest, p: Prepared): Promise<void> {
    if (!k.policy) return;
    const connector = p.loaded.spec.id;
    const account = p.fresh ? toInfo(p.fresh.account) : undefined;
    const verdict = await evaluatePolicy(k.policy, {
        connector,
        operation: describeOperation(p.loaded.spec, p.op),
        owner: req.owner ?? account?.owner,
        caller: req.caller,
        account,
        inputs: p.inputs
    });
    if (verdict.decision === 'allow' || (verdict.decision === 'confirm' && req.confirmed === true)) return;

    const target = `"${connector}/${p.op.id}"`;
    const because = verdict.reason === undefined ? '' : `: ${verdict.reason}`;
    const details: Record<string, unknown> = { connector, operation: p.op.id };
    if (account) details.account = account.id;
    if (req.caller !== undefined) details.caller = req.caller;
    if (verdict.reason !== undefined) details.reason = verdict.reason;
    throw verdict.decision === 'deny'
        ? new ConduitPolicyError('deny', `policy denies ${target}${because}`, { reason: verdict.reason, details })
        : new ConduitPolicyError('confirm', `${target} needs confirmation${because}`, { reason: verdict.reason, details });
}

function baseScope(p: Prepared, extra: Scope = {}): Scope {
    return {
        inputs: p.inputs,
        account: accountScope(p.fresh?.account),
        config: p.loaded.config,
        env: p.env,
        ...extra
    };
}

/** Wire credential renewal into the call context: early refresh now, forced refresh on a 401. */
async function authorize(k: Kernel, p: Prepared): Promise<void> {
    if (!p.fresh || !p.method) return;
    const method = p.method;
    const apply = (f: Fresh) => {
        p.fresh = f;
        p.ctx.credentials = f.credentials;
        p.ctx.mask = maskerFor(method, f.credentials);
    };
    apply(await ensureFresh(k, p.loaded, method, p.fresh, { ctx: { trace: p.ctx.trace, signal: p.ctx.signal } }));
    p.ctx.onUnauthorized = async () => {
        try {
            apply(await ensureFresh(k, p.loaded, method, p.fresh!, { force: true, ctx: { trace: p.ctx.trace, signal: p.ctx.signal } }));
            return true;
        } catch (e) {
            if (e instanceof ConduitAuthError) return false;
            throw e;
        }
    };
}

async function runSteps(k: Kernel, p: Prepared, steps: readonly StepSpec[] | undefined, scope: Scope): Promise<Scope> {
    const results: Scope = {};
    for (const step of steps ?? []) {
        const s = { ...scope, steps: results };
        if (step.forEach === undefined) {
            const out = await runStep(k, p, step, s, `step ${step.name}`);
            if (out !== SKIPPED) results[step.name] = out;
            continue;
        }
        const items = await renderWithAuth(k, p, step.forEach, s);
        const max = step.maxIterations ?? DEFAULT_MAX_ITERATIONS;
        if (!Array.isArray(items)) throw new ConduitError('step_foreach_invalid', `step "${step.name}": forEach is ${describeType(items)}, not a list`);
        if (items.length > max) throw new ConduitError('step_foreach_invalid', `step "${step.name}": forEach has ${items.length} items, at most ${max} allowed`);
        // Outputs so far are visible as steps.<name> while the loop runs.
        const outputs: unknown[] = [];
        results[step.name] = outputs;
        for (const [index, each] of items.entries()) {
            const out = await runStep(k, p, step, { ...s, each, index }, `step ${step.name}[${index}]`);
            outputs.push(out === SKIPPED ? null : out);
        }
    }
    return results;
}

const DEFAULT_MAX_ITERATIONS = 100;
const SKIPPED = Symbol('skipped');

/** One run of a step: its `when`, the request through the one executor, and its `output`. */
async function runStep(k: Kernel, p: Prepared, step: StepSpec, s: Scope, label: string): Promise<unknown> {
    if (step.when !== undefined && !(await renderWithAuth(k, p, step.when, s))) return SKIPPED;
    const view = await send(k, p.ctx, { label, purpose: 'step', spec: step, scope: s });
    return step.output === undefined ? view.body : renderWithAuth(k, p, step.output, { ...s, response: view });
}

/** Render with the current `auth` scope (which changes if credentials are renewed mid-call). */
function renderWithAuth(k: Kernel, p: Prepared, value: unknown, scope: Scope): Promise<unknown> {
    return renderTemplate(value, { ...scope, auth: authScope(p.ctx.credentials) }, { functions: p.loaded.functions, now: k.now });
}

interface PageState {
    number: number;
    offset: number;
    cursor: unknown;
    url: string | undefined;
}

function pageQuery(pg: PaginateSpec, state: PageState): Record<string, unknown> {
    const q: Record<string, unknown> = {};
    if (pg.pageSize !== undefined && pg.pageSizeParam) q[pg.pageSizeParam] = pg.pageSize;
    if (!pg.param) return q;
    if (pg.style === 'cursor' && state.cursor !== undefined && state.cursor !== null && state.cursor !== '') q[pg.param] = state.cursor;
    if (pg.style === 'offset') q[pg.param] = state.offset;
    if (pg.style === 'page') q[pg.param] = state.number;
    return q;
}

async function runPaged(
    k: Kernel,
    p: Prepared,
    request: RequestSpec,
    pg: PaginateSpec,
    scope: Scope,
    paging: ExecuteRequest['paging']
): Promise<{ items: unknown[]; last?: ResponseView; next?: unknown; pages: number }> {
    const mode = paging?.mode ?? 'all';
    const maxPages = mode === 'page' ? 1 : Math.min(paging?.maxPages ?? pg.maxPages ?? 10, pg.maxPages ?? Infinity);
    const resume = paging?.cursor;
    const state: PageState = {
        number: pg.style === 'page' ? Number(resume ?? pg.start ?? 1) : pg.start ?? 1,
        offset: pg.style === 'offset' ? Number(resume ?? pg.start ?? 0) : pg.start ?? 0,
        cursor: pg.style === 'cursor' ? resume : undefined,
        url: pg.style === 'nextUrl' || pg.style === 'linkHeader' ? (resume === undefined ? undefined : String(resume)) : undefined
    };

    const items: unknown[] = [];
    let last: ResponseView | undefined;
    let pages = 0;
    let next: unknown;

    while (pages < maxPages) {
        const pageScope = { ...scope, page: { ...state } };
        // A next-page URL comes from the API, not the spec: it goes through
        // the host guard like any other URL.
        const view = await send(k, p.ctx, {
            label: pages === 0 ? 'request' : `page ${pages + 1}`,
            purpose: pages === 0 ? 'operation' : 'page',
            spec: request,
            scope: pageScope,
            urlOverride: state.url,
            extraQuery: state.url ? undefined : pageQuery(pg, state)
        });
        last = view;
        pages++;

        const resultScope = { ...pageScope, response: view };
        const raw = await renderWithAuth(k, p, pg.items, resultScope);
        const pageItems = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
        items.push(...pageItems);

        let hasNext: boolean;
        let following: unknown;
        switch (pg.style) {
            case 'cursor':
                following = await renderWithAuth(k, p, pg.next, resultScope);
                hasNext = following !== undefined && following !== null && following !== '';
                break;
            case 'nextUrl': {
                const u = await renderWithAuth(k, p, pg.next, resultScope);
                following = u === undefined || u === null || u === '' ? undefined : new URL(display(u), view.url || undefined).toString();
                hasNext = following !== undefined;
                break;
            }
            case 'linkHeader': {
                const u = nextLink(view.headers);
                following = u === undefined ? undefined : new URL(u, view.url || undefined).toString();
                hasNext = following !== undefined;
                break;
            }
            case 'offset':
                following = state.offset + (pg.pageSize ?? pageItems.length);
                hasNext = pageItems.length > 0;
                break;
            case 'page':
                following = state.number + 1;
                hasNext = pageItems.length > 0;
                break;
        }
        if (pg.hasMore !== undefined) hasNext = hasNext && !!(await renderWithAuth(k, p, pg.hasMore, resultScope));

        if (pg.maxItems !== undefined && items.length >= pg.maxItems) {
            items.length = pg.maxItems;
            next = hasNext ? following : undefined;
            break;
        }
        if (!hasNext) {
            next = undefined;
            break;
        }
        next = following;
        if (pg.style === 'cursor') state.cursor = following;
        else if (pg.style === 'offset') state.offset = following as number;
        else if (pg.style === 'page') state.number = following as number;
        else state.url = following as string;
    }
    return { items, last, next, pages };
}

export async function execute(k: Kernel, req: ExecuteRequest): Promise<ExecuteResult & { kind: string }> {
    const trace: TraceEntry[] = [];
    const started = k.now();
    let p: Prepared | undefined;
    try {
        p = await prepare(k, req, trace);
        await enforcePolicy(k, req, p);
        await authorize(k, p);
        const scope = baseScope(p);
        const steps = await runSteps(k, p, p.op.steps, scope);
        const withSteps = { ...scope, steps };

        let output: unknown;
        let next: unknown;
        let pages: number | undefined;
        if ((p.op.kind === 'search' || p.op.kind === 'options') && p.op.paginate) {
            const r = await runPaged(k, p, p.op.request, p.op.paginate, withSteps, req.paging);
            pages = r.pages;
            next = req.paging?.mode === 'page' ? r.next : undefined;
            output = p.op.output === undefined ? r.items : await renderWithAuth(k, p, p.op.output, { ...withSteps, response: r.last, items: r.items });
        } else {
            const view = await send(k, p.ctx, { label: 'request', purpose: 'operation', spec: p.op.request, scope: withSteps });
            const items = Array.isArray(view.body) ? view.body : undefined;
            output = p.op.output === undefined ? view.body : await renderWithAuth(k, p, p.op.output, { ...withSteps, response: view, items });
        }

        if (p.op.kind === 'options') output = normalizeOptions(output);
        k.plugins.emitExecute({
            connector: req.connector,
            operation: req.operation,
            account: p.fresh?.account.id,
            ok: true,
            durationMs: k.now() - started
        });
        const result: ExecuteResult & { kind: string } = { output, trace, kind: p.op.kind };
        if (pages !== undefined) result.pages = pages;
        if (req.paging?.mode === 'page') result.next = next;
        return result;
    } catch (e) {
        const error = isConduitError(e) ? e : new ConduitError('internal', (e as Error)?.message ?? String(e), { cause: e });
        if (error instanceof ConduitRequestError && error.kind === 'auth' && p?.fresh) {
            // The remote rejected the credentials and renewal did not help.
            const wrapped = new ConduitAuthError(`account "${p.fresh.account.id}" was rejected: ${error.message}`, {
                accountId: p.fresh.account.id,
                needsReauth: true,
                cause: error
            });
            k.plugins.emitExecute({ connector: req.connector, operation: req.operation, account: p.fresh.account.id, ok: false, durationMs: k.now() - started, error: wrapped });
            throw wrapped;
        }
        k.plugins.emitExecute({ connector: req.connector, operation: req.operation, account: p?.fresh?.account.id, ok: false, durationMs: k.now() - started, error });
        throw error;
    }
}

export function normalizeOptions(output: unknown): OptionItem[] {
    if (output === undefined || output === null) return [];
    if (!Array.isArray(output)) throw new ConduitError('options_invalid', 'an options operation must output a list');
    return output.map((item) => {
        if (isPlainObject(item) && 'value' in item) {
            return { ...item, label: item.label === undefined ? display(item.value) : display(item.label), value: item.value } as OptionItem;
        }
        return { label: display(item), value: item };
    });
}
