import type {
  AgentSession,
  AgentSessionRuntime,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../util/logger.js";
import type { HostExtensionMode, SessionSwitchResult } from "./types.js";

export interface ExtensionRuntimeFailure {
  extensionPath?: string;
  event?: string;
  stack?: string;
  error: unknown;
}

export interface PiExtensionHostDeps {
  uiContext?: ExtensionUIContext;
  mode: HostExtensionMode;
  logger: Logger;
  onError?: (error: ExtensionRuntimeFailure) => void;
}

/**
 * Single place that calls `AgentSession.bindExtensions` (ADR-0004 Invariant,
 * W5). Bound on the `setRebindSession` rebind path so extensions survive every
 * session replacement (`/new`, fork, switchSession).
 *
 * Six `commandContextActions` are wired to the real public API:
 *   waitForIdle → session.waitForIdle
 *   newSession  → runtime.newSession  (transparent `{cancelled}`)
 *   fork        → runtime.fork
 *   navigateTree→ session.navigateTree
 *   switchSession → runtime.switchSession
 *   reload      → session.reload
 */
export class PiExtensionHost {
  constructor(private readonly deps: PiExtensionHostDeps) {}

  async bind(session: AgentSession, runtime: AgentSessionRuntime): Promise<void> {
    await session.bindExtensions({
      uiContext: this.deps.uiContext,
      mode: this.deps.mode,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options): Promise<SessionSwitchResult> => {
          const r = await runtime.newSession(options);
          return { cancelled: r.cancelled };
        },
        fork: async (entryId, options): Promise<SessionSwitchResult> => {
          const r = await runtime.fork(entryId, options);
          return { cancelled: r.cancelled };
        },
        navigateTree: async (targetId, options): Promise<SessionSwitchResult> => {
          const r = await session.navigateTree(targetId, options);
          return { cancelled: r.cancelled };
        },
        switchSession: async (sessionPath, options): Promise<SessionSwitchResult> => {
          const r = await runtime.switchSession(sessionPath, options);
          return { cancelled: r.cancelled };
        },
        reload: () => session.reload(),
      },
      onError: (error) => {
        this.deps.logger.error(
          { extension: error.extensionPath, event: error.event, stack: error.stack, error: error.error },
          "extension runtime error",
        );
        this.deps.onError?.(error);
      },
    });
  }
}
