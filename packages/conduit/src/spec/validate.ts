/**
 * Connector validation: structure (the JSON Schema), then meaning.
 *
 * Semantic checks catch what a schema cannot: duplicate ids, references to
 * auth methods / operations / steps that do not exist, and every template
 * expression — parsed, its functions resolved, and the scope roots it reads
 * compared against what is actually available where it sits. A typo in a
 * connector surfaces here, at load time, with a path — not as a failed call
 * in production.
 */
import { ConduitSpecError, type Diagnostic } from '../errors';
import { analyzeExpression, analyzeTemplate } from '../expr/analyze';
import type { FunctionRegistry } from '../expr/evaluate';
import { STANDARD_FUNCTIONS } from '../expr/stdlib';
import { conduitSchema } from '../schema/conduit-1';
import { validateAgainstSchema, type SchemaNode } from '../schema/validator';
import type { AuthMethod, ConnectorSpec, InputProperty, InputSchema, InputType, OperationSpec, RequestSpec, StepSpec, Widget } from './types';

export interface ValidateOptions {
    /** Host-provided expression functions (from plugins), in addition to the standard library. */
    functions?: FunctionRegistry | ReadonlySet<string>;
    /** Host-provided request encodings (from plugins), in addition to the built-ins. */
    encodings?: Iterable<string>;
}

const BUILTIN_ENCODINGS = ['json', 'form', 'multipart', 'text', 'binary'];

export interface ValidationResult {
    valid: boolean;
    /** Errors and warnings. `valid` is false iff any has severity `error`. */
    diagnostics: Diagnostic[];
}

const BASE = ['inputs', 'auth', 'account', 'config', 'env'];
const roots = (...names: string[]) => new Set(names);

/** What each location in a spec can read. Documented in docs/spec-reference.md#scope. */
export const SCOPE_ROOTS = {
    http: roots(...BASE),
    request: roots(...BASE, 'steps', 'page'),
    stepOutput: roots(...BASE, 'steps', 'response'),
    output: roots(...BASE, 'steps', 'response', 'items'),
    errors: roots(...BASE, 'steps', 'response'),
    paginate: roots(...BASE, 'steps', 'response', 'page'),
    apply: roots('auth', 'account', 'config', 'env'),
    authRequest: roots('inputs', 'auth', 'account', 'config', 'env'),
    identityMapping: roots('inputs', 'auth', 'account', 'config', 'env', 'response', 'token'),
    authorize: roots('inputs', 'config', 'env', 'oauth', 'client'),
    token: roots('inputs', 'config', 'env', 'oauth', 'client', 'auth'),
    tokenMapping: roots('inputs', 'config', 'env', 'auth', 'response'),
    jwt: roots('auth', 'config', 'env', 'now'),
    jwtExchange: roots('auth', 'config', 'env', 'jwt'),
    custom: roots('inputs', 'config', 'env', 'steps'),
    customResult: roots('inputs', 'config', 'env', 'steps', 'response'),
    subscribe: roots(...BASE, 'subscription'),
    delivery: roots('inputs', 'auth', 'account', 'config', 'env', 'request', 'subscription'),
    poll: roots(...BASE, 'state'),
    pollResult: roots(...BASE, 'state', 'response', 'item'),
    optionsInputs: roots('inputs', 'config', 'env'),
    rules: roots('inputs')
} as const;

class Collector {
    readonly diagnostics: Diagnostic[] = [];

    constructor(
        readonly functions: ReadonlySet<string>,
        readonly encodings: ReadonlySet<string>
    ) {}

    error(path: string, code: string, message: string): void {
        this.diagnostics.push({ path, code, message, severity: 'error' });
    }

    warn(path: string, code: string, message: string): void {
        this.diagnostics.push({ path, code, message, severity: 'warning' });
    }

    templates(value: unknown, path: string, available: ReadonlySet<string>): void {
        if (value === undefined) return;
        const result = analyzeTemplate(value, { functions: this.functions, roots: available }, path);
        for (const issue of result.issues) {
            const where = issue.position === undefined ? '' : ` (at ${issue.position})`;
            const code = issue.severity === 'error' ? 'expression_invalid' : 'expression_scope';
            this.diagnostics.push({ path: issue.path, code, message: issue.message + where, severity: issue.severity });
        }
    }

    request(request: RequestSpec | undefined, path: string, available: ReadonlySet<string>): void {
        if (!request) return;
        const { method, url, query, headers, body } = request;
        this.templates({ method, url, query, headers, body }, path, available);
        if (typeof request.method === 'string' && !request.method.includes('{{')) {
            if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(request.method)) {
                this.error(`${path}.method`, 'method_invalid', `"${request.method}" is not an HTTP method`);
            }
        }
        if (request.encoding !== undefined && !this.encodings.has(request.encoding)) {
            this.error(`${path}.encoding`, 'encoding_unknown', `no request encoding "${request.encoding}" (available: ${[...this.encodings].join(', ')})`);
        }
    }

    steps(steps: StepSpec[] | undefined, path: string, available: ReadonlySet<string>, outputRoots: ReadonlySet<string>): void {
        if (!steps) return;
        const names = new Set<string>();
        steps.forEach((step, i) => {
            const p = `${path}[${i}]`;
            if (names.has(step.name)) this.error(`${p}.name`, 'duplicate_step', `step "${step.name}" is defined twice`);
            names.add(step.name);
            const { when, output, ...request } = step;
            this.templates(when, `${p}.when`, available);
            this.request(request, p, available);
            this.templates(output, `${p}.output`, outputRoots);
        });
    }
}

function withFunctionNames(spec: ConnectorSpec, options: ValidateOptions): Set<string> {
    const names = new Set(Object.keys(STANDARD_FUNCTIONS));
    if (options.functions) for (const name of options.functions.keys()) names.add(name);
    for (const name of Object.keys(spec.functions ?? {})) names.add(name);
    return names;
}

/** Which input types each widget can render. `*` renders anything. */
const WIDGET_TYPES: Record<Widget, readonly InputType[] | '*'> = {
    text: ['string'],
    textarea: ['string'],
    richtext: ['string'],
    markdown: ['string'],
    code: ['string'],
    password: ['string'],
    number: ['number', 'integer'],
    toggle: ['boolean'],
    select: ['string', 'number', 'integer', 'boolean'],
    multiselect: ['array'],
    combobox: ['string', 'number', 'integer'],
    date: ['string'],
    datetime: ['string'],
    email: ['string'],
    url: ['string'],
    emails: ['array'],
    file: ['object', 'array'],
    json: '*',
    keyvalue: ['object'],
    list: ['array'],
    fieldset: ['object'],
    hidden: '*'
};

function checkConditions(c: Collector, prop: InputProperty, p: string, siblings: ReadonlySet<string>): void {
    for (const key of ['x-visibleWhen', 'x-requiredWhen'] as const) {
        for (const name of Object.keys(prop[key] ?? {})) {
            if (!siblings.has(name)) c.error(`${p}.${key}.${name}`, 'condition_unknown', `"${name}" is not a field next to this one`);
        }
    }
}

function checkProperty(c: Collector, prop: InputProperty, p: string, siblings: ReadonlySet<string> | undefined, top: ReadonlySet<string>, operations: Map<string, OperationSpec>): void {
    if (prop.pattern !== undefined) {
        try {
            new RegExp(prop.pattern, 'u');
        } catch {
            c.error(`${p}.pattern`, 'pattern_invalid', `"${prop.pattern}" is not a valid regular expression`);
        }
    }
    const widget = prop['x-widget'];
    if (widget) {
        const types = WIDGET_TYPES[widget];
        if (types !== '*' && !types.includes(prop.type)) {
            c.error(`${p}.x-widget`, 'widget_type', `the "${widget}" widget cannot render a ${prop.type} (it renders ${types.join(', ')})`);
        }
    }
    if (prop.default !== undefined) {
        const [issue] = validateAgainstSchema(prop as unknown as SchemaNode, prop.default);
        if (issue) c.error(`${p}.default`, 'default_invalid', `the default ${issue.path ? `at ${issue.path} ` : ''}${issue.message}`);
    }
    if (siblings) checkConditions(c, prop, p, siblings);

    const options = prop['x-options'];
    if (options) {
        const target = operations.get(options.operation);
        if (!target) c.error(`${p}.x-options.operation`, 'operation_unknown', `no operation "${options.operation}"`);
        else if (target.kind !== 'options') {
            c.error(`${p}.x-options.operation`, 'operation_kind', `"${options.operation}" is a ${target.kind} operation, not options`);
        } else if (options.search && !Object.hasOwn(target.inputs?.properties ?? {}, options.search)) {
            c.error(`${p}.x-options.search`, 'input_unknown', `"${options.operation}" has no input "${options.search}" to receive the search text`);
        }
        for (const dep of options.dependsOn ?? []) {
            if (!top.has(dep)) c.error(`${p}.x-options.dependsOn`, 'input_unknown', `"${dep}" is not an input of this form`);
        }
        c.templates(options.inputs, `${p}.x-options.inputs`, SCOPE_ROOTS.optionsInputs);
    }

    if (prop.type === 'object' && prop.properties) checkLevel(c, prop.properties, prop.required ?? [], p, top, operations);
    if (prop.items) checkProperty(c, prop.items, `${p}.items`, undefined, top, operations);
}

function checkLevel(c: Collector, properties: Record<string, InputProperty>, required: readonly string[], path: string, top: ReadonlySet<string>, operations: Map<string, OperationSpec>): void {
    for (const req of required) {
        if (!Object.hasOwn(properties, req)) c.error(`${path}.required`, 'input_unknown', `"${req}" is required but not defined in properties`);
    }
    const siblings = new Set(Object.keys(properties));
    for (const [name, prop] of Object.entries(properties)) checkProperty(c, prop, `${path}.properties.${name}`, siblings, top, operations);
}

function checkInputs(c: Collector, inputs: InputSchema | undefined, path: string, operations: Map<string, OperationSpec>): void {
    if (!inputs) return;
    const top = new Set(Object.keys(inputs.properties));
    checkLevel(c, inputs.properties, inputs.required ?? [], path, top, operations);
    (inputs['x-rules'] ?? []).forEach((rule, i) => {
        // Rules run in the browser too: they see only `inputs`.
        c.templates(rule.check, `${path}.x-rules[${i}].check`, SCOPE_ROOTS.rules);
        for (const f of rule.fields ?? []) {
            if (!top.has(f)) c.error(`${path}.x-rules[${i}].fields`, 'input_unknown', `"${f}" is not an input of this form`);
        }
    });
}

function checkAuth(c: Collector, method: AuthMethod, path: string, operations: Map<string, OperationSpec>): void {
    checkInputs(c, method.inputs, `${path}.inputs`, operations);
    c.templates(method.apply, `${path}.apply`, SCOPE_ROOTS.apply);
    c.request(method.test, `${path}.test`, SCOPE_ROOTS.authRequest);
    if (method.identity) {
        const { request, ...mapping } = method.identity;
        c.request(request, `${path}.identity.request`, SCOPE_ROOTS.authRequest);
        c.templates(mapping, `${path}.identity`, SCOPE_ROOTS.identityMapping);
    }

    switch (method.type) {
        case 'oauth2': {
            const grant = method.grant ?? 'authorization_code';
            if (grant === 'authorization_code' && !method.authorizeUrl) {
                c.error(`${path}.authorizeUrl`, 'oauth_authorize_missing', 'the authorization_code grant needs an authorizeUrl');
            }
            if (grant === 'client_credentials' && method.authorizeUrl) {
                c.warn(`${path}.authorizeUrl`, 'oauth_authorize_unused', 'client_credentials never uses authorizeUrl');
            }
            c.templates({ authorizeUrl: method.authorizeUrl, authorizeParams: method.authorizeParams }, path, SCOPE_ROOTS.authorize);
            c.templates(
                { tokenUrl: method.tokenUrl, refreshUrl: method.refreshUrl, revokeUrl: method.revokeUrl, tokenParams: method.tokenParams, client: method.client },
                path,
                SCOPE_ROOTS.token
            );
            c.templates(method.token, `${path}.token`, SCOPE_ROOTS.tokenMapping);
            break;
        }
        case 'apiKey':
            c.templates(method.value, `${path}.value`, SCOPE_ROOTS.apply);
            break;
        case 'jwt':
            c.templates(method.jwt, `${path}.jwt`, SCOPE_ROOTS.jwt);
            if (method.exchange) {
                c.request(method.exchange.request, `${path}.exchange.request`, SCOPE_ROOTS.jwtExchange);
                c.templates(method.exchange.token, `${path}.exchange.token`, SCOPE_ROOTS.tokenMapping);
            }
            break;
        case 'custom':
            c.steps(method.steps, `${path}.steps`, SCOPE_ROOTS.custom, SCOPE_ROOTS.customResult);
            c.templates(method.credentials, `${path}.credentials`, SCOPE_ROOTS.customResult);
            c.templates(method.expiresIn, `${path}.expiresIn`, SCOPE_ROOTS.customResult);
            break;
        case 'basic':
        case 'bearer':
            break;
    }
}

function checkOperation(c: Collector, op: OperationSpec, path: string, authIds: Set<string>, operations: Map<string, OperationSpec>): void {
    if (Array.isArray(op.auth)) {
        op.auth.forEach((id, i) => {
            if (!authIds.has(id)) c.error(`${path}.auth[${i}]`, 'auth_unknown', `no auth method "${id}"`);
        });
    }
    if (op.readOnly && op.destructive) {
        c.error(`${path}.readOnly`, 'operation_read_only_destructive', 'an operation cannot be both readOnly and destructive');
    }
    checkInputs(c, op.inputs, `${path}.inputs`, operations);
    c.steps(op.steps, `${path}.steps`, SCOPE_ROOTS.request, SCOPE_ROOTS.stepOutput);
    c.templates(op.errors, `${path}.errors`, SCOPE_ROOTS.errors);

    if (op.kind === 'trigger') {
        const t = op.trigger;
        if (t.type === 'webhook') {
            if (t.subscribe) {
                const { output, ...request } = t.subscribe;
                c.request(request, `${path}.trigger.subscribe`, SCOPE_ROOTS.subscribe);
                c.templates(output, `${path}.trigger.subscribe.output`, new Set([...SCOPE_ROOTS.subscribe, 'response']));
            }
            c.request(t.unsubscribe, `${path}.trigger.unsubscribe`, SCOPE_ROOTS.subscribe);
            c.request(t.renew?.request, `${path}.trigger.renew.request`, SCOPE_ROOTS.subscribe);
            c.templates(
                { verify: t.verify, handshake: t.handshake, filter: t.filter, event: t.event, dedupeKey: t.dedupeKey },
                `${path}.trigger`,
                SCOPE_ROOTS.delivery
            );
            if (t.unsubscribe && !t.subscribe) {
                c.warn(`${path}.trigger.unsubscribe`, 'trigger_unsubscribe_unused', 'unsubscribe without subscribe never runs');
            }
        } else {
            c.request(t.request, `${path}.trigger.request`, SCOPE_ROOTS.poll);
            c.templates({ items: t.items, cursor: t.cursor }, `${path}.trigger`, SCOPE_ROOTS.pollResult);
            c.templates({ dedupeKey: t.dedupeKey, event: t.event }, `${path}.trigger`, SCOPE_ROOTS.pollResult);
        }
        c.templates(op.output, `${path}.output`, SCOPE_ROOTS.output);
        return;
    }

    c.request(op.request, `${path}.request`, SCOPE_ROOTS.request);
    c.templates(op.output, `${path}.output`, SCOPE_ROOTS.output);
    if ((op.kind === 'search' || op.kind === 'options') && op.paginate) {
        const pg = op.paginate;
        c.templates({ items: pg.items, next: pg.next, hasMore: pg.hasMore }, `${path}.paginate`, SCOPE_ROOTS.paginate);
        if ((pg.style === 'cursor' || pg.style === 'nextUrl') && !pg.next) {
            c.error(`${path}.paginate.next`, 'paginate_next_missing', `the ${pg.style} style needs "next"`);
        }
        if ((pg.style === 'cursor' || pg.style === 'offset' || pg.style === 'page') && !pg.param) {
            c.error(`${path}.paginate.param`, 'paginate_param_missing', `the ${pg.style} style needs "param" (the query parameter to send)`);
        }
        if (pg.pageSize !== undefined && !pg.pageSizeParam) {
            c.warn(`${path}.paginate.pageSize`, 'paginate_page_size_unused', 'pageSize is only sent when pageSizeParam is set');
        }
    }
    if (op.kind === 'search' && !op.paginate && op.output === undefined) {
        c.warn(`${path}`, 'search_unmapped', 'a search without paginate or output returns the raw response body');
    }
}

/** Validate a connector. Never throws for a bad spec — inspect `diagnostics`. */
export function validateConnector(spec: unknown, options: ValidateOptions = {}): ValidationResult {
    const structural = validateAgainstSchema(conduitSchema, spec);
    if (structural.length > 0) {
        return {
            valid: false,
            diagnostics: structural.map((i) => ({ path: i.path, code: 'schema', message: i.message, severity: 'error' as const }))
        };
    }
    const connector = spec as ConnectorSpec;
    const c = new Collector(withFunctionNames(connector, options), new Set([...BUILTIN_ENCODINGS, ...(options.encodings ?? [])]));

    for (const [name, fn] of Object.entries(connector.functions ?? {})) {
        const path = `functions.${name}`;
        if (Object.hasOwn(STANDARD_FUNCTIONS, name)) c.warn(path, 'function_shadows', `"${name}" shadows a standard function`);
        const analysis = analyzeExpression(fn.body, {
            functions: c.functions,
            roots: new Set([...fn.params, 'config', 'env'])
        });
        for (const issue of analysis.issues) {
            if (issue.severity === 'error') c.error(`${path}.body`, 'expression_invalid', issue.message);
            else c.warn(`${path}.body`, 'expression_scope', issue.message);
        }
    }

    // Connector functions may call each other, but not recursively: a cycle
    // would only end at the evaluator's budget, one nested run at a time.
    const calls = new Map<string, Set<string>>();
    for (const [name, fn] of Object.entries(connector.functions ?? {})) {
        const used = analyzeExpression(fn.body).functions;
        calls.set(name, new Set([...used].filter((f) => Object.hasOwn(connector.functions!, f))));
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const reportedCycle = new Set<string>();
    const visit = (name: string, trail: string[]): void => {
        if (done.has(name)) return;
        if (visiting.has(name)) {
            const cycle = [...trail.slice(trail.indexOf(name)), name];
            const key = [...new Set(cycle)].sort().join(',');
            if (!reportedCycle.has(key)) {
                reportedCycle.add(key);
                c.error(`functions.${name}`, 'function_recursive', `functions call each other in a cycle: ${cycle.join(' → ')}`);
            }
            return;
        }
        visiting.add(name);
        for (const callee of calls.get(name) ?? []) visit(callee, [...trail, name]);
        visiting.delete(name);
        done.add(name);
    };
    for (const name of calls.keys()) visit(name, []);

    const authIds = new Set<string>();
    const operations = new Map<string, OperationSpec>();
    connector.operations.forEach((op, i) => {
        if (operations.has(op.id)) c.error(`operations[${i}].id`, 'duplicate_operation', `operation "${op.id}" is defined twice`);
        operations.set(op.id, op);
    });
    (connector.auth ?? []).forEach((m, i) => {
        if (authIds.has(m.id)) c.error(`auth[${i}].id`, 'duplicate_auth', `auth method "${m.id}" is defined twice`);
        authIds.add(m.id);
    });

    if (connector.http) {
        const { baseUrl, headers, query } = connector.http;
        c.templates({ baseUrl, headers, query }, 'http', SCOPE_ROOTS.http);
        c.templates(connector.http.errors, 'http.errors', SCOPE_ROOTS.errors);
        if (baseUrl && !baseUrl.includes('{{') && !/^https?:\/\//.test(baseUrl)) {
            c.error('http.baseUrl', 'base_url_invalid', 'baseUrl must be an absolute http(s) URL');
        }
    }
    (connector.auth ?? []).forEach((m, i) => checkAuth(c, m, `auth[${i}]`, operations));
    connector.operations.forEach((op, i) => checkOperation(c, op, `operations[${i}]`, authIds, operations));

    return { valid: !c.diagnostics.some((d) => d.severity === 'error'), diagnostics: c.diagnostics };
}

/** Validate and throw a `ConduitSpecError` listing every error. Returns the typed spec. */
export function assertValidConnector(spec: unknown, options: ValidateOptions = {}): ConnectorSpec {
    const result = validateConnector(spec, options);
    if (!result.valid) {
        const errors = result.diagnostics.filter((d) => d.severity === 'error');
        const id = (spec as { id?: unknown })?.id;
        const head = `connector ${typeof id === 'string' ? `"${id}" ` : ''}is invalid (${errors.length} error${errors.length === 1 ? '' : 's'})`;
        const lines = errors.slice(0, 10).map((d) => `  ${d.path || '(root)'}: ${d.message}`);
        if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
        throw new ConduitSpecError([head, ...lines].join('\n'), result.diagnostics);
    }
    return spec as ConnectorSpec;
}
