import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTestSessions } from "./helpers/session-cleanup.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Vitest global setup/teardown. Vitest calls `teardown` once after the whole
 * test run finishes, at which point we remove every Pi session created for
 * test projects under test/.tmp. Using globalSetup (with teardown) is the
 * Vitest-4-supported hook; there is no globalTeardown config key.
 */
export function setup(): void {
  process.chdir(PACKAGE_ROOT);
  fs.mkdirSync(path.join(PACKAGE_ROOT, "test/.tmp"), { recursive: true });
}

export function teardown(): void {
  cleanupTestSessions();
}
