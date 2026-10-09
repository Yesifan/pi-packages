import { constants } from "node:fs";
import { chmod, lstat, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type Extension,
  getAgentDir,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SubagentError } from "./errors.js";
import { createDelegationExtension, type DelegationRuntimeApi } from "./tools.js";
import {
  type Agent,
  type AgentDefinitionSnapshot,
  type CallerBinding,
  type DelegationContext,
  type SessionIdentity,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./types.js";
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

// SDK 1.0.0's branch selection is not exported. Mirror its selection using public
// entries/catalog only: a registered virtual model_change holds over physical replies.
function historicalModel(branch: SessionEntry[], runtime: ModelRuntime): Model<Api> {
  let selection: { provider: string; modelId: string } | undefined;
  let change: typeof selection;
  for (const entry of branch) {
    if (entry.type === "model_change") {
      change = { provider: entry.provider, modelId: entry.modelId };
      selection = change;
    } else if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.api !== "pi-virtual"
    ) {
      selection =
        change && runtime.getModel(change.provider, change.modelId)?.api === "pi-virtual"
          ? change
          : { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  if (
    !selection ||
    typeof selection.provider !== "string" ||
    !selection.provider ||
    typeof selection.modelId !== "string" ||
    !selection.modelId
  ) {
    throw new SubagentError(
      "MODEL_UNAVAILABLE",
      "Child history has no valid historical model selection",
    );
  }
  const model = runtime.getModel(selection.provider, selection.modelId);
  if (!model) {
    throw new SubagentError(
      "MODEL_UNAVAILABLE",
      `Historical model is unavailable: ${selection.provider}/${selection.modelId}`,
    );
  }
  return model;
}

export interface OpenChildOptions {
  name: string;
  roleSnapshot: AgentDefinitionSnapshot;
  cwd: string;
  depth: number;
  ancestorCwds: string[];
  runtime: DelegationRuntimeApi;
  callerAgent: Agent;
  delegationContext?: DelegationContext;
  canDelegate: boolean;
  sessionManager: SessionManager;
  model?: Model<Api>;
  thinking?: ThinkingLevel;
  restoring?: boolean;
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

  async createSessionManager(cwd: string): Promise<SessionManager> {
    let sessionFile: string | undefined;
    let precreated = false;
    try {
      // Observe existing directories before the SDK creates its default path. Do not
      // reproduce cwd encoding or use the CLI/env/settings sessionDir resolver.
      // getAgentDir handles SDK tilde/file URL/shell-path normalization; the
      // default allocator additionally resolves relative agentDir against process.cwd().
      const sessionsRoot = path.join(path.resolve(getAgentDir()), "sessions");
      const existing = new Set<string>();
      let ancestor = sessionsRoot;
      while (true) {
        try {
          const entry = await lstat(ancestor);
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw new Error(
              `History ancestor must be an ordinary nonsymlink directory: ${ancestor}`,
            );
          }
          existing.add(ancestor);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      try {
        // The public allocator has no read-only directory lookup. Check existing
        // cwd groups before calling it, rather than duplicating SDK cwd encoding.
        for (const name of await readdir(sessionsRoot)) {
          const directory = path.join(sessionsRoot, name);
          const entry = await lstat(directory);
          if (entry.isSymbolicLink()) {
            throw new Error(`History group must not be a symlink: ${directory}`);
          }
          if (entry.isDirectory()) existing.add(directory);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const allocated = SessionManager.create(cwd);
      sessionFile = allocated.getSessionFile();
      if (!sessionFile) throw new Error("SDK did not allocate a persistent child history");
      let directory = path.dirname(sessionFile);
      while (!existing.has(directory)) {
        await chmod(directory, 0o700);
        directory = path.dirname(directory);
      }
      // Warning Cache Broke: the SDK owns header/history initialization. Opening the
      // exclusively precreated private file assigns the actual identity (not the allocator's ID).
      await writeFile(sessionFile, "", { flag: "wx", mode: 0o600 });
      precreated = true;
      return SessionManager.open(sessionFile, path.dirname(sessionFile), cwd);
    } catch (error) {
      if (precreated && sessionFile) await rm(sessionFile, { force: true });
      throw new SubagentError(
        "STORE_ERROR",
        `Cannot create child session history for ${cwd}`,
        undefined,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async openSessionManager(identity: SessionIdentity): Promise<SessionManager> {
    try {
      const sessionFile = path.resolve(identity.sessionFile);
      const fileStat = await lstat(sessionFile);
      if (
        !path.isAbsolute(identity.sessionFile) ||
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        fileStat.size === 0 ||
        (await realpath(sessionFile)) !== sessionFile
      ) {
        throw new Error(
          "History must be a nonempty ordinary nonsymlink file at its canonical absolute path",
        );
      }
      const file = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        if (!(await file.stat()).isFile()) throw new Error("History is not an ordinary file");
        content = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      // Validate before SDK open: missing/empty history must never allocate a new identity.
      const lines = content.split("\n").filter((line) => line.trim());
      const header = JSON.parse(lines[0] ?? "");
      // The SDK tolerantly skips broken JSONL lines. Validate first so restoration and
      // complete-conversation reports cannot silently omit malformed persisted history.
      for (const line of lines.slice(1)) {
        const entry: unknown = JSON.parse(line);
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof (entry as { type?: unknown }).type !== "string"
        )
          throw new Error("History contains an invalid JSONL entry");
      }
      if (
        !header ||
        header.type !== "session" ||
        typeof header.id !== "string" ||
        !header.id ||
        header.id !== identity.sessionId ||
        typeof header.cwd !== "string" ||
        !path.isAbsolute(header.cwd)
      ) {
        throw new Error("History header identity or cwd is invalid");
      }
      const cwd = await realpath(header.cwd);
      if (cwd !== header.cwd || !(await stat(cwd)).isDirectory()) {
        throw new Error("History header cwd is no longer an existing canonical directory");
      }
      const manager = SessionManager.open(sessionFile, path.dirname(sessionFile), cwd);
      if (
        manager.getSessionId() !== identity.sessionId ||
        manager.getCwd() !== cwd ||
        manager.getHeader()?.cwd !== cwd ||
        manager.getSessionFile() !== sessionFile
      ) {
        throw new Error("Opened history identity or cwd does not match");
      }
      return manager;
    } catch (error) {
      throw new SubagentError(
        "SESSION_HISTORY_UNAVAILABLE",
        `Cannot restore child history: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async open(options: OpenChildOptions): Promise<OpenedChild> {
    const { cwd, roleSnapshot } = options;
    const trusted = await this.resolveTrust(cwd);
    if (!trusted) throw new SubagentError("PROJECT_NOT_TRUSTED", `Project is not trusted: ${cwd}`);
    const settingsManager = SettingsManager.create(cwd, this.agentDir);
    const childBinding: CallerBinding | undefined =
      options.canDelegate && options.delegationContext
        ? {
            agent: options.callerAgent,
            execution: options.callerAgent.currentExecution,
            depth: options.depth,
            ancestorCwds: options.ancestorCwds,
            delegation: options.delegationContext,
          }
        : undefined;
    const internalFactory = childBinding
      ? createDelegationExtension(options.runtime, childBinding)
      : undefined;
    const runtimePrompt = `You are subagent "${options.name}", delegated by a parent agent.

Your final response is automatically reported to your direct parent.`;

    // Warning Cache Broke: preserve append order on restoration. Current target resources
    // are rebuilt, but the current role is always the saved snapshot, never a role-file reload.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      ...(internalFactory
        ? {
            extensionFactories: [
              { name: "pi-subagents:child", factory: internalFactory, hidden: true },
            ],
          }
        : {}),
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(
          (extension) => !isOwnExtension(extension, this.ownExtensionPath),
        ),
      }),
      appendSystemPromptOverride: (base) => [...base, runtimePrompt, roleSnapshot.prompt],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => trusted });
    const extensionsResult = resourceLoader.getExtensions();
    assertRoleToolsAvailable(roleSnapshot.tools, extensionsResult.extensions);

    // Provider registrations are mutable: each mount gets a fresh target-cwd runtime.
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
    for (const registration of extensionsResult.runtime.pendingVirtualModelRegistrations) {
      modelRuntime.registerVirtualModel(registration.definition);
    }
    extensionsResult.runtime.pendingVirtualModelRegistrations = [];
    await modelRuntime.refresh({ allowNetwork: false });

    let model: Model<Api> | undefined;
    let expectedThinking: ThinkingLevel | undefined;
    if (options.restoring) {
      const context = options.sessionManager.buildSessionContext();
      const branch = options.sessionManager.getBranch();
      if (context.messages.length === 0) {
        throw new SubagentError(
          "SESSION_HISTORY_UNAVAILABLE",
          "Child history has no restorable conversation context",
        );
      }
      const thinkingEntry = branch.findLast((entry) => entry.type === "thinking_level_change");
      if (
        !thinkingEntry ||
        !THINKING_LEVELS.includes(thinkingEntry.thinkingLevel as ThinkingLevel)
      ) {
        throw new SubagentError(
          "SESSION_HISTORY_UNAVAILABLE",
          "Child history has no valid historical thinking entry",
        );
      }
      model = historicalModel(branch, modelRuntime);
      expectedThinking = clampThinkingLevel(model, context.thinkingLevel as ThinkingLevel);
    } else {
      if (!options.model)
        throw new SubagentError("PARENT_MODEL_UNAVAILABLE", "Parent model is unavailable");
      model = modelRuntime.getModel(options.model.provider, options.model.id) ?? options.model;
    }
    if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new SubagentError(
        "MODEL_AUTH_UNAVAILABLE",
        `Model authentication is unavailable for ${model?.provider ?? "parent model"}`,
      );
    }

    let session: AgentSession | undefined;
    const ui = this.uiBroker.proxy(options.sessionManager.getSessionId(), options.name);
    try {
      const created = await createAgentSession({
        cwd,
        agentDir: this.agentDir,
        modelRuntime,
        // Restoration must take the SDK's normal branch path, with no settings/parent overrides.
        ...(options.restoring ? {} : { model, thinkingLevel: options.thinking ?? "off" }),
        ...(roleSnapshot.tools ? { tools: roleSnapshot.tools } : {}),
        // Warning Cache Broke: SDK 1.0.0 applies exclusions to the full registry on
        // every refresh, including dynamic registration; setActiveTools cannot bypass it.
        excludeTools: [
          ...(roleSnapshot.disallowedTools ?? []),
          ...(options.canDelegate ? [] : ["subagent", "ask_subagent"]),
        ],
        resourceLoader,
        sessionManager: options.sessionManager,
        settingsManager,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      session = created.session;
      const assertRestoredSelection = () => {
        if (
          options.restoring &&
          (created.modelFallbackMessage ||
            session?.model?.provider !== model.provider ||
            session.model.id !== model.id ||
            session.thinkingLevel !== expectedThinking)
        ) {
          throw new SubagentError(
            "MODEL_UNAVAILABLE",
            `SDK did not restore the historical model/thinking${created.modelFallbackMessage ? `: ${created.modelFallbackMessage}` : ""}`,
          );
        }
      };
      assertRestoredSelection();
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
      assertRestoredSelection();
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
