/**
 * `@aigntiq/conduit/testing` — alias-only inside this workspace, never
 * published: the mock provider and the port conformance suites.
 */
export { mockProvider, type MockProvider, type MockProviderOptions, type RecordedRequest, type Contact } from './mock-provider';
export { accountStoreConformance, transientStoreConformance, lockProviderConformance } from './conformance';
