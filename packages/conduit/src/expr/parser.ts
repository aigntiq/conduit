/**
 * Recursive-descent parser for Conduit expressions.
 *
 * Precedence, lowest first:
 *
 *   pipe         a | fn(b)            → fn(a, b)
 *   conditional  a ? b : c
 *   nullish      a ?? b
 *   or           a || b
 *   and          a && b
 *   equality     == != (=== !== are aliases)
 *   relational   < <= > >=
 *   additive     + -
 *   multiplicative * / %
 *   unary        ! -
 *   postfix      a.b  a?.b  a[b]  fn(args)
 *   primary      literals, identifiers, (…), […], {…}, lambdas
 */
import { ConduitExpressionError } from '../errors';
import type { ArrayNode, BinaryOp, LambdaNode, Node, ObjectNode, PropertyNode, SpreadNode } from './ast';
import { tokenize, type Token } from './lexer';

const MAX_DEPTH = 200;

const KEYWORDS: Record<string, LiteralValue> = {
    true: true,
    false: false,
    null: null,
    undefined: undefined
};
type LiteralValue = string | number | boolean | null | undefined;

export function parseExpression(source: string): Node {
    return new Parser(source).parseRoot();
}

class Parser {
    private readonly tokens: Token[];
    private index = 0;
    private depth = 0;

    constructor(private readonly source: string) {
        this.tokens = tokenize(source);
    }

    parseRoot(): Node {
        if (this.peek().type === 'eof') this.fail('empty expression');
        const node = this.parsePipe();
        if (this.peek().type !== 'eof') this.fail(`unexpected "${this.peek().value}"`);
        return node;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private peek(offset = 0): Token {
        return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
    }

    private next(): Token {
        return this.tokens[this.index++]!;
    }

    private isPunct(value: string, offset = 0): boolean {
        const t = this.peek(offset);
        return t.type === 'punct' && t.value === value;
    }

    private eat(value: string): boolean {
        if (this.isPunct(value)) {
            this.index++;
            return true;
        }
        return false;
    }

    private expect(value: string): Token {
        if (!this.isPunct(value)) {
            const t = this.peek();
            this.fail(t.type === 'eof' ? `expected "${value}" but the expression ended` : `expected "${value}" but found "${t.value}"`);
        }
        return this.next();
    }

    private expectIdent(what: string): Token {
        const t = this.peek();
        if (t.type !== 'ident') this.fail(`expected ${what}`);
        return this.next();
    }

    private fail(message: string, pos = this.peek().pos): never {
        throw new ConduitExpressionError(message, this.source, pos);
    }

    private enter(): void {
        if (++this.depth > MAX_DEPTH) this.fail('expression is nested too deeply');
    }

    private leave(): void {
        this.depth--;
    }

    // ── grammar ─────────────────────────────────────────────────────────

    private parsePipe(): Node {
        let left = this.parseConditional();
        while (this.isPunct('|')) {
            const pos = this.next().pos;
            const name = String(this.expectIdent('a function name after "|"').value);
            const args = this.isPunct('(') ? this.parseArgs() : [];
            left = { type: 'call', callee: name, args: [left, ...args], pos };
        }
        return left;
    }

    private parseConditional(): Node {
        const test = this.parseBinary(0);
        if (!this.isPunct('?')) return test;
        const pos = this.next().pos;
        this.enter();
        const consequent = this.parseConditional();
        this.expect(':');
        const alternate = this.parseConditional();
        this.leave();
        return { type: 'conditional', test, consequent, alternate, pos };
    }

    private static readonly LEVELS: readonly (readonly string[])[] = [
        ['??'],
        ['||'],
        ['&&'],
        ['==', '!=', '===', '!=='],
        ['<', '<=', '>', '>='],
        ['+', '-'],
        ['*', '/', '%']
    ];

    private parseBinary(level: number): Node {
        if (level >= Parser.LEVELS.length) return this.parseUnary();
        const ops = Parser.LEVELS[level]!;
        let left = this.parseBinary(level + 1);
        for (;;) {
            const t = this.peek();
            if (t.type !== 'punct' || !ops.includes(String(t.value))) return left;
            this.next();
            let op = String(t.value);
            if (op === '===') op = '==';
            if (op === '!==') op = '!=';
            this.enter();
            const right = this.parseBinary(level + 1);
            this.leave();
            left = { type: 'binary', op: op as BinaryOp, left, right, pos: t.pos };
        }
    }

    private parseUnary(): Node {
        const t = this.peek();
        if (t.type === 'punct' && (t.value === '!' || t.value === '-')) {
            this.next();
            this.enter();
            const arg = this.parseUnary();
            this.leave();
            return { type: 'unary', op: t.value, arg, pos: t.pos };
        }
        return this.parsePostfix();
    }

    private parsePostfix(): Node {
        let node = this.parsePrimary();
        for (;;) {
            const t = this.peek();
            if (this.isPunct('.') || this.isPunct('?.')) {
                this.next();
                if (this.isPunct('[')) {
                    // `a?.[k]`
                    this.next();
                    const key = this.parsePipe();
                    this.expect(']');
                    node = { type: 'member', object: node, property: key, pos: t.pos };
                    continue;
                }
                const name = this.expectIdent('a property name');
                node = { type: 'member', object: node, property: String(name.value), pos: t.pos };
                continue;
            }
            if (this.isPunct('[')) {
                this.next();
                const key = this.parsePipe();
                this.expect(']');
                node = { type: 'member', object: node, property: key, pos: t.pos };
                continue;
            }
            if (this.isPunct('(')) {
                if (node.type !== 'ident') this.fail('only named functions can be called — use a pipe: value | fn()', t.pos);
                const args = this.parseArgs();
                node = { type: 'call', callee: node.name, args, pos: node.pos };
                continue;
            }
            return node;
        }
    }

    private parseArgs(): Node[] {
        this.expect('(');
        const args: Node[] = [];
        this.enter();
        while (!this.isPunct(')')) {
            args.push(this.parsePipe());
            if (!this.eat(',')) break;
        }
        this.expect(')');
        this.leave();
        return args;
    }

    private parsePrimary(): Node {
        const t = this.peek();
        switch (t.type) {
            case 'number':
            case 'string':
                this.next();
                return { type: 'literal', value: t.value, pos: t.pos };
            case 'ident': {
                const name = String(t.value);
                if (this.isPunct('=>', 1)) return this.parseLambda();
                this.next();
                if (Object.hasOwn(KEYWORDS, name)) return { type: 'literal', value: KEYWORDS[name], pos: t.pos };
                return { type: 'ident', name, pos: t.pos };
            }
            case 'eof':
                return this.fail('unexpected end of expression');
            case 'punct':
                break;
        }
        if (t.value === '(') {
            if (this.looksLikeLambda()) return this.parseLambda();
            this.next();
            this.enter();
            const inner = this.parsePipe();
            this.leave();
            this.expect(')');
            return inner;
        }
        if (t.value === '[') return this.parseArray();
        if (t.value === '{') return this.parseObject();
        return this.fail(`unexpected "${t.value}"`);
    }

    /** `(` `)` `=>` or `(` ident (`,` ident)* `)` `=>` */
    private looksLikeLambda(): boolean {
        let i = 1;
        if (this.isPunct(')', i)) return this.isPunct('=>', i + 1);
        for (;;) {
            if (this.peek(i).type !== 'ident') return false;
            i++;
            if (this.isPunct(')', i)) return this.isPunct('=>', i + 1);
            if (!this.isPunct(',', i)) return false;
            i++;
        }
    }

    private parseLambda(): LambdaNode {
        const pos = this.peek().pos;
        const params: string[] = [];
        if (this.eat('(')) {
            while (!this.isPunct(')')) {
                params.push(String(this.expectIdent('a parameter name').value));
                if (!this.eat(',')) break;
            }
            this.expect(')');
        } else {
            params.push(String(this.next().value));
        }
        this.expect('=>');
        this.enter();
        // The body extends as far right as it can, pipes included:
        // `map(i => i.tags | join(','))` pipes inside the lambda.
        const body = this.parsePipe();
        this.leave();
        return { type: 'lambda', params, body, pos };
    }

    private parseArray(): ArrayNode {
        const pos = this.expect('[').pos;
        const elements: (Node | SpreadNode)[] = [];
        this.enter();
        while (!this.isPunct(']')) {
            if (this.isPunct('...')) {
                const spreadPos = this.next().pos;
                elements.push({ type: 'spread', arg: this.parsePipe(), pos: spreadPos });
            } else {
                elements.push(this.parsePipe());
            }
            if (!this.eat(',')) break;
        }
        this.expect(']');
        this.leave();
        return { type: 'array', elements, pos };
    }

    private parseObject(): ObjectNode {
        const pos = this.expect('{').pos;
        const entries: (PropertyNode | SpreadNode)[] = [];
        this.enter();
        while (!this.isPunct('}')) {
            const t = this.peek();
            if (this.isPunct('...')) {
                this.next();
                entries.push({ type: 'spread', arg: this.parsePipe(), pos: t.pos });
            } else if (this.isPunct('[')) {
                this.next();
                const key = this.parsePipe();
                this.expect(']');
                this.expect(':');
                entries.push({ type: 'property', key, value: this.parsePipe(), pos: t.pos });
            } else if (t.type === 'ident' || t.type === 'string' || t.type === 'number') {
                this.next();
                const key = String(t.value);
                if (this.eat(':')) {
                    entries.push({ type: 'property', key, value: this.parsePipe(), pos: t.pos });
                } else if (t.type === 'ident') {
                    // shorthand `{ a }`
                    entries.push({ type: 'property', key, value: { type: 'ident', name: key, pos: t.pos }, pos: t.pos });
                } else {
                    this.fail('expected ":" after object key');
                }
            } else {
                this.fail('expected an object key');
            }
            if (!this.eat(',')) break;
        }
        this.expect('}');
        this.leave();
        return { type: 'object', entries, pos };
    }
}
