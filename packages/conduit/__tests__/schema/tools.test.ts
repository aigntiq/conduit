import { describe, expect, it } from 'vitest';
import type { ConnectorDescription, InputSchema } from '@aigntiq/conduit';
import { toolDefinitions, toolSchema } from '@aigntiq/conduit/schema';

describe('toolSchema', () => {
    it('drops every x- hint at any depth and keeps standard keywords', () => {
        const inputs: InputSchema = {
            type: 'object',
            properties: {
                to: { type: 'array', title: 'To', 'x-group': 'Recipients', 'x-order': 1, minItems: 1, items: { type: 'string', format: 'email', 'x-placeholder': 'a@b.example' } },
                owner: { type: 'string', readOnly: true, deprecated: true, 'x-options': { operation: 'list-owners' } },
                address: { type: 'object', properties: { city: { type: 'string', 'x-widget': 'text' } }, required: ['city'] },
                file: { type: 'object', 'x-widget': 'file', 'x-maxBytes': 10, properties: { filename: { type: 'string' } } }
            },
            required: ['to'],
            'x-rules': [{ check: '{{ true }}', message: 'never' }]
        };
        expect(toolSchema(inputs)).toEqual({
            type: 'object',
            properties: {
                to: { type: 'array', title: 'To', minItems: 1, items: { type: 'string', format: 'email' } },
                owner: { type: 'string', readOnly: true, deprecated: true },
                address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
                file: { type: 'object', properties: { filename: { type: 'string' } } }
            },
            required: ['to']
        });
    });

    it('keeps fields named x-… and x- keys inside values — only hint keywords go', () => {
        const inputs = {
            type: 'object',
            properties: {
                'x-trace-id': { type: 'string', 'x-group': 'Advanced' },
                headers: { type: 'object', default: { 'x-api-version': '2' }, examples: [{ 'x-mode': 'fast' }], additionalProperties: { type: 'string', 'x-widget': 'text' } },
                mode: { const: { 'x-a': 1 } },
                choice: { oneOf: [{ const: 'a', title: 'A', 'x-order': 1 }] }
            },
            required: ['x-trace-id']
        } as unknown as InputSchema;
        expect(toolSchema(inputs)).toEqual({
            type: 'object',
            properties: {
                'x-trace-id': { type: 'string' },
                headers: { type: 'object', default: { 'x-api-version': '2' }, examples: [{ 'x-mode': 'fast' }], additionalProperties: { type: 'string' } },
                mode: { const: { 'x-a': 1 } },
                choice: { oneOf: [{ const: 'a', title: 'A' }] }
            },
            required: ['x-trace-id']
        });
    });

    it('does not change its input', () => {
        const inputs: InputSchema = { type: 'object', properties: { a: { type: 'string', 'x-group': 'G' } } };
        toolSchema(inputs);
        expect(inputs.properties.a).toEqual({ type: 'string', 'x-group': 'G' });
    });

    it('gives an empty object schema when there are no inputs', () => {
        expect(toolSchema(undefined)).toEqual({ type: 'object', properties: {} });
    });
});

describe('toolDefinitions', () => {
    const description: ConnectorDescription = {
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        auth: [],
        operations: [
            { id: 'send', kind: 'action', label: 'Send', description: 'Send a message.', auth: false, hidden: false, inputs: { type: 'object', properties: { to: { type: 'string', 'x-group': 'G' } }, required: ['to'] } },
            { id: 'get', kind: 'action', label: 'Get', auth: false, hidden: false, readOnly: true },
            { id: 'delete', kind: 'action', label: 'Delete', auth: false, hidden: false, destructive: true },
            { id: 'list', kind: 'search', label: 'List', auth: false, hidden: false },
            { id: 'owners', kind: 'options', label: 'Owners', auth: false, hidden: true },
            { id: 'created', kind: 'trigger', label: 'Created', auth: false, hidden: false },
            { id: 'internal', kind: 'action', label: 'Internal', auth: false, hidden: true }
        ]
    };

    it('turns callable operations into tool definitions', () => {
        expect(toolDefinitions(description)).toEqual([
            {
                name: 'send',
                operation: 'send',
                description: 'Send. Send a message.',
                inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
                annotations: {}
            },
            { name: 'get', operation: 'get', description: 'Get', inputSchema: { type: 'object', properties: {} }, annotations: { readOnly: true } },
            { name: 'delete', operation: 'delete', description: 'Delete', inputSchema: { type: 'object', properties: {} }, annotations: { destructive: true } },
            { name: 'list', operation: 'list', description: 'List', inputSchema: { type: 'object', properties: {} }, annotations: { readOnly: true } }
        ]);
    });

    it('includes hidden callable operations on request', () => {
        expect(toolDefinitions(description, { includeHidden: true }).map((t) => t.name)).toEqual(['send', 'get', 'delete', 'list', 'internal']);
    });

    it('lets a search declare itself not read-only', () => {
        const search = { ...description, operations: [{ id: 'q', kind: 'search' as const, label: 'Q', auth: false as const, hidden: false, readOnly: false }] };
        expect(toolDefinitions(search)[0]!.annotations).toEqual({});
    });
});
