import { cleanupTestSessions } from "./helpers/session-cleanup.js";

/**
 * Vitest global setup/teardown. Vitest calls `teardown` once after the whole
 * test run finishes, at which point we remove every Pi session created for
 * test projects under test/.tmp. Using globalSetup (with teardown) is the
 * Vitest-4-supported hook; there is no globalTeardown config key.
 */
export function setup(): void {
  // nothing to prepare up-front
}

export function teardown(): void {
  cleanupTestSessions();
}
