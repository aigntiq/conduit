import { describe, expect, it } from 'vitest';
import { ConduitValidationError, assertInputs, authInputs, prepareInputs, secretInputNames, type InputSchema } from '@aigntiq/conduit';

const schema: InputSchema = {
    type: 'object',
    properties: {
        email: { type: 'string', format: 'email', minLength: 3 },
        count: { type: 'integer', minimum: 1, default: 10 },
        ratio: { type: 'number' },
        active: { type: 'boolean', default: true },
        kind: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'number' } },
        address: {
            type: 'object',
            properties: { city: { type: 'string' }, zip: { type: 'integer', default: 1000 } },
            required: ['city']
        },
        token: { type: 'string', 'x-secret': true },
        password: { type: 'string', format: 'password' }
    },
    required: ['email']
};

describe('prepareInputs', () => {
    it('applies defaults and coerces form strings toward the declared type', async () => {
        const { value, issues } = await prepareInputs(schema, {
            email: 'a@b.co',
            ratio: '0.5',
            active: 'false',
            tags: ['1', '2'],
            address: { city: 'Oslo' },
            extra: 'kept'
        });
        expect(issues).toEqual([]);
        expect(value).toEqual({
            email: 'a@b.co',
            count: 10,
            ratio: 0.5,
            active: false,
            tags: [1, 2],
            address: { city: 'Oslo', zip: 1000 },
            extra: 'kept'
        });
    });

    it('coerces values resolved from elsewhere: single items into lists, JSON text into structures', async () => {
        const { value, issues } = await prepareInputs(schema, { email: 'a@b.co', tags: '7', address: '{"city":"Rome"}' });
        expect(issues).toEqual([]);
        expect(value.tags).toEqual([7]);
        expect(value.address).toEqual({ city: 'Rome', zip: 1000 });
        expect((await prepareInputs(schema, { email: 'a@b.co', tags: '[1,2]' })).value.tags).toEqual([1, 2]);
    });

    it('treats an empty string as missing for non-string fields', async () => {
        expect((await prepareInputs(schema, { email: 'a@b.co', count: '' })).value.count).toBe(10);
    });

    it('does not mutate defaults across calls', async () => {
        const s: InputSchema = { type: 'object', properties: { list: { type: 'array', default: [] } } };
        const a = (await prepareInputs(s, {})).value.list as unknown[];
        a.push(1);
        expect((await prepareInputs(s, {})).value.list).toEqual([]);
    });

    it('reports one coded issue per field, with a path', async () => {
        const { issues } = await prepareInputs(schema, { count: 'many', kind: 'z', address: {}, tags: ['x'], email: 'nope' });
        expect(issues.map((i) => [i.path, i.code]).sort()).toEqual([
            ['inputs.address.city', 'required'],
            ['inputs.count', 'type'],
            ['inputs.email', 'format'],
            ['inputs.kind', 'enum'],
            ['inputs.tags[0]', 'type']
        ]);
    });

    it('rejects non-object inputs', async () => {
        expect((await prepareInputs(schema, 'nope')).issues).toEqual([{ path: '', code: 'type', message: 'inputs must be an object', params: { expected: ['object'] } }]);
    });

    it('passes inputs through untouched without a schema', async () => {
        expect(await prepareInputs(undefined, { a: '1' })).toEqual({ value: { a: '1' }, issues: [] });
    });
});

describe('assertInputs', () => {
    it('throws a ConduitValidationError with the issues', async () => {
        const err = await assertInputs(schema, {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitValidationError);
        expect((err as ConduitValidationError).issues).toEqual([{ path: 'inputs.email', code: 'required', message: 'is required' }]);
    });
});

describe('auth inputs', () => {
    it('finds secret inputs', () => {
        expect(secretInputNames(schema)).toEqual(['token', 'password']);
    });

    it('supplies conventional defaults per auth type', () => {
        expect(Object.keys(authInputs({ id: 'k', type: 'apiKey', name: 'X' }).properties)).toEqual(['apiKey']);
        expect(authInputs({ id: 'b', type: 'basic' }).required).toEqual(['username', 'password']);
        expect(secretInputNames(authInputs({ id: 't', type: 'bearer' }))).toEqual(['token']);
        expect(authInputs({ id: 'o', type: 'oauth2', tokenUrl: 'https://t' }).properties).toEqual({});
    });
});
