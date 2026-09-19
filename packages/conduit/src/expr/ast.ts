/** The Conduit expression AST. Every node carries its source offset. */

export type Node =
    | LiteralNode
    | IdentNode
    | MemberNode
    | CallNode
    | UnaryNode
    | BinaryNode
    | ConditionalNode
    | ArrayNode
    | ObjectNode
    | LambdaNode;

interface Base {
    pos: number;
}

export interface LiteralNode extends Base {
    type: 'literal';
    value: string | number | boolean | null | undefined;
}

export interface IdentNode extends Base {
    type: 'ident';
    name: string;
}

export interface MemberNode extends Base {
    type: 'member';
    object: Node;
    /** A static name (`a.b`) or a computed key (`a[expr]`). */
    property: string | Node;
}

export interface CallNode extends Base {
    type: 'call';
    /** Only named functions (or lambda-valued locals) are callable. */
    callee: string;
    args: Node[];
}

export interface UnaryNode extends Base {
    type: 'unary';
    op: '!' | '-';
    arg: Node;
}

export type BinaryOp =
    | '+'
    | '-'
    | '*'
    | '/'
    | '%'
    | '=='
    | '!='
    | '<'
    | '<='
    | '>'
    | '>='
    | '&&'
    | '||'
    | '??';

export interface BinaryNode extends Base {
    type: 'binary';
    op: BinaryOp;
    left: Node;
    right: Node;
}

export interface ConditionalNode extends Base {
    type: 'conditional';
    test: Node;
    consequent: Node;
    alternate: Node;
}

export interface SpreadNode extends Base {
    type: 'spread';
    arg: Node;
}

export interface ArrayNode extends Base {
    type: 'array';
    elements: (Node | SpreadNode)[];
}

export interface PropertyNode extends Base {
    type: 'property';
    key: string | Node;
    value: Node;
}

export interface ObjectNode extends Base {
    type: 'object';
    entries: (PropertyNode | SpreadNode)[];
}

export interface LambdaNode extends Base {
    type: 'lambda';
    params: string[];
    body: Node;
}
