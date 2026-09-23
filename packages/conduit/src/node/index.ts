/**
 * `@aigntiq/conduit/node` — the only entry that touches Node built-ins.
 */
export { fileSource, type FileSourceOptions } from './file-source';
export { createNodeHandler, toRequest, type NodeHandlerOptions, type NodeRequestHandler } from './handler';
