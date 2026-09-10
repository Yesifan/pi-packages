/** Daemon-owned diagnostic (NOT the SDK's `AgentSessionRuntimeDiagnostic`). */
export interface Diagnostic {
  type: "info" | "warning" | "error";
  message: string;
}

/** True when any diagnostic is fatal (extension/settings/service error). */
export function hasFatalDiagnostics(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.type === "error");
}
