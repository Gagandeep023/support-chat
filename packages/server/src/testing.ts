/**
 * Test-only exports.
 *
 * Deliberately a separate entry point. The conformance suite imports vitest, and
 * putting it on the main entry bundles a test runner into every production
 * install: the server then fails to boot with "Vitest failed to access its
 * internal state", which is a mystifying error to debug from an application
 * that never mentioned vitest.
 */
export { describeDataStore, type ConformanceHarness } from "./stores/conformance.js";
