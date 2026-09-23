/**
 * The canonical JSON Schema for `conduit/1` connector specs.
 *
 * `packages/conduit/schema/conduit-1.schema.json` is generated from this
 * object (`pnpm gen:schema`); a test fails when they drift. Point an editor
 * at that file (or at `"$schema": "https://unpkg.com/@aigntiq/conduit/schema/conduit-1.schema.json"`)
 * for completion while writing a connector.
 */
import { WIDGETS } from '../spec/types';
import type { SchemaNode } from './validator';

const template = { description: 'A template: any JSON value; strings may contain {{ expressions }}.' };
const templateString = { type: 'string', description: 'A template string.' };
const templateMap = { type: 'object', additionalProperties: template };
const id = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$', maxLength: 64 };
const errorKind = { enum: ['auth', 'forbidden', 'notFound', 'rateLimited', 'validation', 'conflict', 'transient', 'fatal'] };

const authBase = {
    id: { $ref: '#/$defs/id' },
    label: { type: 'string' },
    description: { type: 'string' },
    inputs: { $ref: '#/$defs/inputSchema' },
    apply: { $ref: '#/$defs/apply' },
    test: { $ref: '#/$defs/request' },
    identity: { $ref: '#/$defs/identity' },
    refreshSkewSec: { type: 'integer', minimum: 0 },
    setup: { type: 'string' },
    helpUrl: { type: 'string' }
};

const operationBase = {
    id: { $ref: '#/$defs/id' },
    label: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    auth: { anyOf: [{ type: 'array', items: { $ref: '#/$defs/id' } }, { const: false }] },
    inputs: { $ref: '#/$defs/inputSchema' },
    outputs: { type: 'object' },
    steps: { type: 'array', items: { $ref: '#/$defs/step' } },
    output: template,
    errors: { type: 'array', items: { $ref: '#/$defs/errorRule' } },
    retry: { anyOf: [{ $ref: '#/$defs/retry' }, { const: false }] },
    hidden: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    group: { type: 'string', minLength: 1 },
    destructive: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    helpUrl: { type: 'string' }
};

const requestProperties = {
    method: { type: 'string', minLength: 1 },
    url: templateString,
    query: { anyOf: [templateMap, templateString] },
    headers: templateMap,
    body: template,
    // Built-ins: json, form, multipart, text, binary. Plugins can add more,
    // so the name is checked semantically (validateConnector), not here.
    encoding: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    responseType: { enum: ['auto', 'json', 'text', 'binary'] },
    timeoutMs: { type: 'integer', minimum: 1 },
    auth: { type: 'boolean' }
};

export const conduitSchema: SchemaNode = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://unpkg.com/@aigntiq/conduit/schema/conduit-1.schema.json',
    title: 'Conduit connector (conduit/1)',
    type: 'object',
    required: ['spec', 'id', 'name', 'version', 'operations'],
    additionalProperties: false,
    properties: {
        $schema: { type: 'string' },
        spec: { const: 'conduit/1' },
        id: { $ref: '#/$defs/id' },
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$' },
        description: { type: 'string' },
        icon: { type: 'string' },
        homepage: { type: 'string' },
        brandColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        helpUrl: { type: 'string' },
        categories: { type: 'array', items: { type: 'string' } },
        config: { type: 'object' },
        http: { $ref: '#/$defs/http' },
        functions: {
            type: 'object',
            propertyNames: { pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$' },
            additionalProperties: {
                type: 'object',
                required: ['params', 'body'],
                additionalProperties: false,
                properties: {
                    params: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$' } },
                    body: { type: 'string', minLength: 1 },
                    description: { type: 'string' }
                }
            }
        },
        auth: { type: 'array', items: { $ref: '#/$defs/authMethod' } },
        operations: { type: 'array', items: { $ref: '#/$defs/operation' } }
    },
    $defs: {
        id,
        http: {
            type: 'object',
            additionalProperties: false,
            properties: {
                baseUrl: templateString,
                headers: templateMap,
                query: templateMap,
                timeoutMs: { type: 'integer', minimum: 1 },
                retry: { $ref: '#/$defs/retry' },
                errors: { type: 'array', items: { $ref: '#/$defs/errorRule' } },
                allowHosts: { type: 'array', items: { type: 'string', minLength: 1 } }
            }
        },
        retry: {
            type: 'object',
            additionalProperties: false,
            properties: {
                attempts: { type: 'integer', minimum: 1, maximum: 10 },
                initialDelayMs: { type: 'integer', minimum: 0 },
                maxDelayMs: { type: 'integer', minimum: 0 },
                factor: { type: 'number', minimum: 1 },
                on: { type: 'array', items: errorKind }
            }
        },
        errorRule: {
            type: 'object',
            required: ['when', 'error'],
            additionalProperties: false,
            properties: {
                when: templateString,
                error: errorKind,
                message: templateString,
                retryable: { type: 'boolean' },
                field: { type: 'string', minLength: 1 }
            }
        },
        request: {
            type: 'object',
            required: ['url'],
            additionalProperties: false,
            properties: requestProperties
        },
        step: {
            type: 'object',
            required: ['name', 'url'],
            additionalProperties: false,
            properties: {
                ...requestProperties,
                name: { type: 'string', pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$' },
                when: templateString,
                output: template
            }
        },
        condition: {
            type: 'object',
            additionalProperties: {
                anyOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        minProperties: 1,
                        properties: { in: { type: 'array' }, notEmpty: { const: true }, empty: { const: true } }
                    },
                    { type: ['string', 'number', 'integer', 'boolean', 'null', 'array'] }
                ]
            }
        },
        inputProperty: {
            type: 'object',
            required: ['type'],
            additionalProperties: false,
            properties: {
                $comment: { type: 'string' },
                examples: { type: 'array' },
                readOnly: { type: 'boolean' },
                deprecated: { type: 'boolean' },
                oneOf: {
                    type: 'array',
                    minItems: 1,
                    items: {
                        type: 'object',
                        required: ['const'],
                        additionalProperties: false,
                        properties: { const: {}, title: { type: 'string' }, description: { type: 'string' } }
                    }
                },
                type: { enum: ['string', 'number', 'integer', 'boolean', 'array', 'object'] },
                title: { type: 'string' },
                description: { type: 'string' },
                default: {},
                enum: { type: 'array' },
                format: { type: 'string' },
                items: { $ref: '#/$defs/inputProperty' },
                properties: { type: 'object', additionalProperties: { $ref: '#/$defs/inputProperty' } },
                required: { type: 'array', items: { type: 'string' } },
                minimum: { type: 'number' },
                maximum: { type: 'number' },
                minLength: { type: 'integer', minimum: 0 },
                maxLength: { type: 'integer', minimum: 0 },
                pattern: { type: 'string' },
                minItems: { type: 'integer', minimum: 0 },
                maxItems: { type: 'integer', minimum: 0 },
                'x-secret': { type: 'boolean' },
                'x-widget': { enum: [...WIDGETS] },
                'x-placeholder': { type: 'string' },
                'x-group': { type: 'string', minLength: 1 },
                'x-order': { type: 'number' },
                'x-advanced': { type: 'boolean' },
                'x-visibleWhen': { $ref: '#/$defs/condition' },
                'x-requiredWhen': { $ref: '#/$defs/condition' },
                'x-options': {
                    type: 'object',
                    required: ['operation'],
                    additionalProperties: false,
                    properties: {
                        operation: { $ref: '#/$defs/id' },
                        inputs: templateMap,
                        dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true },
                        search: { type: 'string', minLength: 1 }
                    }
                },
                'x-accept': { type: 'string' },
                'x-maxBytes': { type: 'integer', minimum: 1 },
                'x-language': { type: 'string' },
                'x-errorMessage': { type: 'object', additionalProperties: { type: 'string' } }
            }
        },
        inputSchema: {
            type: 'object',
            required: ['type', 'properties'],
            additionalProperties: false,
            properties: {
                type: { const: 'object' },
                properties: { type: 'object', additionalProperties: { $ref: '#/$defs/inputProperty' } },
                required: { type: 'array', items: { type: 'string' }, uniqueItems: true },
                'x-rules': {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['check', 'message'],
                        additionalProperties: false,
                        properties: {
                            check: templateString,
                            message: { type: 'string', minLength: 1 },
                            fields: { type: 'array', items: { type: 'string' } }
                        }
                    }
                }
            }
        },
        apply: {
            type: 'object',
            additionalProperties: false,
            properties: { headers: templateMap, query: templateMap }
        },
        identity: {
            type: 'object',
            additionalProperties: false,
            properties: {
                request: { $ref: '#/$defs/request' },
                id: templateString,
                name: templateString,
                data: template
            }
        },
        tokenMapping: {
            type: 'object',
            additionalProperties: false,
            properties: {
                accessToken: templateString,
                refreshToken: templateString,
                expiresIn: templateString,
                expiresAt: templateString,
                tokenType: templateString,
                scope: templateString,
                data: template
            }
        },
        authMethod: {
            oneOf: [
                {
                    type: 'object',
                    required: ['id', 'type', 'tokenUrl'],
                    additionalProperties: false,
                    properties: {
                        ...authBase,
                        type: { const: 'oauth2' },
                        grant: { enum: ['authorization_code', 'client_credentials'] },
                        authorizeUrl: templateString,
                        tokenUrl: templateString,
                        refreshUrl: templateString,
                        revokeUrl: templateString,
                        scopes: { type: 'array', items: { type: 'string' } },
                        scopeSeparator: { type: 'string' },
                        pkce: { type: 'boolean' },
                        clientAuth: { enum: ['body', 'basic'] },
                        authorizeParams: templateMap,
                        tokenParams: templateMap,
                        token: { $ref: '#/$defs/tokenMapping' },
                        client: {
                            type: 'object',
                            additionalProperties: false,
                            properties: { id: templateString, secret: templateString }
                        }
                    }
                },
                {
                    type: 'object',
                    required: ['id', 'type', 'name'],
                    additionalProperties: false,
                    properties: {
                        ...authBase,
                        type: { const: 'apiKey' },
                        in: { enum: ['header', 'query'] },
                        name: { type: 'string', minLength: 1 },
                        prefix: { type: 'string' },
                        value: templateString
                    }
                },
                {
                    type: 'object',
                    required: ['id', 'type'],
                    additionalProperties: false,
                    properties: { ...authBase, type: { const: 'basic' } }
                },
                {
                    type: 'object',
                    required: ['id', 'type'],
                    additionalProperties: false,
                    properties: { ...authBase, type: { const: 'bearer' } }
                },
                {
                    type: 'object',
                    required: ['id', 'type', 'jwt'],
                    additionalProperties: false,
                    properties: {
                        ...authBase,
                        type: { const: 'jwt' },
                        jwt: {
                            type: 'object',
                            required: ['algorithm', 'key', 'claims'],
                            additionalProperties: false,
                            properties: {
                                algorithm: { enum: ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'] },
                                key: templateString,
                                claims: template,
                                header: template,
                                lifetimeSec: { type: 'integer', minimum: 1 }
                            }
                        },
                        exchange: {
                            type: 'object',
                            required: ['request'],
                            additionalProperties: false,
                            properties: { request: { $ref: '#/$defs/request' }, token: { $ref: '#/$defs/tokenMapping' } }
                        }
                    }
                },
                {
                    type: 'object',
                    required: ['id', 'type', 'apply'],
                    additionalProperties: false,
                    properties: {
                        ...authBase,
                        type: { const: 'custom' },
                        steps: { type: 'array', items: { $ref: '#/$defs/step' } },
                        credentials: template,
                        expiresIn: templateString
                    }
                }
            ]
        },
        paginate: {
            type: 'object',
            required: ['style', 'items'],
            additionalProperties: false,
            properties: {
                style: { enum: ['cursor', 'offset', 'page', 'nextUrl', 'linkHeader'] },
                items: templateString,
                next: templateString,
                hasMore: templateString,
                param: { type: 'string', minLength: 1 },
                pageSize: { type: 'integer', minimum: 1 },
                pageSizeParam: { type: 'string', minLength: 1 },
                start: { type: 'integer', minimum: 0 },
                maxPages: { type: 'integer', minimum: 1 },
                maxItems: { type: 'integer', minimum: 1 }
            }
        },
        verify: {
            oneOf: [
                {
                    type: 'object',
                    required: ['type', 'header'],
                    additionalProperties: false,
                    properties: {
                        type: { const: 'hmac' },
                        header: { type: 'string', minLength: 1 },
                        algorithm: { enum: ['sha1', 'sha256', 'sha512'] },
                        encoding: { enum: ['hex', 'base64'] },
                        prefix: { type: 'string' },
                        secret: templateString,
                        payload: templateString,
                        timestampHeader: { type: 'string' },
                        toleranceSec: { type: 'integer', minimum: 1 }
                    }
                },
                {
                    type: 'object',
                    required: ['type', 'header'],
                    additionalProperties: false,
                    properties: { type: { const: 'token' }, header: { type: 'string', minLength: 1 }, value: templateString }
                },
                {
                    type: 'object',
                    required: ['type', 'valid'],
                    additionalProperties: false,
                    properties: { type: { const: 'custom' }, valid: templateString }
                }
            ]
        },
        trigger: {
            oneOf: [
                {
                    type: 'object',
                    required: ['type', 'event'],
                    additionalProperties: false,
                    properties: {
                        type: { const: 'webhook' },
                        subscribe: {
                            type: 'object',
                            required: ['url'],
                            additionalProperties: false,
                            properties: { ...requestProperties, output: template }
                        },
                        unsubscribe: { $ref: '#/$defs/request' },
                        renew: {
                            type: 'object',
                            required: ['everyMinutes', 'request'],
                            additionalProperties: false,
                            properties: { everyMinutes: { type: 'integer', minimum: 1 }, request: { $ref: '#/$defs/request' } }
                        },
                        verify: { $ref: '#/$defs/verify' },
                        handshake: {
                            type: 'object',
                            required: ['when', 'respond'],
                            additionalProperties: false,
                            properties: {
                                when: templateString,
                                respond: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: { status: { type: 'integer' }, headers: templateMap, body: template }
                                }
                            }
                        },
                        filter: templateString,
                        event: template,
                        dedupeKey: templateString
                    }
                },
                {
                    type: 'object',
                    required: ['type', 'request', 'items', 'dedupeKey'],
                    additionalProperties: false,
                    properties: {
                        type: { const: 'poll' },
                        intervalSec: { type: 'integer', minimum: 10 },
                        request: { $ref: '#/$defs/request' },
                        items: templateString,
                        cursor: templateString,
                        dedupeKey: templateString,
                        event: template
                    }
                }
            ]
        },
        operation: {
            oneOf: [
                {
                    type: 'object',
                    required: ['id', 'kind', 'label', 'request'],
                    additionalProperties: false,
                    properties: { ...operationBase, kind: { const: 'action' }, request: { $ref: '#/$defs/request' } }
                },
                {
                    type: 'object',
                    required: ['id', 'kind', 'label', 'request'],
                    additionalProperties: false,
                    properties: {
                        ...operationBase,
                        kind: { const: 'search' },
                        request: { $ref: '#/$defs/request' },
                        paginate: { $ref: '#/$defs/paginate' }
                    }
                },
                {
                    type: 'object',
                    required: ['id', 'kind', 'label', 'request'],
                    additionalProperties: false,
                    properties: {
                        ...operationBase,
                        kind: { const: 'options' },
                        request: { $ref: '#/$defs/request' },
                        paginate: { $ref: '#/$defs/paginate' }
                    }
                },
                {
                    type: 'object',
                    required: ['id', 'kind', 'label', 'trigger'],
                    additionalProperties: false,
                    properties: { ...operationBase, kind: { const: 'trigger' }, trigger: { $ref: '#/$defs/trigger' } }
                }
            ]
        }
    }
};
