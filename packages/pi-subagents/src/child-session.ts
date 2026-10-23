import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type Extension,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SubagentError } from "./errors.js";
import { createDelegationExtension, type DelegationRuntimeApi } from "./tools.js";
import type {
  Agent,
  AgentDefinitionSnapshot,
  CallerBinding,
  DelegationContext,
  SessionIdentity,
  ThinkingLevel,
} from "./types.js";
import type { RootUiBroker, SubagentUiProxy } from "./ui.js";

function isOwnExtension(extension: Extension, ownExtensionPath: string): boolean {
  return (
    path.resolve(extension.resolvedPath) === path.resolve(ownExtensionPath) ||
    path.resolve(extension.path) === path.resolve(ownExtensionPath)
  );
}

async function shutdownSession(session: AgentSession): Promise<void> {
  try {
    const runner = session.extensionRunner;
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
    session.dispose();
  }
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
      // Keep new histories outside native Pi discovery, without changing JSONL
      // semantics or applying CLI/env/settings sessionDir overrides. getAgentDir
      // handles SDK path normalization; resolve also supports a relative agentDir.
      const historyDirectory = path.join(path.resolve(getAgentDir()), "subagents", "histories");
      const existing = new Set<string>();
      let ancestor = historyDirectory;
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
      const allocated = SessionManager.create(cwd, historyDirectory);
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
    const services = await createAgentSessionServices({
      cwd,
      agentDir: this.agentDir,
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
      resourceLoaderOptions: {
        // Warning Cache Broke: rebuild the CLI's replaceable built-ins in the target
        // resource registry. builtin entries honor target settings and load after trust;
        // MCP retains its own exposure/activation policy rather than copying parent tools.
        extensionFactories: [
          {
            name: "codemode",
            factory: createCodemodeExtension(),
            builtin: true,
            replaceable: true,
          },
          {
            name: "tool-search",
            factory: createToolSearchExtension(),
            builtin: true,
            replaceable: true,
          },
          {
            name: "mcp",
            factory: createMcpExtension(),
            builtin: true,
            replaceable: true,
          },
          ...(internalFactory
            ? [{ name: "pi-subagents:child", factory: internalFactory, hidden: true }]
            : []),
        ],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter(
            (extension) => !isOwnExtension(extension, this.ownExtensionPath),
          ),
        }),
        appendSystemPromptOverride: (base) => [...base, runtimePrompt, roleSnapshot.prompt],
      },
    });
    const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (errors.length) {
      throw new SubagentError(
        "MODEL_UNAVAILABLE",
        errors.map((diagnostic) => diagnostic.message).join("\n"),
      );
    }

    let model: Model<Api> | undefined;
    if (!options.restoring) {
      if (!options.model)
        throw new SubagentError("PARENT_MODEL_UNAVAILABLE", "Parent model is unavailable");
      model =
        services.modelRuntime.getModel(options.model.provider, options.model.id) ?? options.model;
      if (!services.modelRuntime.hasConfiguredAuth(model.provider)) {
        throw new SubagentError(
          "MODEL_AUTH_UNAVAILABLE",
          `Model authentication is unavailable for ${model.provider}`,
        );
      }
    }

    let session: AgentSession | undefined;
    const ui = this.uiBroker.proxy(options.sessionManager.getSessionId(), options.name);
    try {
      for (const diagnostic of services.diagnostics) ui.notify(diagnostic.message, diagnostic.type);
      const created = await createAgentSessionFromServices({
        services,
        // Restoration must take the SDK's normal branch path, with no settings/parent overrides.
        ...(options.restoring ? {} : { model, thinkingLevel: options.thinking ?? "off" }),
        ...(roleSnapshot.tools ? { tools: roleSnapshot.tools } : {}),
        // Warning Cache Broke: SDK applies exclusions to the full registry on
        // every refresh, including dynamic registration; setActiveTools cannot bypass it.
        excludeTools: [
          ...(roleSnapshot.disallowedTools ?? []),
          ...(options.canDelegate ? [] : ["subagent", "ask_subagent"]),
        ],
        sessionManager: options.sessionManager,
        sessionStartEvent: { type: "session_start", reason: "startup" },
      });
      session = created.session;
      if (created.modelFallbackMessage) ui.notify(created.modelFallbackMessage, "warning");
      // The underlying Agent may expose its default placeholder when the SDK has
      // no selectable model. Do not mount it as a usable authenticated fallback.
      if (!session.model || !services.modelRuntime.hasConfiguredAuth(session.model.provider)) {
        throw new SubagentError(
          "MODEL_UNAVAILABLE",
          created.modelFallbackMessage ?? "No model is available for the child session",
        );
      }
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
          await shutdownSession(openedSession);
        },
      };
    } catch (error) {
      ui.dispose();
      try {
        if (session) await shutdownSession(session);
      } catch {
        // Preserve the opening failure; shutdownSession still disposes in its finally.
      }
      throw error;
    }
  }
}
