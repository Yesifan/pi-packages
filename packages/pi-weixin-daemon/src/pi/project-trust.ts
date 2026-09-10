import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Resolve whether this project's trust-requiring resources should load.
 *
 * Mirrors pi's official resolution (ADR-0001): nearest saved decision in
 * `~/.pi/agent/trust.json`, otherwise fall back to `defaultProjectTrust`
 * ("always" trusts; "ask"/"never" decline in non-interactive mode).
 */
export function resolveProjectTrust(cwd: string, agentDir: string): boolean {
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const saved = new ProjectTrustStore(agentDir).get(cwd);
  if (saved !== null) return saved;
  return SettingsManager.create(cwd, agentDir).getDefaultProjectTrust() === "always";
}
