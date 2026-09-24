/**
 * Operation policy — a gate the host puts in front of every `execute`.
 *
 * Conduit decides nothing on its own and stores nothing: the host supplies an
 * `OperationPolicy`, and Conduit asks it after the inputs are validated and
 * before any credential is refreshed or request sent. The vocabulary is
 * generic — an operation, a caller the host names, and a decision — so the
 * same gate serves an agent runtime, a workflow engine or a plain backend.
 */
import { ConduitError } from '../errors';
import type { AccountInfo, OperationDescription } from './types';

/**
 * `allow` runs the call; `deny` refuses it; `confirm` refuses it until the
 * host re-runs it with `confirmed: true`, after its own approval step.
 */
export type Decision = 'allow' | 'confirm' | 'deny';

export interface PolicyVerdict {
    decision: Decision;
    /** Why — carried on the error a refused call throws. */
    reason?: string;
}

export interface PolicyContext {
    connector: string;
    /** The operation as `describe()` shows it: kind, readOnly, destructive, group, tags… */
    operation: OperationDescription;
    /** The owner the call runs for. */
    owner?: string;
    /** Who is calling, as the host named it on the request (an agent, a workflow, an API key…). Opaque to Conduit. */
    caller?: string;
    account?: AccountInfo;
    /** The validated inputs. Absent when the host asks ahead of a call (`conduit.decide`). */
    inputs?: Record<string, unknown>;
}

/** `undefined` abstains: the policy has no opinion, and a combinator (or the gate, as `allow`) decides. */
export type PolicyResult = Decision | PolicyVerdict | undefined;

export type OperationPolicy = (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>;

const RANK: Record<Decision, number> = { allow: 0, confirm: 1, deny: 2 };

/** A bad result for the error message — never throws, whatever the policy returned. */
function shown(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return typeof value === 'object' ? 'an unserialisable object' : String(value);
    }
}

function verdict(result: PolicyResult): PolicyVerdict | undefined {
    if (result === undefined) return undefined;
    const v = typeof result === 'string' ? { decision: result } : result;
    if (typeof v !== 'object' || v === null || !Object.hasOwn(RANK, v.decision)) {
        throw new ConduitError('policy_invalid', `a policy returned ${shown(result)} — expected "allow", "confirm", "deny" or undefined`);
    }
    return v.reason === undefined ? { decision: v.decision } : { decision: v.decision, reason: v.reason };
}

/** Run a policy; abstaining means `allow`. */
export async function evaluatePolicy(policy: OperationPolicy, ctx: PolicyContext): Promise<PolicyVerdict> {
    return verdict(await policy(ctx)) ?? { decision: 'allow' };
}

/**
 * Every policy is asked, and the strictest answer wins: `deny` over
 * `confirm` over `allow`. Layer rules this way when a later layer may only
 * tighten an earlier one. Abstentions are skipped; if all abstain, so does this.
 */
export function strictest(...policies: OperationPolicy[]): OperationPolicy {
    return async (ctx) => {
        let best: PolicyVerdict | undefined;
        for (const policy of policies) {
            const v = verdict(await policy(ctx));
            if (v && (!best || RANK[v.decision] > RANK[best.decision])) best = v;
            if (best?.decision === 'deny') break;
        }
        return best;
    };
}

/**
 * The first policy with an opinion decides. Layer rules this way when a
 * specific rule overrides a general default — in either direction.
 */
export function firstOf(...policies: OperationPolicy[]): OperationPolicy {
    return async (ctx) => {
        for (const policy of policies) {
            const v = verdict(await policy(ctx));
            if (v) return v;
        }
        return undefined;
    };
}

export interface AnnotationDecisions {
    /** Operations that only read — `readOnly`, or a `search`/`options` that does not say otherwise. Default `allow`. */
    readOnly?: Decision;
    /** Operations marked `readOnly: false` and not destructive. Default `allow`. */
    write?: Decision;
    /** Operations marked `destructive`. Default `confirm`. */
    destructive?: Decision;
    /** Everything else — actions that say nothing. Default `allow`. */
    unknown?: Decision;
}

/** A default decision from each operation's `readOnly` / `destructive` hints. Always decides. */
export function annotationPolicy(decisions: AnnotationDecisions = {}): OperationPolicy {
    const d = { readOnly: 'allow', write: 'allow', destructive: 'confirm', unknown: 'allow', ...decisions } as const;
    return ({ operation: op }) => {
        if (op.destructive === true) return d.destructive;
        if (op.readOnly ?? (op.kind === 'search' || op.kind === 'options')) return d.readOnly;
        if (op.readOnly === false) return d.write;
        return d.unknown;
    };
}

/**
 * A static table keyed `connector/operation`. Either side may be `*`, and a
 * lone `*` matches everything. The most specific key wins — exact, then any
 * operation of the connector, then the operation id on any connector, then
 * `*`. No matching key abstains.
 */
export function operationRules(rules: Record<string, Decision | PolicyVerdict>): OperationPolicy {
    const table = new Map<string, PolicyVerdict>();
    for (const [key, value] of Object.entries(rules)) {
        if (key !== '*' && (key === '*/*' || !/^[^/]+\/[^/]+$/.test(key))) {
            throw new ConduitError('policy_invalid', `policy rule "${key}" must be "connector/operation", "connector/*", "*/operation" or "*"`);
        }
        table.set(key, verdict(value)!);
    }
    return ({ connector, operation }) =>
        table.get(`${connector}/${operation.id}`) ?? table.get(`${connector}/*`) ?? table.get(`*/${operation.id}`) ?? table.get('*');
}
