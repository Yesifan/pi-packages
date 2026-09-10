import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

/**
 * CLI-facing SDK introspection helpers.
 *
 * The `pi-wx doctor` / `pi-wx status` commands need to inspect the pinned SDK;
 * those SDK imports live here (inside `src/pi/`) so the CLI itself never imports
 * `@earendil-works/pi-coding-agent` directly (ADR-0004 Invariant 1).
 */

/** Resolve the bundled pi-coding-agent SDK version (best-effort). */
export function piSdkVersion(): string {
  return VERSION ?? "?";
}

/** True when the pinned SDK exposes the embedding API the daemon relies on. */
export function isPiSdkAvailable(): boolean {
  return typeof createAgentSessionRuntime === "function" && typeof SessionManager === "function";
}

export interface ModelAvailabilityResult {
  ok: boolean;
  detail: string;
}

/**
 * Check whether the configured default provider/model has credentials available.
 * Used by `pi-wx doctor`.
 */
export async function checkModelAvailability(settings: {
  defaultProvider?: string;
  defaultModel?: string;
}): Promise<ModelAvailabilityResult> {
  const provider = settings.defaultProvider;
  const model = settings.defaultModel;
  if (!provider) {
    return { ok: false, detail: "no defaultProvider in settings.json" };
  }
  const mr = await ModelRuntime.create({ allowModelNetwork: false });
  const available = (await mr.getAvailable()) as unknown as Array<{ provider?: string; id?: string }>;
  const hasProvider = available.some((m) => m.provider === provider);
  const hasModel = model
    ? available.some((m) => m.provider === provider && m.id === model)
    : hasProvider;
  return {
    ok: hasModel,
    detail: hasModel
      ? `${provider}/${model ?? "(any)"} available`
      : `${provider}/${model ?? "(any)"} NOT available — no API key/credentials; see README "配置模型 API key"`,
  };
}
