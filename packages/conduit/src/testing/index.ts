/**
 * `@aigntiq/conduit/testing` — the port conformance suites. Runner-agnostic
 * and runtime-neutral: suites are data, registered with the host's own
 * `describe`/`it` through `registerConformance`.
 */
export {
    accountStoreConformance,
    transientStoreConformance,
    lockProviderConformance,
    registerConformance,
    ConformanceError,
    type ConformanceCase,
    type ConformanceSuite,
    type TestRegistrar
} from './conformance';
