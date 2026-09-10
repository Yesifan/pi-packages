/**
 * Immutable project runtime snapshot (ADR-0004 Invariant 3).
 *
 * `cwd` is fixed at creation (realpath-normalized upstream); `accounts` is a
 * snapshot. The controller only reads this — never mutates it. Any change is a
 * desired-state diff that triggers a restart (`ProjectManager.sync`).
 */
export interface ProjectRuntimeConfig {
  projectId: string;
  cwd: string;
  accounts: string[];
}

/**
 * Runtime identity = `sorted(accounts)` (ADR-0003 D-B). `projectId`/`cwd` are
 * fixed, so the account set is the only variable that can change a runtime's
 * identity. A key change means stop the old runtime and build a new one.
 */
export function runtimeKeyOf(accounts: string[]): string {
  return [...accounts].sort().join(",");
}
