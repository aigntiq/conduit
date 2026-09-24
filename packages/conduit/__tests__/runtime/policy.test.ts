import { afterEach, describe, expect, it } from 'vitest';
import {
    annotationPolicy,
    ConduitError,
    ConduitPolicyError,
    definePlugin,
    evaluatePolicy,
    firstOf,
    operationRules,
    strictest,
    type ExecuteEvent,
    type OperationDescription,
    type PolicyContext
} from '@aigntiq/conduit';
import { harness, type Harness } from './helpers';

const op = (extra: Partial<OperationDescription> = {}): OperationDescription => ({ id: 'op', kind: 'action', label: 'Op', auth: false, hidden: false, ...extra });
const ctx = (extra: Partial<OperationDescription> = {}, connector = 'svc'): PolicyContext => ({ connector, operation: op(extra) });

describe('policy helpers', () => {
    it('evaluatePolicy treats an abstention as allow and keeps the reason', async () => {
        expect(await evaluatePolicy(() => undefined, ctx())).toEqual({ decision: 'allow' });
        expect(await evaluatePolicy(async () => ({ decision: 'deny', reason: 'no' }), ctx())).toEqual({ decision: 'deny', reason: 'no' });
    });

    it('rejects a decision it does not know', async () => {
        await expect(evaluatePolicy(() => 'maybe' as never, ctx())).rejects.toMatchObject({ code: 'policy_invalid' });
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        for (const bad of [10n, circular]) await expect(evaluatePolicy(() => bad as never, ctx())).rejects.toMatchObject({ code: 'policy_invalid' });
    });

    it('strictest lets deny beat confirm beat allow, and skips abstentions', async () => {
        const run = (...answers: (string | undefined)[]) => evaluatePolicy(strictest(...answers.map((a) => () => a as never)), ctx());
        expect(await run('allow', 'confirm', 'allow')).toEqual({ decision: 'confirm' });
        expect(await run('confirm', { decision: 'deny', reason: 'r' } as never, 'allow')).toEqual({ decision: 'deny', reason: 'r' });
        expect(await run(undefined, 'allow')).toEqual({ decision: 'allow' });
        expect(await strictest(() => undefined)(ctx())).toBeUndefined();
    });

    it('strictest stops asking once something denies', async () => {
        let asked = false;
        await strictest(() => 'deny', () => ((asked = true), 'allow'))(ctx());
        expect(asked).toBe(false);
    });

    it('firstOf takes the first opinion — an override can loosen a default', async () => {
        const p = firstOf(operationRules({ 'svc/op': 'allow' }), annotationPolicy());
        expect(await evaluatePolicy(p, ctx({ destructive: true }))).toEqual({ decision: 'allow' });
        expect(await evaluatePolicy(p, ctx({ id: 'other', destructive: true }))).toEqual({ decision: 'confirm' });
    });

    it('annotationPolicy maps the hints, with configurable decisions', async () => {
        const p = annotationPolicy();
        expect(await p(ctx({ destructive: true }))).toBe('confirm');
        expect(await p(ctx({ readOnly: true }))).toBe('allow');
        expect(await p(ctx({ kind: 'search' }))).toBe('allow');
        const strict = annotationPolicy({ write: 'confirm', unknown: 'deny', destructive: 'deny' });
        expect(await strict(ctx({ readOnly: false }))).toBe('confirm');
        expect(await strict(ctx())).toBe('deny');
        expect(await strict(ctx({ kind: 'search', readOnly: false }))).toBe('confirm');
        expect(await strict(ctx({ kind: 'options' }))).toBe('allow');
    });

    it('operationRules picks the most specific key and abstains when nothing matches', async () => {
        const p = operationRules({ '*': 'deny', '*/op': 'confirm', 'svc/*': 'allow', 'svc/op': { decision: 'deny', reason: 'exact' } });
        expect(await p(ctx())).toEqual({ decision: 'deny', reason: 'exact' });
        expect(await p(ctx({ id: 'x' }))).toEqual({ decision: 'allow' });
        expect(await p(ctx({}, 'other'))).toEqual({ decision: 'confirm' });
        expect(await p(ctx({ id: 'x' }, 'other'))).toEqual({ decision: 'deny' });
        expect(await operationRules({ 'svc/op': 'deny' })(ctx({ id: 'x' }))).toBeUndefined();
    });

    it('operationRules rejects malformed keys and decisions', () => {
        expect(() => operationRules({ svc: 'deny' })).toThrow(ConduitError);
        expect(() => operationRules({ '*/*': 'deny' })).toThrow(/connector\/operation/);
        expect(() => operationRules({ 'svc/op': 'nope' as never })).toThrow(/policy returned/);
    });
});

let h: Harness;
afterEach(async () => {
    await h?.close();
});

describe('the policy gate in execute', () => {
    it('without a policy, every call runs as before', async () => {
        h = await harness();
        const account = await h.connectOAuth();
        const { output } = await h.conduit.execute({ connector: 'acme-crm', operation: 'get-contact', account, inputs: { id: 'c2' } });
        expect(output).toMatchObject({ id: 'c2' });
        expect(await h.conduit.decide({ connector: 'acme-crm', operation: 'create-contact' })).toEqual({ decision: 'allow' });
    });

    it('a denied call sends nothing and renews nothing', async () => {
        const events: ExecuteEvent[] = [];
        h = await harness({
            policy: operationRules({ 'acme-crm/create-contact': { decision: 'deny', reason: 'read-only workspace' } }),
            plugins: [definePlugin({ name: 'spy', setup: (r) => r.onExecute((e) => events.push(e)) })]
        });
        const account = await h.connectOAuth();
        h.clock.now += 2 * 3600_000; // the access token is stale: a call that got through would refresh it
        const before = h.provider.requests.length;

        const err = await h.conduit
            .execute({ connector: 'acme-crm', operation: 'create-contact', account, caller: 'bot-7', inputs: { email: 'ada@example.com' } })
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitPolicyError);
        expect(err).toMatchObject({
            code: 'operation_denied',
            decision: 'deny',
            reason: 'read-only workspace',
            message: 'policy denies "acme-crm/create-contact": read-only workspace',
            details: { connector: 'acme-crm', operation: 'create-contact', account, caller: 'bot-7', reason: 'read-only workspace' }
        });
        expect(h.provider.requests.length).toBe(before);
        expect(events.at(-1)).toMatchObject({ operation: 'create-contact', ok: false, error: { code: 'operation_denied' } });
    });

    it('confirm refuses until the host re-runs the call with confirmed: true', async () => {
        h = await harness({ policy: annotationPolicy({ unknown: 'confirm' }) });
        const account = await h.connectOAuth();
        const call = { connector: 'acme-crm', operation: 'create-contact', account, inputs: { email: 'ada@example.com' } } as const;
        await expect(h.conduit.execute(call)).rejects.toMatchObject({ code: 'confirmation_required', message: '"acme-crm/create-contact" needs confirmation' });
        const { output } = await h.conduit.execute({ ...call, confirmed: true });
        expect(output).toMatchObject({ email: 'ada@example.com' });
    });

    it('confirmed: true never overrides a deny', async () => {
        h = await harness({ policy: () => 'deny' });
        await expect(h.conduit.execute({ connector: 'weather', operation: 'status', confirmed: true })).rejects.toMatchObject({ code: 'operation_denied' });
    });

    it('hands the policy the operation, owner, caller, account and validated inputs', async () => {
        const seen: PolicyContext[] = [];
        h = await harness({ policy: (c) => void seen.push(c) });
        const account = await h.connectOAuth('user-1');
        await h.conduit.execute({ connector: 'acme-crm', operation: 'get-contact', account, caller: 'wf-1', inputs: { id: 'c2' } });
        expect(seen[0]).toMatchObject({
            connector: 'acme-crm',
            operation: { id: 'get-contact', kind: 'action', label: expect.any(String) },
            owner: 'user-1',
            caller: 'wf-1',
            account: { id: account, owner: 'user-1', connector: 'acme-crm' },
            inputs: { id: 'c2' }
        });
        expect(JSON.stringify(seen[0]!.account)).not.toContain('token');
    });

    it('gates options lookups too — the policy sees their kind', async () => {
        h = await harness({ policy: ({ operation }) => (operation.kind === 'options' ? 'deny' : 'allow') });
        const account = await h.connectOAuth();
        await expect(h.conduit.options({ connector: 'acme-crm', operation: 'list-owners', account })).rejects.toMatchObject({ code: 'operation_denied' });
    });

    it('runs the policy after input validation', async () => {
        let asked = 0;
        h = await harness({ policy: () => void asked++ });
        const account = await h.connectOAuth();
        await expect(h.conduit.execute({ connector: 'acme-crm', operation: 'create-contact', account, inputs: { email: 'x' } })).rejects.toMatchObject({ code: 'inputs_invalid' });
        expect(asked).toBe(0);
    });
});

describe('decide', () => {
    it('asks the policy ahead of a call, without inputs', async () => {
        const seen: PolicyContext[] = [];
        h = await harness({
            policy: strictest(
                (c) => void seen.push(c),
                operationRules({ 'acme-crm/create-contact': { decision: 'confirm', reason: 'writes' }, 'acme-crm/list-contacts': 'deny' })
            )
        });
        const account = await h.connectOAuth('user-1');
        expect(await h.conduit.decide({ connector: 'acme-crm', operation: 'create-contact', caller: 'bot', account })).toEqual({ decision: 'confirm', reason: 'writes' });
        expect(await h.conduit.decide({ connector: 'acme-crm', operation: 'list-contacts' })).toEqual({ decision: 'deny' });
        expect(await h.conduit.decide({ connector: 'acme-crm', operation: 'get-contact' })).toEqual({ decision: 'allow' });
        expect(seen[0]).toMatchObject({ caller: 'bot', owner: 'user-1', account: { id: account } });
        expect(seen[0]!.inputs).toBeUndefined();
    });

    it('checks the account belongs to the owner and the connector', async () => {
        h = await harness({ policy: () => 'allow' });
        const account = await h.connectOAuth('user-1');
        await expect(h.conduit.decide({ connector: 'acme-crm', operation: 'get-contact', account, owner: 'someone-else' })).rejects.toBeInstanceOf(ConduitError);
        await expect(h.conduit.decide({ connector: 'weather', operation: 'status', account })).rejects.toMatchObject({ code: 'account_mismatch' });
    });
});
