import {
  createAgentSessionRuntime,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../util/logger.js";
import { toPiHostEvent, type PiHostEvent } from "./events.js";
import { PiExtensionHost } from "./extension-host.js";
import { resolveProjectTrust } from "./project-trust.js";
import { createPiRuntimeFactory, PiInitializationError } from "./runtime-factory.js";
import { PiSessionHost } from "./session-host.js";
import type {
  HostExtensionMode,
  HostModelOption,
  HostPromptInput,
  HostSessionOption,
  HostStatus,
  SessionSwitchResult,
} from "./types.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export interface PiSdkHostOptions {
  /** Project working directory. The single entry point for the project. */
  cwd: string;
  logger: Logger;
  /** In-memory extensions injected into every session (e.g. weixin_send_file). */
  extensionFactories?: ExtensionFactory[];
  /** Custom UI context for extension dialogs (confirm/select/input over weixin). */
  uiContext?: ExtensionUIContext;
  /** Matches the official ExtensionMode union ("tui" | "rpc" | "json" | "print"). */
  mode?: HostExtensionMode;
}

export type PiHostEventListener = (event: PiHostEvent) => void;

/**
 * The only public door into the Pi SDK (ADR-0004). Owns the
 * `AgentSessionRuntime`, creates it lazily on first use, binds extensions on
 * every session replacement, and translates SDK events/status into domain
 * shapes for the business layer.
 */
export class PiSdkHost {
  private runtime: AgentSessionRuntime | undefined;
  private sessionRef: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private extensionHost: PiExtensionHost | undefined;
  private readonly listeners = new Set<PiHostEventListener>();
  private readonly opts: PiSdkHostOptions;

  constructor(opts: PiSdkHostOptions) {
    this.opts = opts;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  /** Lazy start: the session is only created on the first prompt or `/new`. */
  async start(): Promise<void> {
    this.opts.logger.debug({ cwd: this.opts.cwd }, "pi sdk host ready (session lazy)");
  }

  /** Build the runtime + session if absent. Fails closed on fatal diagnostics. */
  async ensureSession(): Promise<void> {
    await this.ensureRuntime();
  }

  /** Create a fresh session for `cwd` and bind session-local subscriptions. */
  private async ensureRuntime(): Promise<AgentSessionRuntime> {
    if (this.runtime) return this.runtime;
    const { cwd, logger } = this.opts;
    const agentDir = getAgentDir();

    const factory = createPiRuntimeFactory({
      cwd,
      extensionFactories: this.opts.extensionFactories,
    });

    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir,
      // Always a fresh session: no cross-restart resume.
      sessionManager: SessionManager.create(cwd),
    });

    // W1 fail-closed: a fatal diagnostic means this project must not run.
    const fatal = runtime.diagnostics.filter((d) => d.type === "error");
    if (fatal.length > 0) {
      const message = fatal.map((d) => d.message).join("; ");
      await runtime.dispose().catch(() => {});
      throw new PiInitializationError(message);
    }

    this.extensionHost = new PiExtensionHost({
      uiContext: this.opts.uiContext,
      mode: this.opts.mode ?? "rpc",
      logger,
      onError: (error) => {
        const message = error.error instanceof Error ? error.error.message : String(error.error);
        this.emit({
          type: "extension_error",
          message,
          extensionPath: error.extensionPath,
          event: error.event,
        });
      },
    });

    // Official hook: called automatically after newSession/switchSession/fork
    // replace the active session. Rebind the UI context + subscriptions.
    runtime.setRebindSession(async (session) => {
      await this.bindSession(session, runtime);
    });
    await this.bindSession(runtime.session, runtime);
    this.runtime = runtime;

    logger.info(
      { sessionFile: runtime.session.sessionFile, sessionId: runtime.session.sessionId },
      "pi runtime started",
    );
    return runtime;
  }

  private async bindSession(session: AgentSession, runtime: AgentSessionRuntime): Promise<void> {
    this.unsubscribe?.();
    this.sessionRef = session;
    if (this.extensionHost) {
      await this.extensionHost.bind(session, runtime);
    }
    this.unsubscribe = session.subscribe((event) => {
      this.emit(toPiHostEvent(event));
    });
    this.opts.logger.debug({ sessionFile: session.sessionFile }, "session bound");
  }

  private emit(event: PiHostEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Subscribe to domain session events. Returns an unsubscribe function. */
  onEvent(listener: PiHostEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Prompt the agent. Creates the session on first use (lazy). */
  async prompt(input: HostPromptInput): Promise<void> {
    const { session } = await this.ensureRuntime();
    this.opts.logger.info({ sessionId: session.sessionId }, "prompt");
    await new PiSessionHost(this.runtime!).prompt(input);
  }

  /** Abort the current agent run. No-op when no session is active. */
  async abort(): Promise<void> {
    const session = this.sessionRef;
    if (!session) return;
    this.opts.logger.info("abort requested");
    await session.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.sessionRef?.waitForIdle();
  }

  /** Reset the active session. `/new` only resets an existing session. */
  async newSession(): Promise<SessionSwitchResult> {
    if (!this.runtime) {
      this.opts.logger.info("new session ignored: no active session");
      return { cancelled: false };
    }
    this.opts.logger.info("new session requested");
    const r = await this.runtime.newSession();
    return { cancelled: r.cancelled };
  }

  async listModels(): Promise<HostModelOption[]> {
    const models = this.runtime
      ? await this.runtime.services.modelRuntime.getAvailable()
      : await (await ModelRuntime.create()).getAvailable();
    return models.map((model) => ({ provider: model.provider, id: model.id, name: model.name ?? model.id }));
  }

  async setModel(provider: string, modelId: string, projectDefault: boolean): Promise<void> {
    const modelRuntime = this.runtime?.services.modelRuntime ?? (await ModelRuntime.create());
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
    if (this.sessionRef) await this.sessionRef.setModel(model);
    if (projectDefault || !this.sessionRef) {
      await this.updateProjectSettings("defaultProvider", provider);
      await this.updateProjectSettings("defaultModel", modelId);
    }
  }

  async getThinkingLevels(): Promise<string[]> {
    return this.sessionRef?.getAvailableThinkingLevels() ?? ["off", "minimal", "low", "medium", "high", "xhigh"];
  }

  async setThinkingLevel(level: string, projectDefault: boolean): Promise<string> {
    if (this.sessionRef) this.sessionRef.setThinkingLevel(level as ThinkingLevel);
    if (projectDefault || !this.sessionRef) await this.updateProjectSettings("defaultThinkingLevel", level);
    return String(this.sessionRef?.thinkingLevel ?? level);
  }

  async listSessions(): Promise<HostSessionOption[]> {
    const sessions = await SessionManager.list(this.opts.cwd);
    return sessions.map((session) => ({
      path: session.path,
      id: session.id,
      modifiedAt: session.modified.getTime(),
      firstMessage: session.firstMessage,
      name: session.name,
    }));
  }

  async resumeSession(path: string): Promise<SessionSwitchResult> {
    const runtime = await this.ensureRuntime();
    return runtime.switchSession(path);
  }

  async reload(): Promise<void> {
    if (!this.sessionRef) return;
    await this.sessionRef.reload();
  }

  private async updateProjectSettings(field: string, value: unknown): Promise<void> {
    const settings = this.runtime?.services.settingsManager ?? SettingsManager.create(this.opts.cwd, getAgentDir());
    // Pi 0.84 exposes project-scoped package setters but not scalar defaults;
    // use its project update primitive so locking, merge and error handling stay in Pi.
    const scoped = settings as unknown as {
      updateProjectSettings(key: string, update: (project: Record<string, unknown>) => void): void;
    };
    scoped.updateProjectSettings(field, (project) => { project[field] = value; });
    await settings.flush();
    const errors = settings.drainErrors();
    if (errors.length) throw errors[0]!.error;
  }

  /** Compact the current session. No-op when no session exists. */
  async compact(customInstructions?: string): Promise<void> {
    const session = this.sessionRef;
    if (!session) return;
    this.opts.logger.info("compact requested");
    await session.compact(customInstructions);
  }

  hasSession(): boolean {
    return this.sessionRef !== undefined;
  }

  getStatus(): HostStatus {
    const session = this.sessionRef;
    const model = session?.model;
    const agentDir = getAgentDir();
    return {
      sessionFile: session?.sessionFile,
      sessionId: session?.sessionId,
      cwd: this.opts.cwd,
      model: model ? `${model.provider}/${model.id}` : "unknown",
      thinkingLevel: String(session?.thinkingLevel ?? "unknown"),
      configuredTrust: resolveProjectTrust(this.opts.cwd, agentDir),
      activeSessionTrust: session ? session.settingsManager.isProjectTrusted() : undefined,
    };
  }

  /** Dispose the runtime and all bindings (idle close / project stop). */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.sessionRef = undefined;
    this.extensionHost = undefined;
    if (runtime) {
      await runtime.dispose();
    }
    this.opts.logger.info("pi runtime stopped");
  }
}
