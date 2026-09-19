import { describe, expect, it } from 'vitest';
import {
    ConduitExpressionError,
    createFunctionRegistry,
    evaluateExpression,
    standardRegistry,
    type ExprFunction
} from '@sigx/conduit/expr';

const scope = {
    inputs: { name: 'Ada', count: 3, tags: ['a', 'b', 'c'], nested: { deep: { value: 42 } }, empty: '' },
    list: [
        { id: 1, name: 'one', score: 10 },
        { id: 2, name: 'two', score: 30 },
        { id: 3, name: 'three', score: 20 }
    ],
    nothing: null
};

const run = (source: string, s: Record<string, unknown> = scope) =>
    evaluateExpression(source, s, { functions: standardRegistry, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });

describe('literals and paths', () => {
    it.each([
        ['1', 1],
        ['1.5e2', 150],
        ['.5', 0.5],
        ["'it\\'s'", "it's"],
        ['"line\\nbreak"', 'line\nbreak'],
        ['"\\u00e9"', 'é'],
        ['true', true],
        ['false', false],
        ['null', null],
        ['undefined', undefined],
        ['inputs.name', 'Ada'],
        ['inputs["name"]', 'Ada'],
        ["inputs['nested'].deep.value", 42],
        ['inputs.tags[1]', 'b'],
        ['inputs.tags[-1]', 'c'],
        ['inputs.tags.length', 3],
        ['inputs.name.length', 3],
        ['inputs.missing.deeper.still', undefined],
        ['nothing?.x', undefined],
        ['inputs?.nested?.["deep"]', { value: 42 }],
        ['unknownRoot', undefined]
    ])('%s → %j', async (source, expected) => {
        expect(await run(source)).toEqual(expected);
    });
});

describe('operators', () => {
    it.each([
        ['1 + 2 * 3', 7],
        ['(1 + 2) * 3', 9],
        ['10 % 4', 2],
        ['10 / 4', 2.5],
        ['-inputs.count', -3],
        ["'5' * 2", 10],
        ["'a' + 1", 'a1'],
        ["'n=' + nothing", 'n='],
        ['1 + 2 + "x"', '3x'],
        ['inputs.count > 2', true],
        ['inputs.count >= 3', true],
        ["'10' > '9'", true],
        ["'b' > 'a'", true],
        ['nothing < 1', false],
        ['1 == 1', true],
        ["1 == '1'", false],
        ['1 === 1', true],
        ['[1, {a: 2}] == [1, {a: 2}]', true],
        ['{a: 1} != {a: 2}', true],
        ['!inputs.empty', true],
        ['!!inputs.name', true],
        ['nothing ?? "fallback"', 'fallback'],
        ['inputs.empty ?? "fallback"', ''],
        ['inputs.empty || "fallback"', 'fallback'],
        ['inputs.name && inputs.count', 3],
        ['inputs.count > 2 ? "big" : "small"', 'big'],
        ['false ? 1 : nothing ? 2 : 3', 3]
    ])('%s → %j', async (source, expected) => {
        expect(await run(source)).toEqual(expected);
    });

    it('short-circuits && and || (the right side never runs)', async () => {
        await expect(run('false && unknownFn()')).resolves.toBe(false);
        await expect(run('true || unknownFn()')).resolves.toBe(true);
    });

    it('rejects arithmetic on non-numbers', async () => {
        await expect(run("'abc' * 2")).rejects.toThrow(/needs numbers/);
    });
});

describe('collections, lambdas and pipes', () => {
    it.each([
        ['[1, ...inputs.tags, 5]', [1, 'a', 'b', 'c', 5]],
        ['{...inputs.nested, extra: 1}', { deep: { value: 42 }, extra: 1 }],
        ["{['k' + 1]: true, 'quoted-key': 2}", { k1: true, 'quoted-key': 2 }],
        ['{ list }', { list: scope.list }],
        ['list | map(i => i.id)', [1, 2, 3]],
        ["list | map('name')", ['one', 'two', 'three']],
        ['list | map((item, index) => index)', [0, 1, 2]],
        ['list | filter(i => i.score > 15) | map(i => i.name)', ['two', 'three']],
        ["list | sortBy('score', 'desc') | map('id')", [2, 3, 1]],
        ['list | find(i => i.id == 2) | get("name")', 'two'],
        ['inputs.tags | join("-")', 'a-b-c'],
        ['inputs.tags | map(t => upper(t)) | join()', 'A,B,C'],
        ['map(list, i => {id: i.id, big: i.score > 15})', [
            { id: 1, big: false },
            { id: 2, big: true },
            { id: 3, big: true }
        ]],
        ['list | map(i => i.tags | join(",")) | length', 3]
    ])('%s', async (source, expected) => {
        expect(await run(source)).toEqual(expected);
    });

    it('closes over outer lambda parameters', async () => {
        expect(await run('list | map(a => list | filter(b => b.score > a.score) | length)')).toEqual([2, 0, 1]);
    });

    it('lets a lambda-valued parameter be called', async () => {
        const registry = createFunctionRegistry({
            apply: { call: ([fn, v], ctx) => ctx.invoke(fn, v) }
        });
        await expect(evaluateExpression('apply(x => x * 2, 21)', {}, { functions: registry })).resolves.toBe(42);
    });
});

describe('sandbox', () => {
    it.each(['inputs.__proto__', 'inputs.constructor', "inputs['constructor']", 'list.prototype', "'x'.constructor"])(
        'refuses %s',
        async (source) => {
            await expect(run(source)).rejects.toBeInstanceOf(ConduitExpressionError);
        }
    );

    it('refuses prototype keys in object literals', async () => {
        await expect(run("{['__proto__']: 1}")).rejects.toThrow(/cannot be used as an object key/);
    });

    it('never reads inherited properties', async () => {
        expect(await run('inputs.toString')).toBeUndefined();
        expect(await run('inputs.hasOwnProperty')).toBeUndefined();
        expect(await run('list.map')).toBeUndefined();
    });

    it('cannot call members — only named functions', async () => {
        await expect(run('inputs.name.toUpperCase()')).rejects.toThrow(/only named functions can be called/);
    });

    it('rejects unknown functions', async () => {
        await expect(run('launch()')).rejects.toThrow(/unknown function "launch"/);
    });

    it('enforces arity', async () => {
        await expect(run('upper()')).rejects.toThrow(/at least 1/);
        await expect(run('upper(1, 2)')).rejects.toThrow(/at most 1/);
    });

    it('stops a runaway expression at the step budget', async () => {
        await expect(
            evaluateExpression('range(0, 10000) | map(a => range(0, 10000) | map(b => a * b))', {}, {
                functions: standardRegistry,
                maxSteps: 50_000
            })
        ).rejects.toThrow(/budget/);
    });

    it('caps string growth', async () => {
        await expect(
            evaluateExpression("range(0, 5000) | map(i => 'xxxxxxxxxx') | join('')", {}, {
                functions: standardRegistry,
                maxStringLength: 1000
            })
        ).rejects.toThrow(/longer than 1000/);
    });

    it('does not leak host functions passed in scope', async () => {
        const hostile = { fn: () => 'called' };
        await expect(evaluateExpression('fn()', hostile, { functions: standardRegistry })).rejects.toThrow(/unknown function/);
    });

    it('lets registered functions be overridden', async () => {
        const upper: ExprFunction = { call: () => 'overridden' };
        const registry = createFunctionRegistry({ upper });
        await expect(evaluateExpression("upper('x')", {}, { functions: registry })).resolves.toBe('overridden');
    });
});

describe('syntax errors carry positions', () => {
    it.each([
        ['1 +', /unexpected end/],
        ['(1 + 2', /expected "\)"/],
        ["'open", /unterminated string/],
        ['a | 1', /function name/],
        ['{a b}', /expected/],
        ['#', /unexpected character/],
        ['', /empty expression/]
    ])('%s', async (source, message) => {
        const err = await run(source).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConduitExpressionError);
        expect((err as Error).message).toMatch(message);
        expect((err as ConduitExpressionError).position).toBeTypeOf('number');
    });
});
