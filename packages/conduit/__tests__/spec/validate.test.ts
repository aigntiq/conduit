import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConduitSpecError, assertValidConnector, validateConnector, type ConnectorSpec } from '@sigx/conduit';
import { conduitSchema } from '@sigx/conduit/schema';
import { fileSource } from '@sigx/conduit/node';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'connectors');

const base = (): ConnectorSpec => ({
    spec: 'conduit/1',
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    http: { baseUrl: 'https://api.demo.example' },
    auth: [{ id: 'key', type: 'apiKey', name: 'X-Key' }],
    operations: [{ id: 'ping', kind: 'action', label: 'Ping', request: { url: '/ping' } }]
});

const errorsOf = (spec: unknown) =>
    validateConnector(spec)
        .diagnostics.filter((d) => d.severity === 'error')
        .map((d) => [d.path, d.code]);

describe('the fixtures', () => {
    it('all validate cleanly — no errors, no warnings', async () => {
        const specs = await fileSource(FIXTURES).list();
        expect(specs.map((s) => s.id).sort()).toEqual(['acme-crm', 'weather']);
        for (const spec of specs) {
            expect(validateConnector(spec).diagnostics, spec.id).toEqual([]);
        }
    });
});

describe('the published JSON Schema', () => {
    it('is in sync with the TypeScript source (run `pnpm gen:schema`)', () => {
        const file = JSON.parse(readFileSync(join(__dirname, '..', '..', 'schema', 'conduit-1.schema.json'), 'utf8'));
        expect(file).toEqual(JSON.parse(JSON.stringify(conduitSchema)));
    });
});

describe('structural validation', () => {
    it('accepts the minimal spec', () => {
        expect(validateConnector(base())).toEqual({ valid: true, diagnostics: [] });
    });

    it('reports missing and unknown top-level fields', () => {
        const { name: _name, ...noName } = base();
        expect(errorsOf(noName)).toEqual([['name', 'schema']]);
        expect(errorsOf({ ...base(), colour: 'blue' })).toEqual([['colour', 'schema']]);
        expect(errorsOf({ ...base(), spec: 'conduit/2' })).toEqual([['spec', 'schema']]);
    });

    it('selects auth method branches by their type tag', () => {
        const spec = { ...base(), auth: [{ id: 'x', type: 'magic' }] };
        const [d] = validateConnector(spec).diagnostics;
        expect(d).toMatchObject({ path: 'auth[0].type', message: expect.stringContaining('"oauth2"') });

        const oauth = { ...base(), auth: [{ id: 'o', type: 'oauth2', authorizeUrl: 'https://a.example' }] };
        expect(errorsOf(oauth)).toEqual([['auth[0].tokenUrl', 'schema']]);
    });

    it('selects operation branches by kind', () => {
        const spec = { ...base(), operations: [{ id: 'p', kind: 'action', label: 'P', paginate: { style: 'cursor', items: 'x' }, request: { url: '/' } }] };
        expect(errorsOf(spec)).toEqual([['operations[0].paginate', 'schema']]);
    });

    it('validates ids, versions and the retry policy', () => {
        expect(errorsOf({ ...base(), id: 'Bad Id' })).toEqual([['id', 'schema']]);
        expect(errorsOf({ ...base(), version: 'v1' })).toEqual([['version', 'schema']]);
        expect(errorsOf({ ...base(), http: { retry: { attempts: 50 } } })).toEqual([['http.retry.attempts', 'schema']]);
    });
});

describe('semantic validation', () => {
    it('rejects duplicate ids', () => {
        const spec = base();
        spec.operations.push({ ...spec.operations[0]! });
        spec.auth!.push({ id: 'key', type: 'basic' });
        expect(errorsOf(spec)).toEqual([
            ['operations[1].id', 'duplicate_operation'],
            ['auth[1].id', 'duplicate_auth']
        ]);
    });

    it('checks references to auth methods and options operations', () => {
        const spec = base();
        spec.operations[0] = {
            id: 'ping',
            kind: 'action',
            label: 'Ping',
            auth: ['nope'],
            inputs: {
                type: 'object',
                properties: {
                    a: { type: 'string', 'x-options': { operation: 'missing' } },
                    b: { type: 'string', 'x-options': { operation: 'ping' } }
                },
                required: ['a', 'c']
            },
            request: { url: '/ping' }
        };
        expect(errorsOf(spec)).toEqual([
            ['operations[0].auth[0]', 'auth_unknown'],
            ['operations[0].inputs.required', 'input_unknown'],
            ['operations[0].inputs.properties.a.x-options.operation', 'operation_unknown'],
            ['operations[0].inputs.properties.b.x-options.operation', 'operation_kind']
        ]);
    });

    it('parses every template and resolves every function', () => {
        const spec = base();
        spec.operations[0] = {
            id: 'ping',
            kind: 'action',
            label: 'Ping',
            request: { url: '/ping/{{inputs.id +}}', headers: { 'X-A': '{{ shout(inputs.a) }}' } },
            output: '{{ response.body | map(x => x.id) }}'
        };
        expect(errorsOf(spec)).toEqual([
            ['operations[0].request.url', 'expression_invalid'],
            ['operations[0].request.headers.X-A', 'expression_invalid']
        ]);
    });

    it('accepts connector functions and host functions', () => {
        const spec = base();
        spec.functions = { shout: { params: ['s'], body: "upper(s) + '!'" } };
        spec.operations[0]!.output = '{{ shout(response.body.msg) | hostFn }}';
        expect(errorsOf(spec)).toEqual([['operations[0].output', 'expression_invalid']]);
        expect(validateConnector(spec, { functions: new Set(['hostFn']) }).valid).toBe(true);
    });

    it('warns when a template reads something unavailable where it sits', () => {
        const spec = base();
        spec.http!.headers = { 'X-Status': '{{response.status}}' };
        const [d] = validateConnector(spec).diagnostics;
        expect(d).toMatchObject({ path: 'http.headers.X-Status', code: 'expression_scope', severity: 'warning' });
        expect(validateConnector(spec).valid).toBe(true);
    });

    it('checks connector function bodies', () => {
        const spec = { ...base(), functions: { bad: { params: ['x'], body: 'x +' }, loose: { params: ['x'], body: 'x + y' } } };
        const diagnostics = validateConnector(spec).diagnostics;
        expect(diagnostics.map((d) => [d.path, d.severity])).toEqual([
            ['functions.bad.body', 'error'],
            ['functions.loose.body', 'warning']
        ]);
    });

    it('checks oauth2 grants', () => {
        const spec = { ...base(), auth: [{ id: 'o', type: 'oauth2' as const, tokenUrl: 'https://t.example' }] };
        expect(errorsOf(spec)).toEqual([['auth[0].authorizeUrl', 'oauth_authorize_missing']]);
        spec.auth[0] = { ...spec.auth[0]!, grant: 'client_credentials' } as never;
        expect(errorsOf(spec)).toEqual([]);
    });

    it('checks pagination needs', () => {
        const spec = base();
        spec.operations[0] = { id: 'list', kind: 'search', label: 'L', request: { url: '/l' }, paginate: { style: 'cursor', items: '{{response.body}}' } };
        expect(errorsOf(spec)).toEqual([
            ['operations[0].paginate.next', 'paginate_next_missing'],
            ['operations[0].paginate.param', 'paginate_param_missing']
        ]);
    });

    it('rejects a literal baseUrl that is not absolute http(s), and invalid methods', () => {
        const spec = base();
        spec.http = { baseUrl: 'ftp://files.example' };
        spec.operations[0]!.kind === 'action' && (spec.operations[0]!.request.method = 'FETCH');
        expect(errorsOf(spec)).toEqual([
            ['http.baseUrl', 'base_url_invalid'],
            ['operations[0].request.method', 'method_invalid']
        ]);
    });
});

describe('request encodings', () => {
    it('accepts built-ins and host-registered encodings only', () => {
        const spec = base();
        if (spec.operations[0]!.kind === 'action') spec.operations[0]!.request = { url: '/p', method: 'POST', body: {}, encoding: 'csv' };
        expect(errorsOf(spec)).toEqual([['operations[0].request.encoding', 'encoding_unknown']]);
        expect(validateConnector(spec, { encodings: ['csv'] }).valid).toBe(true);
    });
});

describe('assertValidConnector', () => {
    it('throws a ConduitSpecError that lists the errors', () => {
        const spec = { ...base(), operations: [{ id: 'ping', kind: 'action', label: 'Ping', request: { url: '{{ 1 + }}' } }] };
        let err: unknown;
        try {
            assertValidConnector(spec);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(ConduitSpecError);
        expect((err as Error).message).toMatch(/connector "demo" is invalid \(1 error\)\n {2}operations\[0\]\.request\.url:/);
        expect((err as ConduitSpecError).diagnostics).toHaveLength(1);
    });
});
