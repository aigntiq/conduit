import { describe, expect, it } from 'vitest';
import { ConduitValidationError, assertInputs, authInputs, prepareInputs, secretInputNames, type InputSchema } from '@sigx/conduit';

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
    it('applies defaults and coerces form strings toward the declared type', () => {
        const { value, issues } = prepareInputs(schema, {
            email: 'a@b.c',
            ratio: '0.5',
            active: 'false',
            tags: ['1', '2'],
            address: { city: 'Oslo' },
            extra: 'kept'
        });
        expect(issues).toEqual([]);
        expect(value).toEqual({
            email: 'a@b.c',
            count: 10,
            ratio: 0.5,
            active: false,
            tags: [1, 2],
            address: { city: 'Oslo', zip: 1000 },
            extra: 'kept'
        });
    });

    it('treats an empty string as missing for non-string fields', () => {
        expect(prepareInputs(schema, { email: 'a@b.c', count: '' }).value.count).toBe(10);
    });

    it('does not mutate defaults across calls', () => {
        const s: InputSchema = { type: 'object', properties: { list: { type: 'array', default: [] } } };
        const a = prepareInputs(s, {}).value.list as unknown[];
        a.push(1);
        expect(prepareInputs(s, {}).value.list).toEqual([]);
    });

    it('reports every issue with a path', () => {
        const { issues } = prepareInputs(schema, { count: 'many', kind: 'z', address: {}, tags: ['x'] });
        expect(issues.map((i) => i.path).sort()).toEqual([
            'inputs.address.city',
            'inputs.count',
            'inputs.email',
            'inputs.kind',
            'inputs.tags[0]'
        ]);
    });

    it('rejects non-object inputs', () => {
        expect(prepareInputs(schema, 'nope').issues).toEqual([{ path: '', message: 'inputs must be an object' }]);
    });

    it('passes inputs through untouched without a schema', () => {
        expect(prepareInputs(undefined, { a: '1' })).toEqual({ value: { a: '1' }, issues: [] });
    });
});

describe('assertInputs', () => {
    it('throws a ConduitValidationError with the issues', () => {
        expect(() => assertInputs(schema, {})).toThrow(ConduitValidationError);
        try {
            assertInputs(schema, {});
        } catch (e) {
            expect((e as ConduitValidationError).issues).toEqual([{ path: 'inputs.email', message: 'is required' }]);
        }
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
