import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  SettingsManager,
  type AgentSessionRuntimeDiagnostic,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { resolveProjectTrust } from "./project-trust.js";

/** Thrown when a fatal diagnostic (extension/settings/service error) is found. */
export class PiInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiInitializationError";
  }
}

export interface PiRuntimeFactoryOptions {
  cwd: string;
  /** In-memory extensions injected into every session (e.g. weixin_send_file). */
  extensionFactories?: ExtensionFactory[];
}

/**
 * The SDK `createAgentSessionRuntime` factory callback (ADR-0004).
 *
 * It is stored by `createAgentSessionRuntime` and re-run on every session
 * replacement (`/new`, fork, switchSession), so it must be idempotent and
 * re-entrant. It also collects the full diagnostics set required for W1
 * fail-closed startup: services diagnostics + settings errors (warning) +
 * extension load errors (error).
 */
export function createPiRuntimeFactory(opts: PiRuntimeFactoryOptions): CreateAgentSessionRuntimeFactory {
  return async ({ cwd: factoryCwd, sessionManager, sessionStartEvent }) => {
    const agentDir = getAgentDir();

    const services = await createAgentSessionServices({
      cwd: factoryCwd,
      agentDir,
      settingsManager: SettingsManager.create(factoryCwd, agentDir),
      resourceLoaderOptions: opts.extensionFactories?.length
        ? { extensionFactories: opts.extensionFactories }
        : undefined,
      // Gate trust-requiring project resources behind the SDK's project-trust
      // decision (mirror pi-web / the pi CLI; ADR-0001).
      ...(hasTrustRequiringProjectResources(factoryCwd)
        ? {
            resourceLoaderReloadOptions: {
              resolveProjectTrust: async () => resolveProjectTrust(factoryCwd, agentDir),
            },
          }
        : {}),
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });

    return {
      ...result,
      services,
      diagnostics: collectDiagnostics(services),
    };
  };
}

/** Merge all diagnostics sources into a single `AgentSessionRuntimeDiagnostic[]`. */
function collectDiagnostics(services: AgentSessionServices): AgentSessionRuntimeDiagnostic[] {
  const diagnostics: AgentSessionRuntimeDiagnostic[] = [...services.diagnostics];
  for (const e of services.settingsManager.drainErrors()) {
    diagnostics.push({
      type: "warning",
      message: `settings error (${e.scope}): ${e.error instanceof Error ? e.error.message : String(e.error)}`,
    });
  }
  for (const e of services.resourceLoader.getExtensions().errors) {
    diagnostics.push({ type: "error", message: `extension load error (${e.path}): ${e.error}` });
  }
  return diagnostics;
}
