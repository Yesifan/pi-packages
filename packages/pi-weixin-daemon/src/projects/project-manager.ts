import type { Logger } from "../util/logger.js";
import type { InboundMessage, WeixinTransport } from "../weixin/types.js";
import { type ProjectRuntimeConfig, runtimeKeyOf } from "./project-config.js";
import { ProjectController, type ProjectHostFactory } from "./project-controller.js";
import { ProjectTransport } from "./project-transport.js";
import type { ProjectBroadcastResult, ProjectConfig, ProjectStatus } from "./types.js";

export interface ProjectManagerOptions {
  /** Resolve the per-account transport (owned by AccountManager). */
  getTransport: (accountId: string) => WeixinTransport | undefined;
  /** Owner details and exact cached token, supplied by the account/Weixin layer. */
  resolveBroadcastAccount?: (accountId: string) => {
    userId?: string;
    contextToken?: string;
  } | null;
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

/** Result of a desired-state reconcile (ADR-0004 Invariant 3). */
export type ReconcileResult = "none" | "restart";

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

  constructor(private readonly opts: ProjectManagerOptions) {}

  getRuntime(projectId: string): ProjectController | undefined {
    return this.controllers.get(projectId);
  }

  getProjectIdForAccount(accountId: string): string | undefined {
    return this.accountProject.get(accountId);
  }

  /** Reconcile desired-state from the given configs (diff → none | restart). */
  async sync(
    configs: Array<{ name: string; config: ProjectConfig }>,
    changedOwners = new Set<string>(),
  ): Promise<void> {
    const errors: unknown[] = [];
    const nextConfigs = new Map<string, ProjectConfig>();
    const nextAccountProject = new Map<string, string>();
    for (const { name, config } of configs) {
      nextConfigs.set(name, config);
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
        !cfg.accounts.some((id) => changedOwners.has(id)) &&
        runtimeKeyOf(existing.config.accounts) === runtimeKeyOf(cfg.accounts)
      ) {
        continue; // unchanged → none
      }
      if (existing) {
        await existing.stop();
        this.controllers.delete(name);
      }

      const transport = new ProjectTransport(this.opts.getTransport);
      const snapshot: ProjectRuntimeConfig = {
        projectId: name,
        cwd: cfg.cwd,
        accounts: [...cfg.accounts],
      };
      const controller = new ProjectController({
        config: snapshot,
        transport,
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
      // Tell the sender instead of silently dropping (bound+enabled but runtime not up).
      const transport = this.opts.getTransport(accountId);
      if (transport && msg.senderId) {
        await transport
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
      }
      return;
    }
    await controller.handleMessage(msg);
  }

  /** Explicit owner notification; deliberately independent of Pi and session participants. */
  async broadcast(projectId: string, text: string): Promise<ProjectBroadcastResult> {
    const config = this.configs.get(projectId);
    if (!config) throw new Error(`project "${projectId}" does not exist`);
    if (!config.enabled) throw new Error(`project "${projectId}" is disabled`);
    if (!text.trim()) throw new Error("broadcast text must not be blank");

    const result: ProjectBroadcastResult = { succeeded: 0, skipped: 0, failed: 0 };
    // Snapshot the bound accounts, not the actual-sender participant registry.
    for (const accountId of [...config.accounts]) {
      const account = this.opts.resolveBroadcastAccount?.(accountId);
      const userId = account?.userId;
      const contextToken = account?.contextToken;
      const transport = this.opts.getTransport(accountId);
      const target = { project: projectId, account: accountId, user: userId };
      if (!account || !userId || !contextToken || !transport) {
        const reason = !account
          ? "missing-account"
          : !userId
            ? "missing-user"
            : !contextToken
              ? "missing-context-token"
              : "missing-transport";
        result.skipped++;
        this.opts.logger.warn(
          { ...target, status: "skipped", reason },
          "project broadcast target skipped",
        );
        continue;
      }

      try {
        await transport.sendText(
          { accountId, senderId: userId, contextToken, messageId: "project-broadcast" },
          text,
        );
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
