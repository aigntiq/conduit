import { ConduitExpressionError } from '../errors';

export type TokenType = 'number' | 'string' | 'ident' | 'punct' | 'eof';

export interface Token {
    type: TokenType;
    /** Raw punctuation / identifier text, or the decoded string/number value. */
    value: string | number;
    pos: number;
}

// Longest first: the scanner takes the first match at each offset.
const PUNCTUATION = [
    '...',
    '===',
    '!==',
    '=>',
    '==',
    '!=',
    '<=',
    '>=',
    '&&',
    '||',
    '??',
    '?.',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    ',',
    '.',
    ':',
    '?',
    '!',
    '<',
    '>',
    '+',
    '-',
    '*',
    '/',
    '%',
    '|'
];

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

export function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const fail = (message: string, pos = i): never => {
        throw new ConduitExpressionError(message, source, pos);
    };

    while (i < source.length) {
        const ch = source[i]!;
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        const start = i;

        if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(source[i + 1] ?? ''))) {
            const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))!;
            i += m[0].length;
            tokens.push({ type: 'number', value: Number(m[0]), pos: start });
            continue;
        }

        if (IDENT_START.test(ch)) {
            while (i < source.length && IDENT_PART.test(source[i]!)) i++;
            tokens.push({ type: 'ident', value: source.slice(start, i), pos: start });
            continue;
        }

        if (ch === "'" || ch === '"') {
            i++;
            let out = '';
            for (;;) {
                if (i >= source.length) fail('unterminated string literal', start);
                const c = source[i]!;
                if (c === ch) {
                    i++;
                    break;
                }
                if (c === '\\') {
                    const next = source[i + 1];
                    i += 2;
                    switch (next) {
                        case 'n':
                            out += '\n';
                            break;
                        case 't':
                            out += '\t';
                            break;
                        case 'r':
                            out += '\r';
                            break;
                        case 'u': {
                            const hex = source.slice(i, i + 4);
                            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape', i - 2);
                            out += String.fromCharCode(parseInt(hex, 16));
                            i += 4;
                            break;
                        }
                        case undefined:
                            fail('unterminated string literal', start);
                            break;
                        default:
                            out += next;
                    }
                    continue;
                }
                out += c;
                i++;
            }
            tokens.push({ type: 'string', value: out, pos: start });
            continue;
        }

        const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
        if (punct) {
            // `?.5` is a ternary on a number, not optional chaining.
            if (punct === '?.' && DIGIT.test(source[i + 2] ?? '')) {
                tokens.push({ type: 'punct', value: '?', pos: start });
                i += 1;
                continue;
            }
            i += punct.length;
            tokens.push({ type: 'punct', value: punct, pos: start });
            continue;
        }

        fail(`unexpected character "${ch}"`);
    }

    tokens.push({ type: 'eof', value: '', pos: source.length });
    return tokens;
}
