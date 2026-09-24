import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildForm, createConduit, memorySource, prepareForm, validateConnector, validateForm, type CatalogOf, type ConnectorSpec } from '@aigntiq/conduit';
import {
    $,
    action,
    boolean,
    connector,
    emails,
    emitTypes,
    expr,
    file,
    files,
    integer,
    json,
    object,
    ref,
    rules,
    select,
    string,
    toTemplate,
    when
} from '@aigntiq/conduit/builder';
import { fileSource } from '@aigntiq/conduit/node';
import { acme } from './acme';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'connectors');

describe('refs and templates', () => {
    it('serialise refs, interpolations and expressions', () => {
        const inputs = ref<{ id: string; tags: string[] }>('inputs');
        const response = ref('response');
        expect(toTemplate({ a: inputs.id, b: inputs.tags[0], c: response.body['odd-key'], skip: undefined })).toEqual({
            a: '{{inputs.id}}',
            b: '{{inputs.tags[0]}}',
            c: '{{response.body["odd-key"]}}'
        });
        expect($`/users/${inputs.id}/x?n=${2}`).toBe('/users/{{inputs.id}}/x?n=2');
        expect(toTemplate(expr`${inputs.tags} | join(${', '})`)).toBe('{{inputs.tags | join(", ")}}');
        expect(toTemplate(expr`first(${expr`${inputs.tags} | reverse`})`)).toBe('{{first((inputs.tags | reverse))}}');
        expect(`${inputs.id}`).toBe('{{inputs.id}}');
    });
});

describe('the Acme connector, rebuilt with the builder', () => {
    it('compiles to exactly the hand-written fixture JSON', async () => {
        const fixture = (await fileSource(FIXTURES).get('acme-crm'))!;
        const { $schema: _s, icon: _i, ...expected } = fixture as ConnectorSpec & { $schema?: string };
        expect(JSON.parse(JSON.stringify(acme))).toEqual(JSON.parse(JSON.stringify(expected)));
    });

    it('validates cleanly', () => {
        expect(validateConnector(acme).diagnostics).toEqual([]);
    });
});

describe('fields', () => {
    it('compile every hint and constraint', () => {
        const built = action('send', {
            label: 'Send',
            group: 'Messages',
            destructive: false,
            readOnly: false,
            inputs: {
                to: emails({ title: 'To', group: 'Recipients', minItems: 1 }),
                cc: emails({ group: 'Recipients', advanced: true }).optional(),
                kind: select({ now: 'Send now', later: 'Schedule' }, { default: 'now' }),
                sendAt: string({ format: 'date-time', visibleWhen: when.equals('kind', 'later'), requiredWhen: when.equals('kind', 'later') }).optional(),
                attachment: file({ accept: 'image/*', maxBytes: 1000 }).optional(),
                many: files({ maxItems: 3 }).optional(),
                count: integer({ minimum: 1, messages: { minimum: 'At least one' } }).optional(),
                urgent: boolean().optional(),
                address: object({ city: string(), zip: string().optional() }).optional()
            },
            rules: [rules.atLeastOne(['to', 'cc'])],
            request: ({ inputs }) => ({ method: 'POST', url: '/send', body: { to: inputs.to, when: inputs.sendAt } })
        });
        const inputs = built.spec.inputs!;
        expect(inputs.required).toEqual(['to', 'kind']);
        expect(inputs.properties.to).toEqual({ type: 'array', title: 'To', 'x-group': 'Recipients', minItems: 1, items: { type: 'string', format: 'email' } });
        expect(inputs.properties.kind).toEqual({ type: 'string', default: 'now', oneOf: [{ const: 'now', title: 'Send now' }, { const: 'later', title: 'Schedule' }] });
        expect(inputs.properties.sendAt).toMatchObject({ 'x-visibleWhen': { kind: 'later' }, 'x-requiredWhen': { kind: 'later' } });
        expect(inputs.properties.attachment).toMatchObject({ 'x-widget': 'file', 'x-accept': 'image/*', 'x-maxBytes': 1000 });
        expect(inputs.properties.many).toMatchObject({ type: 'array', maxItems: 3, items: { 'x-widget': 'file' } });
        expect(inputs.properties.count).toEqual({ type: 'integer', minimum: 1, 'x-errorMessage': { minimum: 'At least one' } });
        expect(inputs.properties.address).toEqual({ type: 'object', properties: { city: { type: 'string' }, zip: { type: 'string' } }, required: ['city'] });
        expect(inputs['x-rules']).toEqual([{ check: '{{ !isEmpty(inputs.to) || !isEmpty(inputs.cc) }}', message: 'Fill in at least one of: to, cc', fields: ['to', 'cc'] }]);
        expect(built.spec).toMatchObject({ group: 'Messages', destructive: false, readOnly: false, request: { body: { to: '{{inputs.to}}', when: '{{inputs.sendAt}}' } } });
    });
});

describe('json fields', () => {
    const op = action('write', {
        label: 'Write',
        inputs: {
            settings: json<Record<string, unknown>>().optional(),
            rows: json<unknown[]>({ type: 'array', title: 'Rows' })
        },
        request: { method: 'POST', url: '/write' }
    });

    it('hold an object by default, or a list', () => {
        expect(op.spec.inputs!.properties.settings).toEqual({ type: 'object', 'x-widget': 'json' });
        expect(op.spec.inputs!.properties.rows).toEqual({ type: 'array', title: 'Rows', 'x-widget': 'json' });
    });

    it('take a list of mixed rows, and wrap a single row or parse JSON text as a list', async () => {
        const model = buildForm(op.spec.inputs!);
        expect(model.groups[0]!.fields.map((f) => `${f.name}:${f.widget}`)).toEqual(['settings:json', 'rows:json']);
        expect(await validateForm(model, { rows: [['Ada', 36], { Name: 'Grace' }] })).toEqual([]);
        expect((await prepareForm(model, { rows: { Name: 'Grace' } })).value.rows).toEqual([{ Name: 'Grace' }]);
        expect((await prepareForm(model, { rows: '[["Ada", 36]]' })).value.rows).toEqual([['Ada', 36]]);
    });
});

describe('forEach steps', () => {
    it('compile forEach and maxIterations, with each and index as refs', () => {
        const op = action('upload', {
            label: 'Upload',
            inputs: { file: file() },
            steps: ({ inputs, each, index, response }) => [
                {
                    name: 'parts',
                    forEach: expr`chunks(${inputs.file.base64}, 3)`,
                    maxIterations: 50,
                    method: 'PUT',
                    url: '/part',
                    headers: { 'Content-Range': $`bytes ${each.start}-${each.end}/${each.total}` },
                    body: each.base64,
                    encoding: 'binary',
                    output: { index, status: response.status }
                }
            ],
            request: ({ steps }) => ({ method: 'POST', url: '/done', body: { parts: steps.parts } })
        });
        expect(op.spec.steps).toEqual([
            {
                name: 'parts',
                forEach: '{{chunks(inputs.file.base64, 3)}}',
                maxIterations: 50,
                method: 'PUT',
                url: '/part',
                headers: { 'Content-Range': 'bytes {{each.start}}-{{each.end}}/{{each.total}}' },
                body: '{{each.base64}}',
                encoding: 'binary',
                output: { index: '{{index}}', status: '{{response.status}}' }
            }
        ]);
    });
});

describe('types', () => {
    it('infers input and output types and types execute through a catalog', async () => {
        const mini = connector({
            id: 'mini',
            name: 'Mini',
            version: '1.0.0',
            http: { baseUrl: 'https://mini.example' },
            operations: [
                action('greet', {
                    label: 'Greet',
                    inputs: { name: string(), shout: boolean().optional() },
                    outputs: object({ message: string() }),
                    request: ({ inputs }) => ({ url: $`/greet/${inputs.name}` }),
                    output: ({ response }) => ({ message: response.body.text })
                })
            ]
        });

        expectTypeOf<NonNullable<(typeof mini)['~types']>['greet']['inputs']>().toEqualTypeOf<{ name: string; shout?: boolean }>();
        expectTypeOf<NonNullable<(typeof mini)['~types']>['greet']['output']>().toEqualTypeOf<{ message: string }>();

        const conduit = createConduit<CatalogOf<typeof mini>>({
            sources: memorySource([mini]),
            secret: 'builder-test-secret-that-is-long-enough',
            http: async (r) => Response.json({ text: `hi ${new URL(r.url).pathname.split('/').pop()}` })
        });
        const { output } = await conduit.execute({ connector: 'mini', operation: 'greet', inputs: { name: 'ada' } });
        expectTypeOf(output).toEqualTypeOf<{ message: string }>();
        expect(output).toEqual({ message: 'hi ada' });

        // @ts-expect-error — unknown operation
        void (() => conduit.execute({ connector: 'mini', operation: 'nope', inputs: {} }));
        // @ts-expect-error — required input missing
        void (() => conduit.execute({ connector: 'mini', operation: 'greet', inputs: {} }));
        // @ts-expect-error — wrong input type
        void (() => conduit.execute({ connector: 'mini', operation: 'greet', inputs: { name: 1 } }));

        action('typo', {
            label: 'Typo',
            inputs: { name: string() },
            // @ts-expect-error — a misspelled input is a compile error
            request: ({ inputs }) => ({ url: $`/x/${inputs.nmae}` })
        });
    });

    it('emits a declaration file for JSON-shipped connectors', () => {
        const dts = emitTypes(acme);
        expect(dts).toContain("readonly id: \"acme-crm\"; readonly '~types'?: Operations");
        expect(dts).toContain(`'create-contact': {`.replace(/'/g, '"'));
        expect(dts).toMatch(/email: string;\s+firstName\?: string;/);
        expect(dts).toContain('"list-owners": {\n        inputs: Record<string, never>;\n        output: Array<{ label: string; value: unknown }>;');
        expect(dts).toMatch(/tags\?: Array<string>;/);
    });
});
