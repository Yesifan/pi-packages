import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type Extension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SubagentError } from "./errors.js";
import { createDelegationExtension, type DelegationRuntimeApi } from "./tools.js";
import type { CallerBinding, DelegationContext, StoredSubagent, ThinkingLevel } from "./types.js";
import type { RootUiBroker, SubagentUiProxy } from "./ui.js";

const BUILTIN_TOOL_NAMES = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "ask_subagent",
]);

function isOwnExtension(extension: Extension, ownExtensionPath: string): boolean {
  return (
    path.resolve(extension.resolvedPath) === path.resolve(ownExtensionPath) ||
    path.resolve(extension.path) === path.resolve(ownExtensionPath)
  );
}

function assertRoleToolsAvailable(
  tools: readonly string[] | undefined,
  extensions: Extension[],
): void {
  if (!tools) return;
  const available = new Set(BUILTIN_TOOL_NAMES);
  for (const extension of extensions) {
    for (const tool of extension.tools.keys()) available.add(tool);
  }
  const unknown = tools.filter((tool) => !available.has(tool));
  if (unknown.length > 0) {
    throw new SubagentError(
      "TOOL_UNAVAILABLE",
      `Agent role requests unavailable tools: ${unknown.join(", ")}`,
    );
  }
}

export interface OpenChildOptions {
  stored: StoredSubagent;
  runId: string;
  runtime: DelegationRuntimeApi;
  delegationContext?: DelegationContext;
  canDelegate: boolean;
  sessionManager: SessionManager;
  model?: Model<Api>;
  thinking: ThinkingLevel;
}

export interface OpenedChild {
  session: AgentSession;
  ui: SubagentUiProxy;
  actualThinking: ThinkingLevel;
  dispose(): Promise<void>;
}

export class ChildSessionFactory {
  constructor(
    private readonly agentDir: string,
    private readonly ownExtensionPath: string,
    private readonly uiBroker: RootUiBroker,
    private readonly resolveTrust: (cwd: string) => Promise<boolean>,
  ) {}

  async createSessionManager(cwd: string, sessionsDirectory: string): Promise<SessionManager> {
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    return SessionManager.create(cwd, sessionsDirectory);
  }

  openSessionManager(stored: StoredSubagent): SessionManager {
    const sessionManager = SessionManager.open(stored.sessionFile);
    if (path.resolve(sessionManager.getCwd()) !== path.resolve(stored.cwd)) {
      throw new SubagentError(
        "SESSION_HISTORY_UNAVAILABLE",
        `Stored session cwd does not match subagent cwd: ${stored.sessionFile}`,
        stored.id,
      );
    }
    return sessionManager;
  }

  async open(options: OpenChildOptions): Promise<OpenedChild> {
    const { stored } = options;
    const trusted = await this.resolveTrust(stored.cwd);
    if (!trusted) {
      throw new SubagentError("PROJECT_NOT_TRUSTED", `Project is not trusted: ${stored.cwd}`);
    }
    const settingsManager = SettingsManager.create(stored.cwd, this.agentDir);
    const childBinding: CallerBinding | undefined =
      options.canDelegate && options.delegationContext
        ? {
            agentId: stored.id,
            depth: stored.depth,
            ancestorCwds: stored.ancestorCwds,
            delegation: options.delegationContext,
          }
        : undefined;
    const internalFactory = childBinding
      ? createDelegationExtension(options.runtime, childBinding)
      : undefined;
    const runtimePrompt = `You are subagent "${stored.name}" (${stored.id}), delegated by a parent agent.
Work on the assigned task using the resources and instructions available in this session.
You do not inherit the parent's conversation history.
Your final response is automatically reported to your direct parent.
There is no report tool.`;

    // Warning Cache Broke: changing this append order changes the stable system-prompt prefix
    // for every restored logical subagent. Current-role identity must remain snapshot-backed.
    const resourceLoader = new DefaultResourceLoader({
      cwd: stored.cwd,
      agentDir: this.agentDir,
      settingsManager,
      ...(internalFactory
        ? {
            extensionFactories: [
              { name: `pi-subagents:${stored.id}`, factory: internalFactory, hidden: true },
            ],
          }
        : {}),
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(
          (extension) => !isOwnExtension(extension, this.ownExtensionPath),
        ),
      }),
      appendSystemPromptOverride: (base) => [
        ...base,
        runtimePrompt,
        stored.agentDefinitionSnapshot.prompt,
      ],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => trusted });
    const extensionsResult = resourceLoader.getExtensions();
    const extensions = extensionsResult.extensions;
    assertRoleToolsAvailable(stored.agentDefinitionSnapshot.tools, extensions);

    // Each mounted child gets a fresh model runtime. Provider registrations are mutable;
    // sharing one here would leak one cwd's extension-provided providers into another session.
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(this.agentDir, "auth.json"),
      modelsPath: path.join(this.agentDir, "models.json"),
    });
    for (const registration of extensionsResult.runtime.pendingProviderRegistrations) {
      modelRuntime.registerProvider(registration.name, registration.config);
    }
    extensionsResult.runtime.pendingProviderRegistrations = [];
    for (const registration of extensionsResult.runtime.pendingNativeProviderRegistrations) {
      modelRuntime.registerNativeProvider(registration.provider);
    }
    extensionsResult.runtime.pendingNativeProviderRegistrations = [];
    await modelRuntime.refresh({ allowNetwork: false });
    const model =
      modelRuntime.getModel(stored.model.provider, stored.model.id) ??
      (options.model?.provider === stored.model.provider && options.model.id === stored.model.id
        ? options.model
        : undefined);
    if (!model || !modelRuntime.hasConfiguredAuth(stored.model.provider)) {
      throw new SubagentError(
        "MODEL_AUTH_UNAVAILABLE",
        `Model or authentication is unavailable for ${stored.model.provider}/${stored.model.id}`,
        stored.id,
      );
    }

    let session: AgentSession | undefined;
    const ui = this.uiBroker.proxy(stored.id, stored.name);
    try {
      const created = await createAgentSession({
        cwd: stored.cwd,
        agentDir: this.agentDir,
        modelRuntime,
        model,
        thinkingLevel: options.thinking,
        ...(stored.agentDefinitionSnapshot.tools
          ? { tools: stored.agentDefinitionSnapshot.tools }
          : {}),
        resourceLoader,
        sessionManager: options.sessionManager,
        settingsManager,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      session = created.session;
      await session.bindExtensions({
        uiContext: ui,
        mode: "tui",
        abortHandler: () => {
          void session?.abort();
        },
        shutdownHandler: () => {
          void session?.abort();
        },
        onError: (error) => {
          ui.notify(`${error.event}: ${error.error}`, "error");
        },
      });
      const openedSession = session;
      return {
        session: openedSession,
        ui,
        actualThinking: openedSession.thinkingLevel as ThinkingLevel,
        dispose: async () => {
          ui.dispose();
          try {
            const runner = openedSession.extensionRunner;
            if (runner.hasHandlers("session_shutdown")) {
              await Promise.race([
                runner.emit({ type: "session_shutdown", reason: "quit" }),
                new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, 5_000);
                  timer.unref();
                }),
              ]);
            }
          } finally {
            openedSession.dispose();
          }
        },
      };
    } catch (error) {
      ui.dispose();
      session?.dispose();
      throw error;
    }
  }
}
