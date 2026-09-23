import { describe, expect, it } from 'vitest';
import {
    ConduitExpressionError,
    analyzeTemplate,
    analyzeTemplateString,
    findExpressions,
    renderTemplate,
    standardRegistry
} from '@aigntiq/conduit/expr';

const scope = { inputs: { id: 7, name: 'Ada', tags: ['x', 'y'], limit: undefined as number | undefined, obj: { a: 1 } } };
const render = (value: unknown) => renderTemplate(value, scope, { functions: standardRegistry });

describe('renderTemplate', () => {
    it('returns the raw value for a whole-string expression', async () => {
        expect(await render('{{inputs.id}}')).toBe(7);
        expect(await render('{{inputs.tags}}')).toEqual(['x', 'y']);
        expect(await render('{{ inputs.obj }}')).toEqual({ a: 1 });
    });

    it('interpolates when there is surrounding text', async () => {
        expect(await render('/users/{{inputs.id}}')).toBe('/users/7');
        expect(await render('{{inputs.name}} has {{inputs.tags | length}} tags')).toBe('Ada has 2 tags');
        expect(await render(' {{inputs.id}}')).toBe(' 7');
        expect(await render('obj={{inputs.obj}}')).toBe('obj={"a":1}');
        expect(await render('missing=[{{inputs.limit}}]')).toBe('missing=[]');
    });

    it('leaves plain strings and non-JSON values alone', async () => {
        expect(await render('no braces')).toBe('no braces');
        expect(await render(5)).toBe(5);
        const bytes = new Uint8Array([1, 2]);
        expect(await render(bytes)).toBe(bytes);
    });

    it('walks objects and arrays, dropping keys that render undefined', async () => {
        expect(
            await render({
                id: '{{inputs.id}}',
                limit: '{{inputs.limit}}',
                list: ['{{inputs.name}}', 'static', '{{inputs.limit}}'],
                nested: { label: 'id-{{inputs.id}}' }
            })
        ).toEqual({ id: 7, list: ['Ada', 'static', undefined], nested: { label: 'id-7' } });
    });

    it('handles object literals and braces inside strings in an expression', async () => {
        expect(await render('{{ {a: {b: inputs.id}} }}')).toEqual({ a: { b: 7 } });
        expect(await render("{{ '}}' + inputs.name }}")).toBe('}}Ada');
        expect(await render('{{"{{"}}')).toBe('{{');
    });

    it('reports unterminated templates and maps error positions into the string', async () => {
        await expect(render('abc {{ inputs.id')).rejects.toThrow(/unterminated/);
        const err = await render('prefix {{ 1 + }}').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitExpressionError);
        expect((err as ConduitExpressionError).position).toBeGreaterThanOrEqual(9);
    });
});

describe('findExpressions', () => {
    it('finds every span with offsets', () => {
        expect(findExpressions('a{{x}}b{{ y.z }}')).toEqual([
            { source: 'x', offset: 3 },
            { source: ' y.z ', offset: 9 }
        ]);
    });
});

describe('analysis', () => {
    it('collects roots and functions, ignoring lambda parameters', () => {
        const a = analyzeTemplateString('{{ inputs.items | map(i => i.id + offset) | join(sep) }}');
        expect([...a.roots].sort()).toEqual(['inputs', 'offset', 'sep']);
        expect([...a.functions].sort()).toEqual(['join', 'map']);
        expect(a.issues).toEqual([]);
    });

    it('flags unknown functions as errors and unknown roots as warnings', () => {
        const a = analyzeTemplateString('{{ nope(inputs.x) + other }}', {
            functions: standardRegistry,
            roots: new Set(['inputs'])
        });
        expect(a.issues.map((i) => [i.severity, i.message])).toEqual([
            ['error', 'unknown function "nope"'],
            ['warning', expect.stringContaining('"other" is not available here')]
        ]);
    });

    it('locates issues inside nested values', () => {
        const a = analyzeTemplate({ headers: { 'X-Id': '{{ inputs.id +}}' }, list: ['ok', '{{ bad( }}'] }, {}, 'request');
        expect(a.issues.map((i) => i.path)).toEqual(['request.headers.X-Id', 'request.list[1]']);
    });
});
