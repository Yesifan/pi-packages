import { type CliPromptRequest, validateCliPrompt } from "../sessions/cli-prompt.js";
import type { Logger } from "../util/logger.js";
import { RecipientUnavailableError, type ResolveRecipientAccount } from "../weixin/recipient.js";
import type { InboundMessage, WeixinTransport } from "../weixin/types.js";
import { type ProjectRuntimeConfig, runtimeKeyOf } from "./project-config.js";
import { ProjectController, type ProjectHostFactory } from "./project-controller.js";
import { ProjectTransport } from "./project-transport.js";
import type { ProjectBroadcastResult, ProjectConfig, ProjectStatus } from "./types.js";

export interface ProjectManagerOptions {
  saveDefaultSession?: (projectId: string, sessionId: string) => void;
  /** Resolve the per-account transport (owned by AccountManager). */
  getTransport: (accountId: string) => WeixinTransport | undefined;
  /** Login user and exact cached token, shared by all project delivery. */
  resolveBroadcastAccount: ResolveRecipientAccount;
  /** Build the per-project agent host (real PiSdkHost or fake in tests). */
  factory: ProjectHostFactory;
  logger: Logger;
  /** Human label for an account (passed through to ProjectController for markers). */
  resolveSenderName?: (accountId: string) => string;
  /** Idle window before a shared session auto-closes (passed through). */
  sessionIdleMs?: number;
  /** Turn watchdog settings (passed through). */
  turnTimeoutMs?: number;
  abortGraceMs?: number;
}

/**
 * Owns `Map<ProjectId, ProjectController>` and the derived `accountId -> projectId`
 * index. Reconciles desired-state (`enabled`) from config via diff → restart
 * (no hot-update): reuse requires the same cwd and account set, including when
 * deletion/recreation of a project is coalesced into one desired-state snapshot.
 */
export class ProjectManager {
  private controllers = new Map<string, ProjectController>();
  private configs = new Map<string, ProjectConfig>();
  private accountProject = new Map<string, string>();

  private readonly transport: ProjectTransport;

  constructor(private readonly opts: ProjectManagerOptions) {
    this.transport = new ProjectTransport(
      opts.getTransport,
      opts.resolveBroadcastAccount,
      opts.logger,
    );
  }

  getRuntime(projectId: string): ProjectController | undefined {
    return this.controllers.get(projectId);
  }

  getProjectIdForAccount(accountId: string): string | undefined {
    return this.accountProject.get(accountId);
  }

  /** Reconcile desired-state from the given configs (diff → none | restart). */
  async sync(configs: Array<{ name: string; config: ProjectConfig }>): Promise<void> {
    const errors: unknown[] = [];
    const nextConfigs = new Map<string, ProjectConfig>();
    const nextAccountProject = new Map<string, string>();
    for (const { name, config } of configs) {
      nextConfigs.set(name, { ...config, accounts: [...config.accounts] });
      for (const acc of config.accounts) {
        nextAccountProject.set(acc, name);
      }
    }
    this.configs = nextConfigs;
    this.accountProject = nextAccountProject;

    // Stop controllers for projects no longer enabled or removed.
    for (const [id, controller] of this.controllers) {
      const cfg = nextConfigs.get(id);
      if (!cfg || !cfg.enabled) {
        await controller.stop();
        this.controllers.delete(id);
      }
    }

    // A project keeps its cwd until deleted, but a same-name recreation can change
    // it without an intervening sync. Compare the live controller's snapshot too.
    for (const [name, cfg] of nextConfigs) {
      if (!cfg.enabled) continue;

      const existing = this.controllers.get(name);
      if (
        existing &&
        existing.getStatus().state !== "error" &&
        existing.config.cwd === cfg.cwd &&
        runtimeKeyOf(existing.config.accounts) === runtimeKeyOf(cfg.accounts)
      ) {
        continue; // unchanged → none
      }
      if (existing) {
        await existing.stop();
        this.controllers.delete(name);
      }

      const snapshot: ProjectRuntimeConfig = {
        projectId: name,
        cwd: cfg.cwd,
        accounts: [...cfg.accounts],
      };
      const controller = new ProjectController({
        config: snapshot,
        defaultSessionId: cfg.defaultSessionId,
        saveDefaultSession: (id) => {
          this.opts.saveDefaultSession?.(name, id);
          const config = this.configs.get(name);
          if (config) config.defaultSessionId = id;
        },
        transport: this.transport,
        resolveRecipientUserId: (id) => this.opts.resolveBroadcastAccount(id)?.userId,
        logger: this.opts.logger,
        factory: this.opts.factory,
        resolveSenderName: this.opts.resolveSenderName,
        sessionIdleMs: this.opts.sessionIdleMs,
        turnTimeoutMs: this.opts.turnTimeoutMs,
        abortGraceMs: this.opts.abortGraceMs,
      });
      this.controllers.set(name, controller);
      try {
        await controller.start();
      } catch (err) {
        this.opts.logger.error({ err, project: name }, "project start failed");
        // Keep error status visible, but do not acknowledge application success.
        errors.push(err);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Project configuration application failed");
  }

  /** Dispatch an inbound message: account -> project -> controller. Drops unbound/off. */
  async dispatch(accountId: string, msg: InboundMessage): Promise<void> {
    const projectId = this.accountProject.get(accountId);
    if (!projectId) {
      this.opts.logger.info({ account: accountId }, "dropping inbound: no project bound");
      return;
    }
    const controller = this.controllers.get(projectId);
    if (!controller) {
      this.opts.logger.info(
        { account: accountId, project: projectId },
        "dropping inbound: project not running",
      );
      await this.transport
        .sendText(
          {
            accountId,
            senderId: msg.senderId,
            messageId: "not-running",
            contextToken: msg.contextToken,
          },
          "⚠️ 项目当前未运行（可能启动失败或仍在启动），请稍后重试。",
        )
        .catch((err: unknown) =>
          this.opts.logger.warn(
            { err, account: accountId },
            "project-not-running reply failed (ignored)",
          ),
        );
      return;
    }
    await controller.handleMessage(msg);
  }

  async prompt(projectId: string, input: CliPromptRequest) {
    validateCliPrompt(input);
    const config = this.configs.get(projectId);
    if (!config) throw new Error(`project "${projectId}" does not exist`);
    if (!config.enabled) throw new Error(`project "${projectId}" is disabled`);
    const targets = input.reply ?? ["caller"];
    const users = new Map<string, string>();
    for (const account of config.accounts) {
      const user = this.opts.resolveBroadcastAccount(account)?.userId;
      if (user && !users.has(user)) users.set(user, account);
    }
    const accounts = new Set<string>();
    for (const target of targets) {
      if (target === "caller") continue;
      if (target === "user:all") {
        // Missing user records still count as skipped, rather than silently succeeding.
        for (const account of config.accounts) {
          const user = this.opts.resolveBroadcastAccount(account)?.userId;
          if (!user || users.get(user) === account) accounts.add(account);
        }
      } else {
        const account = users.get(target.slice(5));
        if (!account) throw new Error(`unknown project reply target: ${target}`);
        accounts.add(account);
      }
    }
    const controller = this.controllers.get(projectId);
    if (!controller) throw new Error(`project "${projectId}" is not running`);
    return controller.prompt(input, (text) => this.broadcast(projectId, text, [...accounts]));
  }

  /** Explicit project notification, independent of Pi session state. */
  async broadcast(
    projectId: string,
    text: string,
    selectedAccounts?: string[],
  ): Promise<ProjectBroadcastResult> {
    const config = this.configs.get(projectId);
    if (!config) throw new Error(`project "${projectId}" does not exist`);
    if (!config.enabled) throw new Error(`project "${projectId}" is disabled`);
    if (!text.trim()) throw new Error("broadcast text must not be blank");

    const result: ProjectBroadcastResult = { succeeded: 0, skipped: 0, failed: 0 };
    // Snapshot bound accounts; all exits share the same recipient/token resolver.
    for (const accountId of selectedAccounts ?? [...config.accounts]) {
      const target = {
        project: projectId,
        account: accountId,
        user: undefined as string | undefined,
      };
      let recipient: ReturnType<ProjectTransport["resolve"]>;
      try {
        recipient = this.transport.resolve({
          accountId,
          senderId: "",
          messageId: "project-broadcast",
        });
      } catch (err) {
        if (!(err instanceof RecipientUnavailableError)) throw err;
        result.skipped++;
        target.user = err.userId;
        this.opts.logger.warn(
          { ...target, status: "skipped", reason: err.reason },
          "project broadcast target skipped",
        );
        continue;
      }
      target.user = recipient.ctx.senderId;
      try {
        await recipient.transport.sendText(recipient.ctx, text);
        result.succeeded++;
        this.opts.logger.info({ ...target, status: "succeeded" }, "project broadcast target sent");
      } catch {
        result.failed++;
        // Arbitrary upstream errors can echo chunks or encoded payloads and credentials.
        this.opts.logger.warn(
          { ...target, status: "failed", classification: "delivery-failed" },
          "project broadcast target failed",
        );
      }
    }
    this.opts.logger.info(
      {
        project: projectId,
        ...result,
        ...(config.accounts.length === 0 ? { reason: "no-bound-accounts" } : {}),
      },
      "project broadcast completed",
    );
    return result;
  }

  /** Last reconciled project configuration plus actual controller status. */
  listStatuses(): ProjectStatus[] {
    return [...this.configs].map(([name, cfg]) => {
      const controller = this.controllers.get(name);
      const st = controller?.getStatus();
      return {
        name,
        cwd: cfg.cwd,
        accounts: cfg.accounts,
        enabled: cfg.enabled,
        state: st?.state ?? "off",
        sessionFile: st?.sessionFile,
        sessionId: st?.sessionId,
        defaultSessionId: st?.defaultSessionId ?? cfg.defaultSessionId,
        model: st?.model,
        configuredTrust: st?.configuredTrust,
        activeSessionTrust: st?.activeSessionTrust,
        error: st?.error,
      };
    });
  }

  /** Explicit restart: stop then start a project controller (if desired-state on). */
  async restart(projectId: string): Promise<void> {
    const controller = this.controllers.get(projectId);
    if (!controller) throw new Error(`project "${projectId}" is not running`);
    await controller.restart();
  }

  async stopAll(): Promise<void> {
    for (const controller of [...this.controllers.values()]) {
      await controller.stop();
    }
    this.controllers.clear();
  }
}
