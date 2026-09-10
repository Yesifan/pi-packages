import type { InteractionPort } from "../pi/ports.js";
import type { SessionRuntimePort } from "../sessions/runtime-port.js";
import { SessionController } from "../sessions/session-controller.js";
import { CurrentTurn, toTurnContext } from "../sessions/turn-context.js";
import { WeixinInteractionController } from "../weixin/interaction-controller.js";
import type {
  InboundMessage,
  WeixinTransport,
} from "../weixin/types.js";
import type { Logger } from "../util/logger.js";
import { formatUserFacingError } from "../util/user-facing-error.js";
import type { DeliveryReport } from "../sessions/turn-outcome.js";
import { CommandRouter } from "./command-router.js";
import { ParticipantRegistry, type Participant } from "./participant-registry.js";
import type { ProjectRuntimeConfig } from "./project-config.js";
import type { ProjectRuntimeState } from "./types.js";
import { OutboundDeliveryError } from "./project-transport.js";

/** Factory builds the per-project agent host (real PiSdkHost, or a fake in tests). */
export interface ProjectHostFactoryContext {
  projectId: string;
  cwd: string;
  accounts: string[];
  transport: WeixinTransport;
  interaction: InteractionPort;
  logger: Logger;
}
export type ProjectHostFactory = (ctx: ProjectHostFactoryContext) => Promise<SessionRuntimePort>;

export interface ProjectControllerOptions {
  config: ProjectRuntimeConfig;
  /** Per-project outbound facade; also used by the weixin runtime extension. */
  transport: WeixinTransport;
  logger: Logger;
  factory: ProjectHostFactory;
  /** Human label for an account (e.g. its name) used in "-- from weixin <name>". */
  resolveSenderName?: (accountId: string) => string;
  /** Idle window before the shared session is auto-closed (min for tests). */
  sessionIdleMs?: number;
  /** Maximum duration and abort grace for one Pi turn. */
  turnTimeoutMs?: number;
  abortGraceMs?: number;
}

export interface ProjectStatusView {
  state: ProjectRuntimeState | "off";
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  configuredTrust?: boolean;
  activeSessionTrust?: boolean;
  error?: string;
}

/**
 * One project's runtime (ADR-0004): composes a SessionController + CommandRouter
 * + ParticipantRegistry over an immutable config snapshot.
 *
 * Fault isolation: whatever happens here (turn error, pi crash) is contained to
 * this instance. `state` mirrors the session state machine while a turn is
 * active and the lifecycle (starting/stopping/error) otherwise.
 */
export class ProjectController {
  readonly config: ProjectRuntimeConfig;
  state: ProjectRuntimeState | "off" = "starting";
  error?: string;

  private session?: SessionController;
  private readonly router = new CommandRouter();
  private readonly registry = new ParticipantRegistry();
  /** Set once start() settles (extensions bound / session_start dispatched). */
  private resolveStarted!: () => void;
  private readonly started: Promise<void> = new Promise((r) => (this.resolveStarted = r));

  constructor(private readonly opts: ProjectControllerOptions) {
    this.config = opts.config;
  }

  get projectId(): string {
    return this.config.projectId;
  }

  async start(): Promise<void> {
    this.state = "starting";
    this.error = undefined;
    try {
      const currentTurn = new CurrentTurn();
      const interaction = new WeixinInteractionController({
        getCurrentTurn: () => currentTurn.get(),
        transport: this.opts.transport,
        logger: this.opts.logger,
      });
      const host = await this.opts.factory({
        projectId: this.config.projectId,
        cwd: this.config.cwd,
        accounts: this.config.accounts,
        transport: this.opts.transport,
        interaction,
        logger: this.opts.logger,
      });
      this.session = new SessionController({
        projectId: this.config.projectId,
        host,
        interaction,
        transport: this.opts.transport,
        currentTurn,
        logger: this.opts.logger,
        sessionIdleMs: this.opts.sessionIdleMs,
        turnTimeoutMs: this.opts.turnTimeoutMs,
        abortGraceMs: this.opts.abortGraceMs,
        broadcastText: (text) => this.broadcastToRegistry(text),
        broadcastTyping: (typing) => this.broadcastTypingToRegistry(typing),
        resolveSenderLabel: (msg) => this.opts.resolveSenderName?.(msg.accountId) ?? msg.accountId,
      });
      await this.session.start();
      this.state = "idle";
      this.opts.logger.info({ project: this.projectId, cwd: this.config.cwd }, "project controller started");
    } catch (err) {
      this.state = "error";
      this.error = formatUserFacingError(err);
      this.opts.logger.error({ err, project: this.projectId }, "project controller start failed");
      throw err;
    } finally {
      this.resolveStarted();
    }
  }

  /** Route one inbound message into this project's session. */
  async handleMessage(msg: InboundMessage): Promise<void> {
    // Any inbound (command or not) counts as activity and (re)registers the sender.
    this.registry.register(msg);

    // ① Wait until the runtime finished starting so the first tool call is gated
    //    against the fully-configured project scope.
    await this.started;

    // W1 fail-closed: a fatal initialization error put this project into the
    // error state. Refuse messages (per-project isolation; daemon keeps running).
    if (this.state === "error") {
      const reason = this.error ?? "unknown error";
      await this.opts.transport
        .sendText(toTurnContext(msg), `⚠️ 项目启动失败，已拒绝消息：${reason}`)
        .catch((err: unknown) =>
          this.opts.logger.warn({ err, project: this.projectId }, "error reply failed (ignored)"),
        );
      return;
    }

    let session: SessionController | undefined;
    const routed = this.router.classify(msg.text);

    try {
      session = this.requireSession();
      // W4: only the daemon's explicitly-mapped commands enter slash handling.
      if (routed.kind === "daemon-command") {
        await session.handleCommand(routed.command, routed.args, msg);
        this.reflectState(session);
        return;
      }
      if (routed.kind === "unknown-command") {
        await this.opts.transport.sendText(
          toTurnContext(msg),
          `未知命令 /${routed.text}，输入 /help 查看可用命令。`,
        );
        return;
      }

      if (routed.kind === "prompt") msg = { ...msg, text: routed.text };

      // ③ Notify other project participants when a sender speaks (ordinary messages only).
      await this.notifyOthers(msg).catch((err: unknown) =>
        this.opts.logger.warn({ err, project: this.projectId, messageId: msg.messageId }, "notify others failed"),
      );
      await session.handleUserMessage(msg);
      this.reflectState(session);
    } catch (err) {
      if (err instanceof OutboundDeliveryError) {
        this.opts.logger.error(
          { err, project: this.projectId, account: msg.accountId, messageId: msg.messageId },
          "outbound delivery failed; cannot notify user over the failed channel",
        );
        if (session) this.reflectState(session);
        return;
      }

      this.error = formatUserFacingError(err);
      this.state = "error";
      this.opts.logger.error(
        { err, project: this.projectId, account: msg.accountId, messageId: msg.messageId },
        "project message handling failed",
      );
      await this.opts.transport
        .sendText(toTurnContext(msg), `⚠️ 消息处理失败：${this.error}`)
        .catch((sendErr: unknown) =>
          this.opts.logger.error(
            { err: sendErr, project: this.projectId, account: msg.accountId, messageId: msg.messageId },
            "unexpected-error reply delivery failed",
          ),
        );
    }
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    await this.session?.stop().catch((err: unknown) =>
      this.opts.logger.warn({ err, project: this.projectId }, "session stop error"),
    );
    this.session = undefined;
    this.state = "off";
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getStatus(): ProjectStatusView {
    let state: ProjectRuntimeState | "off" = this.state;
    const session = this.session;
    if (session && this.state !== "error" && this.state !== "stopping" && this.state !== "off") {
      const s = session.getState();
      if (s === "busy" || s === "replacing") state = "busy";
      else if (s === "faulted") state = "error";
      else state = "idle";
    }
    const s = session?.getStatus();
    return {
      state,
      sessionFile: s?.sessionFile,
      sessionId: s?.sessionId,
      model: s?.model,
      configuredTrust: s?.configuredTrust,
      activeSessionTrust: s?.activeSessionTrust,
      error: this.error,
    };
  }

  /** Reflect the session state machine into the project lifecycle state. */
  private reflectState(session: SessionController): void {
    if (this.state === "stopping") return;
    const s = session.getState();
    if (s === "busy" || s === "replacing") this.state = "busy";
    else if (s === "faulted") {
      this.state = "error";
      this.error = session.getFault() ?? this.error ?? "session faulted";
    } else this.state = "idle";
  }

  // --- participants / broadcast --------------------------------------------

  /** Authorized targets: observed senders ∩ currently-configured accounts. */
  private broadcastTargets() {
    return this.registry.getBroadcastTargets(this.config.accounts);
  }

  /** Send a proactive text to a participant via their account's transport. */
  private async sendTo(p: Participant, text: string): Promise<void> {
    await this.opts.transport.sendText(
      { accountId: p.accountId, senderId: p.senderId, messageId: "broadcast", contextToken: p.contextToken },
      text,
    );
  }

  /** Set or clear typing independently for every authorized participant. */
  private readonly broadcastTypingToRegistry = async (typing: boolean): Promise<void> => {
    for (const p of this.broadcastTargets()) {
      try {
        await this.opts.transport.setTyping(
          { accountId: p.accountId, senderId: p.senderId, messageId: "typing", contextToken: p.contextToken },
          typing,
        );
      } catch (err) {
        this.opts.logger.warn(
          { err, project: this.projectId, account: p.accountId, sender: p.senderId, typing },
          "typing broadcast to participant failed (ignored)",
        );
      }
    }
  };

  /** ④ Broadcast the agent's final reply to every authorized participant. */
  private readonly broadcastToRegistry = async (text: string): Promise<DeliveryReport> => {
    const targets = this.broadcastTargets();
    const report: DeliveryReport = {
      attempted: targets.length,
      succeeded: 0,
      failed: 0,
      failedAccounts: [],
    };
    for (const p of targets) {
      try {
        await this.sendTo(p, text);
        report.succeeded += 1;
      } catch (err) {
        report.failed += 1;
        report.failedAccounts.push(p.accountId);
        this.opts.logger.warn(
          { err, project: this.projectId, account: p.accountId, sender: p.senderId },
          "broadcast to participant failed",
        );
      }
    }
    return report;
  };

  /** ③ Notify every other authorized participant that a sender spoke. */
  private async notifyOthers(msg: InboundMessage): Promise<void> {
    const originKey = `${msg.accountId}:${msg.senderId}`;
    const name = this.opts.resolveSenderName?.(msg.accountId) ?? msg.accountId;
    const text = msg.text?.trim() ? msg.text.trim() : attachmentPlaceholder(msg);
    const notify = `${name}: ${text}`;
    for (const p of this.broadcastTargets()) {
      if (`${p.accountId}:${p.senderId}` === originKey) continue;
      await this.sendTo(p, notify).catch((err: unknown) =>
        this.opts.logger.warn(
          { err, account: p.accountId, sender: p.senderId },
          "notify other participant failed",
        ),
      );
    }
  }

  private requireSession(): SessionController {
    if (!this.session) throw new Error(`project "${this.projectId}" session not started`);
    return this.session;
  }
}

function attachmentPlaceholder(msg: InboundMessage): string {
  const kind = msg.attachments[0]?.kind;
  if (kind === "image") return "[图片]";
  if (kind === "file") return "[文件]";
  if (kind === "video") return "[视频]";
  if (kind === "voice") return "[语音]";
  return "[消息]";
}
