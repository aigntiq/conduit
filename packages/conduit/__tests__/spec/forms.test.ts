import { describe, expect, it } from 'vitest';
import {
    buildForm,
    createConduit,
    evaluateCondition,
    inferWidget,
    memorySource,
    prepareForm,
    validateConnector,
    validateForm,
    type ConnectorSpec,
    type InputProperty,
    type InputSchema
} from '@aigntiq/conduit';

const message: InputSchema = {
    type: 'object',
    properties: {
        to: { type: 'array', items: { type: 'string', format: 'email' }, 'x-group': 'Recipients' },
        cc: { type: 'array', items: { type: 'string', format: 'email' }, 'x-group': 'Recipients', 'x-advanced': true },
        subject: { type: 'string', minLength: 1, 'x-order': 1 },
        body: { type: 'string', 'x-widget': 'richtext', 'x-order': 2 },
        mode: { type: 'string', oneOf: [{ const: 'now', title: 'Send now' }, { const: 'later', title: 'Schedule' }], default: 'now' },
        sendAt: {
            type: 'string',
            format: 'date-time',
            'x-visibleWhen': { mode: 'later' },
            'x-requiredWhen': { mode: 'later' },
            'x-errorMessage': { required: 'Pick when to send it' }
        },
        priority: { type: 'integer', minimum: 1, maximum: 5, 'x-advanced': true }
    },
    required: ['subject'],
    'x-rules': [{ check: '{{ length(inputs.to) > 0 || length(inputs.cc) > 0 }}', message: 'Add at least one recipient', fields: ['to', 'cc'] }]
};

describe('widget inference', () => {
    it.each<[InputProperty, string]>([
        [{ type: 'string' }, 'text'],
        [{ type: 'string', format: 'email' }, 'email'],
        [{ type: 'string', format: 'uri' }, 'url'],
        [{ type: 'string', format: 'date' }, 'date'],
        [{ type: 'string', format: 'date-time' }, 'datetime'],
        [{ type: 'string', format: 'password' }, 'password'],
        [{ type: 'string', 'x-secret': true }, 'password'],
        [{ type: 'string', enum: ['a', 'b'] }, 'select'],
        [{ type: 'string', 'x-options': { operation: 'o' } }, 'select'],
        [{ type: 'string', 'x-options': { operation: 'o', search: 'q' } }, 'combobox'],
        [{ type: 'integer' }, 'number'],
        [{ type: 'boolean' }, 'toggle'],
        [{ type: 'array', items: { type: 'string', format: 'email' } }, 'emails'],
        [{ type: 'array', items: { type: 'string', enum: ['x'] } }, 'multiselect'],
        [{ type: 'array', items: { type: 'string', 'x-options': { operation: 'o' } } }, 'multiselect'],
        [{ type: 'array', items: { type: 'object', 'x-widget': 'file' } }, 'file'],
        [{ type: 'array', items: { type: 'string' } }, 'list'],
        [{ type: 'object', properties: { a: { type: 'string' } } }, 'fieldset'],
        [{ type: 'object' }, 'keyvalue'],
        [{ type: 'string', 'x-widget': 'code' }, 'code']
    ])('%j → %s', (prop, widget) => {
        expect(inferWidget(prop)).toBe(widget);
    });
});

describe('buildForm', () => {
    const model = buildForm(message);

    it('groups fields: unnamed first, then by first appearance, advanced after regular', () => {
        expect(model.groups.map((g) => [g.name ?? '(default)', g.advanced, g.fields.map((f) => f.name)])).toEqual([
            ['(default)', false, ['subject', 'body', 'mode', 'sendAt']],
            ['(default)', true, ['priority']],
            ['Recipients', false, ['to']],
            ['Recipients', true, ['cc']]
        ]);
    });

    it('normalises every field', () => {
        const fields = model.groups.flatMap((g) => g.fields);
        const by = (name: string) => fields.find((f) => f.name === name)!;
        expect(by('subject')).toMatchObject({ label: 'Subject', widget: 'text', required: true, constraints: { minLength: 1 } });
        expect(by('mode')).toMatchObject({ widget: 'select', default: 'now', choices: [{ value: 'now', label: 'Send now' }, { value: 'later', label: 'Schedule' }] });
        expect(by('sendAt')).toMatchObject({ label: 'Send at', widget: 'datetime', required: false, requiredWhen: { mode: 'later' }, visibleWhen: { mode: 'later' } });
        expect(by('to')).toMatchObject({ widget: 'emails', multiple: true, item: { path: 'to.[]', widget: 'email' } });
        expect(model.rules).toHaveLength(1);
        // The model is plain data.
        expect(JSON.parse(JSON.stringify(model))).toEqual(model);
    });

    it('describes nested objects and option sources', () => {
        const nested = buildForm({
            type: 'object',
            properties: {
                label: { type: 'string', 'x-options': { operation: 'list-labels', dependsOn: ['account'], search: 'q' } },
                address: { type: 'object', properties: { city: { type: 'string' }, zip: { type: 'string', 'x-order': 0 } }, required: ['city'] }
            }
        });
        const [label, address] = nested.groups[0]!.fields;
        expect(label!.options).toEqual({ operation: 'list-labels', dependsOn: ['account'], search: 'q' });
        expect(address!.fields!.map((f) => [f.path, f.required])).toEqual([
            ['address.zip', false],
            ['address.city', true]
        ]);
    });
});

describe('conditions', () => {
    it('is three-valued when bound fields decide it', () => {
        const values = { mode: 'later', cc: [] };
        expect(evaluateCondition({ mode: 'later' }, values)).toBe(true);
        expect(evaluateCondition({ mode: { in: ['now', 'soon'] } }, values)).toBe(false);
        expect(evaluateCondition({ cc: { empty: true } }, values)).toBe(true);
        expect(evaluateCondition({ cc: { notEmpty: true } }, values)).toBe(false);
        expect(evaluateCondition({ mode: 'later', other: 1 }, values, (n) => n === 'other')).toBeUndefined();
        expect(evaluateCondition({ mode: 'now', other: 1 }, values, (n) => n === 'other')).toBe(false);
    });
});

describe('prepareForm', () => {
    it('drops hidden fields and enforces conditional requirements', async () => {
        const hidden = await prepareForm(message, { subject: 'Hi', to: ['a@b.co'], sendAt: 'stale' });
        expect(hidden.issues).toEqual([]);
        expect(hidden.value).toEqual({ subject: 'Hi', to: ['a@b.co'], mode: 'now' });

        const shown = await prepareForm(message, { subject: 'Hi', to: ['a@b.co'], mode: 'later' });
        expect(shown.issues).toEqual([{ path: 'inputs.sendAt', code: 'required', message: 'Pick when to send it' }]);
    });

    it('runs cross-field rules and checks formats', async () => {
        expect(await validateForm(message, { subject: 'Hi' })).toEqual([
            { path: 'inputs.to', code: 'rule', message: 'Add at least one recipient', params: { fields: ['to', 'cc'] } }
        ]);
        expect(await validateForm(message, { subject: 'Hi', to: ['not-an-address'] })).toEqual([
            { path: 'inputs.to[0]', code: 'format', params: { format: 'email' }, message: 'must be an email address' }
        ]);
        expect(await validateForm(message, { subject: 'Hi', to: ['a@b.co'], mode: 'later', sendAt: 'tomorrow' })).toMatchObject([
            { path: 'inputs.sendAt', code: 'format' }
        ]);
    });

    it('defers everything a bound field decides', async () => {
        // `to` and `mode` will come from upstream steps: they count as present,
        // the rule that reads `to` waits, and `sendAt`'s condition is unknown —
        // so it stays visible but is not required.
        const { issues, value } = await prepareForm(message, { subject: 'Hi', sendAt: '2026-10-01T09:00:00Z' }, { bound: ['to', 'mode'] });
        expect(issues).toEqual([]);
        expect(value.sendAt).toBe('2026-10-01T09:00:00Z');

        // A bound required field is satisfied.
        expect(await validateForm(message, {}, { bound: ['subject', 'to'] })).toEqual([]);
    });

    it('validates arrays of objects item by item', async () => {
        const schema: InputSchema = {
            type: 'object',
            properties: {
                lines: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } }, required: ['sku'] }
                }
            }
        };
        expect((await validateForm(schema, { lines: [{ sku: 'a', qty: '2' }, { qty: 0 }] })).map((i) => [i.path, i.code])).toEqual([
            ['inputs.lines[1].sku', 'required'],
            ['inputs.lines[1].qty', 'minimum']
        ]);
        expect((await validateForm(schema, { lines: [] })).map((i) => i.code)).toEqual(['minItems']);
    });
});

describe('client and server agree', () => {
    it('produces the same issues from validateForm and from execute', async () => {
        const spec: ConnectorSpec = {
            spec: 'conduit/1',
            id: 'mail',
            name: 'Mail',
            version: '1.0.0',
            http: { baseUrl: 'https://mail.example' },
            operations: [{ id: 'send', kind: 'action', label: 'Send', inputs: message, request: { method: 'POST', url: '/send', body: '{{inputs}}' } }]
        };
        const sent: unknown[] = [];
        const conduit = createConduit({
            sources: memorySource([spec]),
            secret: 'forms-test-secret-that-is-long-enough!',
            http: async (r) => {
                sent.push(await r.json());
                return Response.json({ ok: true });
            }
        });
        const inputs = { subject: 'Hi', mode: 'later', to: ['bad'] };
        const model = await conduit.connectors.form('mail', { operation: 'send' });
        const clientIssues = await validateForm(model, inputs);
        const serverIssues = await conduit.execute({ connector: 'mail', operation: 'send', inputs }).catch((e: { issues: unknown }) => e.issues);
        expect(serverIssues).toEqual(clientIssues);
        expect(clientIssues.map((i) => i.path).sort()).toEqual(['inputs.sendAt', 'inputs.to[0]']);

        // And a hidden field is never sent.
        await conduit.execute({ connector: 'mail', operation: 'send', inputs: { subject: 'Hi', to: ['a@b.co'], sendAt: 'stale' } });
        expect(sent).toEqual([{ subject: 'Hi', to: ['a@b.co'], mode: 'now' }]);
    });
});

describe('spec checks for forms', () => {
    const withInputs = (inputs: InputSchema): ConnectorSpec => ({
        spec: 'conduit/1',
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        http: { baseUrl: 'https://demo.example' },
        operations: [
            { id: 'act', kind: 'action', label: 'Act', inputs, request: { url: '/' } },
            {
                id: 'labels',
                kind: 'options',
                label: 'Labels',
                inputs: { type: 'object', properties: { query: { type: 'string' } } },
                request: { url: '/labels' }
            }
        ]
    });
    const errors = (inputs: InputSchema) =>
        validateConnector(withInputs(inputs))
            .diagnostics.filter((d) => d.severity === 'error')
            .map((d) => [d.path, d.code]);

    it('accepts the full vocabulary', () => {
        expect(errors(message)).toEqual([]);
    });

    it('rejects conditions, dependencies and rules that point nowhere', () => {
        expect(
            errors({
                type: 'object',
                properties: {
                    a: { type: 'string', 'x-visibleWhen': { ghost: 1 }, 'x-requiredWhen': { b: 1 } },
                    b: { type: 'string', 'x-options': { operation: 'labels', dependsOn: ['nope'], search: 'q' } }
                },
                'x-rules': [{ check: '{{ inputs.a +}}', message: 'm', fields: ['zzz'] }]
            })
        ).toEqual([
            ['operations[0].inputs.properties.a.x-visibleWhen.ghost', 'condition_unknown'],
            ['operations[0].inputs.properties.b.x-options.search', 'input_unknown'],
            ['operations[0].inputs.properties.b.x-options.dependsOn', 'input_unknown'],
            ['operations[0].inputs.x-rules[0].check', 'expression_invalid'],
            ['operations[0].inputs.x-rules[0].fields', 'input_unknown']
        ]);
    });

    it('rejects widgets that cannot render the type, bad defaults and unknown hint keys', () => {
        expect(
            errors({
                type: 'object',
                properties: {
                    a: { type: 'string', 'x-widget': 'toggle' },
                    b: { type: 'integer', minimum: 5, default: 1 },
                    c: { type: 'string', oneOf: [{ const: 'x' }], default: 'y' }
                }
            })
        ).toEqual([
            ['operations[0].inputs.properties.a.x-widget', 'widget_type'],
            ['operations[0].inputs.properties.b.default', 'default_invalid'],
            ['operations[0].inputs.properties.c.default', 'default_invalid']
        ]);
        const typo = withInputs({ type: 'object', properties: { a: { type: 'string', 'x-visiblewhen': {} } as InputProperty } });
        expect(validateConnector(typo).diagnostics.map((d) => [d.path, d.code])).toEqual([['operations[0].inputs.properties.a.x-visiblewhen', 'schema']]);
    });
});
