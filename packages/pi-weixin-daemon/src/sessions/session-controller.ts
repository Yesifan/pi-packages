import { randomUUID } from "node:crypto";
import type { PiHostEvent } from "../pi/events.js";
import type { InteractionPort } from "../pi/ports.js";
import type { HostPromptInput } from "../pi/types.js";
import type { Logger } from "../util/logger.js";
import { formatUserFacingError } from "../util/user-facing-error.js";
import type { InboundMessage, TurnContext, WeixinTransport } from "../weixin/types.js";
import {
  type CliPromptRequest,
  type CliPromptResult,
  type PromptDeliveryResult,
  validateCliPrompt,
} from "./cli-prompt.js";
import { type DaemonCommand, helpText } from "./commands.js";
import { buildPromptInput } from "./prompt.js";
import { ResponseAccumulator } from "./response-accumulator.js";
import type { SessionRuntimePort } from "./runtime-port.js";
import { BUSY_REPLY, type SessionState } from "./session-state.js";
import { type CurrentTurn, isCliTurn, type TurnOrigin, toTurnContext } from "./turn-context.js";
import type { DeliveryReport, TurnIssue, TurnOutcome } from "./turn-outcome.js";

interface CliRequestState {
  messageId: string;
  caller: boolean;
  messages: string[];
  deliver: (text: string) => Promise<PromptDeliveryResult>;
  resolve?: (result: CliPromptResult) => void;
  result?: CliPromptResult;
}

class SessionSelectionError extends Error {}

/** Default auto-close idle window for a shared session (10 minutes). */
export const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
/** Maximum turn duration before aborting Pi; disabled by default. */
export const DEFAULT_TURN_TIMEOUT_MS = 0;
/** Time allowed for Pi to settle after a timeout abort. */
export const DEFAULT_ABORT_GRACE_MS = 10_000;
/** Refresh interval for Weixin's transient typing state. */
export const DEFAULT_TYPING_KEEPALIVE_MS = 5_000;
/** Inactivity timeout for a Weixin slash selector. */
export const DEFAULT_SLASH_INTERACTION_TIMEOUT_MS = 30_000;

export interface SessionControllerDeps {
  projectId: string;
  defaultSessionId?: string;
  saveDefaultSession?: (sessionId: string) => void;
  host: SessionRuntimePort;
  interaction: InteractionPort;
  transport: WeixinTransport;
  /** Shared turn-origin holder (also read by the interaction controller). */
  currentTurn: CurrentTurn;
  logger: Logger;
  /** Idle window before the session is disposed (min for tests). */
  sessionIdleMs?: number;
  /** Login user allowed to answer a directed interaction on this account. */
  resolveRecipientUserId: (accountId: string) => string | undefined;
  /** Broadcast a turn's final reply / idle-close notice to bound project users. */
  broadcastText?: (text: string) => Promise<DeliveryReport> | Promise<void>;
  /** Set or clear typing for all bound project users. */
  broadcastTyping?: (typing: boolean) => Promise<void>;
  /** Typing refresh interval; primarily configurable for tests. */
  typingKeepaliveMs?: number;
  /** Human label for an inbound sender (used in "-- from weixin <name>"). */
  resolveSenderLabel?: (msg: InboundMessage) => string;
  /** Optional maximum duration of one Pi turn; 0 disables the watchdog (default). */
  turnTimeoutMs?: number;
  /** Grace period for Pi to settle after a watchdog abort. */
  abortGraceMs?: number;
  /** Slash selector inactivity timeout (min for tests). */
  slashInteractionTimeoutMs?: number;
}

/**
 * Single session lifecycle state machine (ADR-0004 Invariant 2).
 *
 * Owns: turn serialization (busy refusal), idle timer (real dispose), and the
 * `inactive/ready/busy/replacing/faulted` transitions. Command *classification*
 * lives in the project layer (`CommandRouter`); command *execution* lives here.
 */
export class SessionController {
  private state: SessionState = "inactive";
  private defaultSessionId?: string;
  private error?: string;
  private lastActivityAt = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private selector: SlashSelector | undefined;
  private generation = 0;
  private activeRun: AgentRun | undefined;
  private inboundRun: AgentRun | undefined;
  private pendingInboundOrigin: TurnOrigin | undefined;
  private cliRequest?: CliRequestState;
  private pendingDeliveries = 0;
  private delivery = Promise.resolve();
  private unsubscribe: () => void;

  constructor(private readonly deps: SessionControllerDeps) {
    this.defaultSessionId = deps.defaultSessionId;
    this.unsubscribe = deps.host.onEvent((event) => this.onHostEvent(event));
  }

  private invalidateRuns(): void {
    this.activeRun?.accumulator.handleEvent({ type: "agent_settled" });
    this.generation++;
    this.activeRun = undefined;
    this.inboundRun = undefined;
    this.pendingInboundOrigin = undefined;
    this.pendingDeliveries = 0;
  }

  private onHostEvent(event: PiHostEvent): void {
    if (event.type === "session_bound") {
      this.invalidateRuns();
      if (this.state === "busy" && !this.deps.currentTurn.get()) {
        this.state = "ready";
        this.scheduleIdleCheck();
      }
      return;
    }
    if (!this.deps.host.hasSession() || this.state === "inactive" || this.state === "faulted")
      return;
    if (event.type === "agent_started") {
      // SDK continuations can emit another start before the same settled event.
      if (!this.activeRun) {
        this.activeRun = {
          accumulator: new ResponseAccumulator(),
          origin: this.pendingInboundOrigin,
          generation: this.generation,
        };
        if (this.pendingInboundOrigin) this.inboundRun = this.activeRun;
        this.pendingInboundOrigin = undefined;
      }
      this.state = "busy";
      this.scheduleIdleCheck();
      return;
    }
    const run = this.activeRun;
    if (!run || run.generation !== this.generation) return;
    run.accumulator.handleEvent(event);
    if (event.type !== "agent_settled") return;
    this.activeRun = undefined;
    this.pendingDeliveries++;
    const outcome = run.accumulator.getOutcome();
    const generation = run.generation;
    const deliver = async () => {
      if (generation !== this.generation || !this.deps.host.hasSession()) return;
      try {
        await this.deliverOutcome(run.origin, outcome);
      } catch (err) {
        this.deps.logger.error(
          { err, project: this.deps.projectId },
          "agent reply delivery failed",
        );
      } finally {
        if (generation === this.generation) this.pendingDeliveries--;
        if (
          generation === this.generation &&
          this.pendingDeliveries === 0 &&
          !this.activeRun &&
          !this.deps.currentTurn.get()
        ) {
          this.state = "ready";
          this.lastActivityAt = Date.now();
          this.scheduleIdleCheck();
        }
      }
    };
    run.delivered = this.delivery.then(deliver);
    this.delivery = run.delivered;
  }

  getState(): SessionState {
    return this.state;
  }

  getFault(): string | undefined {
    return this.error;
  }

  getStatus() {
    return { ...this.deps.host.getStatus(), defaultSessionId: this.defaultSessionId };
  }

  async start(): Promise<void> {
    // stop() removes the listener; a restarted controller must resubscribe.
    this.unsubscribe();
    this.unsubscribe = this.deps.host.onEvent((event) => this.onHostEvent(event));
    await this.deps.host.start();
    this.state = "inactive";
  }

  async stop(): Promise<void> {
    this.deps.interaction.cancelUiWaiters("session stopped");
    if (this.cliRequest) {
      this.cliRequest.result = { status: "error", error: "session stopped" };
      this.finishCli(this.cliRequest);
    }
    this.invalidateRuns();
    this.unsubscribe();
    this.clearSelector();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    await this.deps.host
      .stop()
      .catch((err: unknown) =>
        this.deps.logger.warn({ err, project: this.deps.projectId }, "host stop error"),
      );
    this.state = "inactive";
  }

  /** All trusted local CLI processes share this project's one caller identity. */
  async handleCliPrompt(
    input: CliPromptRequest,
    deliver: (text: string) => Promise<PromptDeliveryResult>,
  ): Promise<CliPromptResult> {
    validateCliPrompt(input);
    const origin = this.deps.currentTurn.get();
    if (this.deps.interaction.isUiInteractionActive()) {
      if (
        !origin ||
        !isCliTurn(origin) ||
        !this.cliRequest ||
        input.newSession ||
        (input.sessionId && input.sessionId !== this.deps.host.getStatus().sessionId)
      )
        throw new Error(BUSY_REPLY);
      if (this.cliRequest.resolve) throw new Error(BUSY_REPLY);
      const response = this.waitForCli(this.cliRequest);
      this.lastActivityAt = Date.now();
      this.deps.interaction.tryResolveUi(origin, input.text);
      if (this.deps.interaction.isUiInteractionActive()) this.cliWaiting();
      return response;
    }
    if (this.state === "busy" || this.state === "replacing" || this.selector?.kind === "resume")
      throw new Error(BUSY_REPLY);
    if (this.state === "faulted") throw new Error(this.error ?? "session faulted");
    this.state = "replacing";
    try {
      if (this.selector) await this.cancelSelector("CLI 已开始处理新任务，本次选择已取消。");
      await this.activateSession(input.sessionId, input.newSession);
    } catch (err) {
      this.state =
        err instanceof SessionSelectionError
          ? this.deps.host.hasSession()
            ? "ready"
            : "inactive"
          : "faulted";
      if (this.state === "faulted") this.error = formatUserFacingError(err);
      throw err;
    }
    const request: CliRequestState = {
      messageId: randomUUID(),
      caller: (input.reply ?? ["caller"]).includes("caller"),
      messages: [],
      deliver,
    };
    this.cliRequest = request;
    const response = this.waitForCli(request);
    void this.runTurn({ text: input.text }, { kind: "cli", messageId: request.messageId })
      .catch((err: unknown) => {
        request.result = { status: "error", error: formatUserFacingError(err) };
      })
      .finally(() => this.finishCli(request));
    return response;
  }

  recordCliText(text: string): void {
    this.cliRequest?.messages.push(text);
  }

  cliWaiting(): void {
    const request = this.cliRequest;
    if (!request) return;
    this.respondCli(request, { status: "waiting" });
  }

  private waitForCli(request: CliRequestState): Promise<CliPromptResult> {
    return new Promise((resolve) => {
      request.resolve = resolve;
    });
  }

  private respondCli(request: CliRequestState, result: CliPromptResult): void {
    const resolve = request.resolve;
    if (!resolve) return;
    request.resolve = undefined;
    resolve({
      ...result,
      sessionId: result.sessionId ?? this.deps.host.getStatus().sessionId,
      messages: request.messages.splice(0),
    });
  }

  private finishCli(request: CliRequestState): void {
    if (this.cliRequest !== request) return;
    this.respondCli(request, request.result ?? { status: "success" });
    this.cliRequest = undefined;
  }

  /** Execute an explicitly-mapped daemon command (classification done upstream). */
  async handleCommand(command: DaemonCommand, args: string, msg: InboundMessage): Promise<void> {
    this.lastActivityAt = Date.now();
    this.scheduleIdleCheck();

    const turn = toTurnContext(msg);
    this.deps.logger.info(
      { command, accountId: msg.accountId, messageId: msg.messageId },
      "command",
    );
    try {
      if (
        this.deps.interaction.isUiInteractionActive() &&
        command !== "abort" &&
        command !== "status" &&
        command !== "help"
      ) {
        await this.reply(turn, "当前正在等待 Pi UI 交互回复，请先完成或中止该交互。");
        return;
      }
      await this.executeCommand(command, args, turn);
    } catch (err) {
      this.deps.logger.error(
        { err, command, project: this.deps.projectId },
        "command execution failed",
      );
      // A failed outbound send cannot be reported over the same failed channel;
      // let that second failure reach the project boundary for structured logging.
      await this.reply(turn, `⚠️ 命令 /${command} 执行失败：${formatUserFacingError(err)}`);
    }
  }

  private async executeCommand(
    command: DaemonCommand,
    args: string,
    turn: TurnContext,
  ): Promise<void> {
    switch (command) {
      case "help":
        await this.reply(turn, helpText(args));
        return;
      case "status":
        await this.reply(turn, this.formatStatus());
        return;
      case "abort":
        if (this.state !== "busy") {
          await this.reply(turn, "当前没有正在执行的任务。");
          return;
        }
        await this.reply(turn, "⏹ 已发送中止指令。");
        this.deps.interaction.cancelUiWaiters("aborted");
        await this.deps.host.abort();
        return;
      case "new":
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, "Agent 忙时不能新建会话，请先 /abort 或等待完成。");
          return;
        }
        this.state = "replacing";
        try {
          const previous = this.deps.host.hasSession()
            ? this.deps.host.getStatus().sessionId
            : undefined;
          const result = await this.deps.host.newSession();
          if (!result.cancelled) await this.activated(previous, true);
          await this.reply(turn, result.cancelled ? "⚠️ 已取消新建会话。" : "✅ 已新建会话。");
          if (this.state === "replacing") this.state = "ready";
        } catch (err) {
          this.state = "faulted";
          this.error = formatUserFacingError(err);
          await this.reply(turn, `⚠️ 新建会话失败：${this.error}`);
        }
        return;
      case "default": {
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, BUSY_REPLY);
          return;
        }
        const id =
          args.trim() ||
          (this.deps.host.hasSession() ? this.deps.host.getStatus().sessionId : undefined);
        if (!id) throw new Error("当前没有活动会话");
        this.state = "replacing";
        try {
          if (!this.deps.host.hasSession() || id !== this.deps.host.getStatus().sessionId)
            await this.findSession(id);
          this.setDefaultSession(id);
        } finally {
          this.state = this.deps.host.hasSession() ? "ready" : "inactive";
        }
        await this.reply(turn, `✅ 默认会话已设为 ${id}，活动会话不变。`);
        return;
      }
      case "model":
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, BUSY_REPLY);
          return;
        }
        await this.openModelSelector(turn);
        return;
      case "thinking":
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, BUSY_REPLY);
          return;
        }
        if (!this.deps.host.hasSession()) {
          await this.reply(turn, "当前没有活动会话，请先选择模型或发送消息创建会话。");
          return;
        }
        await this.openThinkingSelector(turn);
        return;
      case "resume":
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, "Agent 忙时不能恢复会话，请先 /abort 或等待完成。");
          return;
        }
        this.state = "replacing";
        try {
          if (args.trim().toLowerCase() === "latest") {
            if (this.deps.host.hasSession()) {
              await this.reply(turn, "当前已经在最新的会话中了。");
              return;
            }
            const sessions = await this.deps.host.listSessions();
            if (!sessions.length) {
              await this.reply(turn, "没有可恢复的历史会话。");
              return;
            }
            const [latestSession] = sessions;
            if (!latestSession) return;
            await this.switchToSession(turn, latestSession.path);
            return;
          }
          if (args.trim()) {
            const id = args.trim() === "default" ? this.defaultSessionId : args.trim();
            if (!id) throw new Error("尚未设置默认会话");
            const target = await this.findSession(id);
            await this.switchToSession(turn, target.path);
            return;
          }
          await this.openResumeSelector(turn);
          return;
        } finally {
          if (this.state === "replacing")
            this.state = this.deps.host.hasSession() ? "ready" : "inactive";
        }
      case "reload":
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, "Agent 忙时不能重载，请先 /abort 或等待完成。");
          return;
        }
        if (!this.deps.host.hasSession()) {
          await this.reply(turn, "当前没有活动会话，无需重载。");
          return;
        }
        await this.deps.host.reload();
        await this.reply(turn, "✅ 已重新加载 Pi 配置和扩展。");
        return;
      case "compact":
        if (this.state === "busy" || this.state === "replacing") {
          await this.reply(turn, "Agent 忙时不能压缩会话，请先 /abort 或等待完成。");
          return;
        }
        await this.deps.host.compact();
        await this.reply(turn, "✅ 已请求会话压缩。");
        return;
    }
  }

  private setDefaultSession(id: string): void {
    this.deps.saveDefaultSession?.(id);
    this.defaultSessionId = id;
  }

  private async findSession(id: string) {
    const session = (await this.deps.host.listSessions()).find((item) => item.id === id);
    if (!session) throw new SessionSelectionError(`会话不存在或无法读取：${id}`);
    return session;
  }

  private async activated(previous: string | undefined, notify: boolean): Promise<void> {
    const id = this.deps.host.getStatus().sessionId;
    if (!id) throw new Error("会话激活失败：缺少 ID");
    if (!this.defaultSessionId) this.setDefaultSession(id);
    this.error = undefined;
    if (notify && previous !== id) {
      try {
        const title =
          (await this.deps.host.listSessions()).find((item) => item.id === id)?.name || id;
        await this.deps.broadcastText?.(`当前会话已切换为「${title}」`);
      } catch (err) {
        this.deps.logger.warn({ err }, "session switch notification failed");
      }
    }
  }

  /** Caller holds the project's replacing/busy gate before awaiting this operation. */
  private async activateSession(id?: string, fresh = false): Promise<void> {
    const previous = this.deps.host.hasSession() ? this.deps.host.getStatus().sessionId : undefined;
    const target = id ?? this.defaultSessionId;
    if (fresh) {
      if ((await this.deps.host.newSession()).cancelled)
        throw new SessionSelectionError("已取消新建会话");
    } else if (target) {
      if (previous !== target) {
        const session = await this.findSession(target);
        if ((await this.deps.host.resumeSession(session.path)).cancelled)
          throw new SessionSelectionError("已取消恢复会话");
      }
    } else {
      await this.deps.host.ensureSession();
    }
    await this.activated(previous, fresh || Boolean(id) || previous !== undefined);
  }

  private isInteractionRecipient(origin: TurnOrigin, incoming: TurnContext): boolean {
    if (isCliTurn(origin)) return false;
    const userId = this.deps.resolveRecipientUserId(origin.accountId);
    return origin.accountId === incoming.accountId && !!userId && userId === incoming.senderId;
  }

  /** Route an ordinary user message (UI answer, busy refusal, or a new turn). */
  async handleUserMessage(msg: InboundMessage): Promise<void> {
    this.lastActivityAt = Date.now();
    this.scheduleIdleCheck();

    // UI answers must come from the account user who receives the dialog.
    if (this.deps.interaction.isUiInteractionActive()) {
      const turn = this.deps.currentTurn.get();
      if (turn && this.isInteractionRecipient(turn, msg)) {
        this.deps.logger.info({ accountId: msg.accountId }, "UI response received");
        this.deps.interaction.tryResolveUi(turn, msg.text ?? "");
      } else {
        this.deps.logger.info(
          { accountId: msg.accountId, senderId: msg.senderId },
          "busy refusal (ui)",
        );
        await this.reply(toTurnContext(msg), BUSY_REPLY);
      }
      return;
    }

    const turn = toTurnContext(msg);

    if (this.selector) {
      if (this.isInteractionRecipient(this.selector.turn, turn)) {
        await this.handleSelectorInput(msg.text ?? "");
        return;
      }
      if (this.selector.kind === "resume") {
        await this.reply(turn, "当前项目正在选择要恢复的会话，请稍后再试。");
        return;
      }
      await this.cancelSelector("Agent 已开始处理新任务，本次选择已取消。");
    }

    if (this.state === "busy" || this.state === "replacing") {
      this.deps.logger.info(
        { accountId: msg.accountId, senderId: msg.senderId, state: this.state },
        "busy refusal",
      );
      await this.reply(turn, BUSY_REPLY);
      return;
    }
    if (this.state === "faulted") {
      await this.reply(turn, `⚠️ 项目会话不可用：${this.error ?? "unknown error"}`);
      return;
    }

    // inactive → default (or the first lazy session); never replace missing history silently.
    if (this.state === "inactive") {
      try {
        this.state = "replacing";
        await this.activateSession();
        this.state = "ready";
      } catch (err) {
        this.state = err instanceof SessionSelectionError ? "inactive" : "faulted";
        this.error = formatUserFacingError(err);
        this.deps.logger.error({ err, project: this.deps.projectId }, "session creation failed");
        await this.reply(turn, `⚠️ 项目启动失败，已拒绝消息：${this.error}`);
        return;
      }
    }

    await this.runTurn(buildPromptInput(msg, this.deps.resolveSenderLabel?.(msg)), turn);
  }

  private async runTurn(input: HostPromptInput, turn: TurnOrigin): Promise<void> {
    if (this.selector) await this.cancelSelector("Agent 已开始处理新任务，本次选择已取消。");
    this.deps.currentTurn.set(turn);
    this.pendingInboundOrigin = turn;
    this.state = "busy";
    let nextState: SessionState = "ready";

    const stopTyping = await this.startTyping(turn);
    try {
      let outcome: TurnOutcome | undefined;
      let run: AgentRun | undefined;

      try {
        const operation = (async () => {
          await this.deps.host.prompt(input);
          run = this.inboundRun;
          if (run) await run.accumulator.settled;
        })();
        // Avoid an unhandled rejection if a hard timeout returns before a stuck
        // provider operation eventually rejects.
        void operation.catch(() => undefined);
        await withTimeout(operation, this.turnTimeoutMs(), "turn");
        // The settlement handler may already have detached the run. Delivery
        // is serialized on the session-wide chain below.
        if (run?.delivered) await run.delivered;
      } catch (err) {
        if (err instanceof TurnTimeoutError) {
          this.invalidateRuns();
          const stopped = await this.abortTimedOutTurn();
          if (!stopped) {
            nextState = "faulted";
            this.error = "Agent 运行超时且未能正常停止";
          }
          outcome = {
            status: "error",
            text: "",
            error: { source: "timeout", message: this.error ?? "任务已中止，请重试" },
            warnings: [],
          };
          this.deps.logger.error(
            { project: this.deps.projectId, messageId: turn.messageId, stopped },
            "agent turn timed out",
          );
        } else {
          this.deps.logger.warn(
            { err, project: this.deps.projectId, messageId: turn.messageId },
            "agent run failed",
          );
          const partialText = (run ?? this.activeRun)?.accumulator.accumulatedText.trim() ?? "";
          this.invalidateRuns();
          outcome = {
            status: "error",
            text: partialText,
            error: { source: "pi", message: formatUserFacingError(err) },
            warnings: [],
          };
        }
      }

      await stopTyping();
      if (outcome) await this.deliverOutcome(turn, outcome, turn.messageId);
    } finally {
      await stopTyping();
      this.deps.interaction.cancelUiWaiters("turn ended");
      this.deps.currentTurn.set(undefined);
      this.inboundRun = undefined;
      this.pendingInboundOrigin = undefined;
      if (!this.activeRun && this.pendingDeliveries === 0) this.state = nextState;
      this.lastActivityAt = Date.now();
      this.scheduleIdleCheck();
    }
  }

  private async startTyping(turn: TurnOrigin): Promise<() => Promise<void>> {
    const send = async (typing: boolean): Promise<void> => {
      try {
        if (this.deps.broadcastTyping) await this.deps.broadcastTyping(typing);
        else if (!isCliTurn(turn)) await this.deps.transport.setTyping(turn, typing);
      } catch (err) {
        this.deps.logger.warn(
          { err, project: this.deps.projectId, typing },
          "typing update failed (ignored)",
        );
      }
    };

    await send(true);
    let closed = false;
    let inFlight = Promise.resolve();
    const timer = setInterval(() => {
      if (closed) return;
      // Serialize refreshes so cleanup cannot race a delayed status=1 request.
      inFlight = inFlight.then(() => send(true));
    }, this.deps.typingKeepaliveMs ?? DEFAULT_TYPING_KEEPALIVE_MS);
    timer.unref();

    return async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await inFlight;
      await send(false);
    };
  }

  private async deliverOutcome(
    turn: TurnOrigin | undefined,
    outcome: TurnOutcome,
    messageId?: string,
  ): Promise<void> {
    if (turn && isCliTurn(turn)) {
      const request = this.cliRequest;
      if (!request || request.messageId !== turn.messageId) return;
      const result: CliPromptResult = {
        sessionId: this.deps.host.getStatus().sessionId,
        status: outcome.status,
      };
      if (outcome.status === "success") {
        if (request.caller) result.text = outcome.text;
        if (outcome.text) result.delivery = await request.deliver(outcome.text);
      } else {
        result.error =
          outcome.status === "error"
            ? formatUserFacingError(outcome.error.message)
            : (outcome.reason ?? "任务已中止");
      }
      request.messages.push(
        ...outcome.warnings.map((warning) => formatUserFacingError(warning.message)),
      );
      request.result = result;
      return;
    }
    if (outcome.status === "success") {
      if (outcome.text) {
        if (this.deps.broadcastText) {
          const report = await this.deps.broadcastText(outcome.text);
          if (report && report.failed > 0) {
            this.deps.logger[report.succeeded === 0 ? "error" : "warn"](
              { project: this.deps.projectId, messageId, ...report },
              "agent reply broadcast delivery incomplete",
            );
          }
        } else if (turn) {
          await this.reply(turn, outcome.text);
        }
      }
      if (turn && outcome.warnings.length > 0)
        await this.reply(turn, formatWarnings(outcome.warnings));
      if (!turn && outcome.warnings.length > 0)
        this.deps.logger.warn(
          { project: this.deps.projectId, warnings: outcome.warnings },
          "independent agent run extension warnings",
        );
      return;
    }

    if (!turn) {
      this.deps.logger.warn(
        { project: this.deps.projectId, outcome },
        "independent agent run did not succeed",
      );
      return;
    }
    if (outcome.status === "aborted") {
      const suffix = outcome.text ? "\n\n⏹ 任务已中止，上述内容可能不完整。" : "⏹ 已中止。";
      await this.reply(turn, `${outcome.text}${suffix}`);
      return;
    }

    const reason = formatUserFacingError(outcome.error.message);
    const prefix = outcome.text ? `${outcome.text}\n\n⚠️ 上述内容可能不完整。` : "⚠️";
    const label = outcome.error.source === "timeout" ? "Agent 运行超时" : "Agent 运行出错";
    await this.reply(turn, `${prefix} ${label}：${reason}`);
  }

  private turnTimeoutMs(): number {
    return normalizeDuration(this.deps.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
  }

  private async abortTimedOutTurn(): Promise<boolean> {
    try {
      await withTimeout(
        (async () => {
          await this.deps.host.abort();
          await this.deps.host.waitForIdle();
        })(),
        normalizeDuration(this.deps.abortGraceMs, DEFAULT_ABORT_GRACE_MS),
        "abort",
      );
      return true;
    } catch (err) {
      this.deps.logger.error({ err, project: this.deps.projectId }, "timed-out agent did not stop");
      return false;
    }
  }

  private formatStatus(): string {
    const status = this.deps.host.getStatus();
    return [
      "**会话状态**",
      `- Project: ${status?.cwd ?? "(runtime not started)"}`,
      `- Active session: ${status?.sessionId ?? "(none)"}`,
      `- Default session: ${this.defaultSessionId ?? "(none)"}`,
      `- Session: ${status?.sessionFile ?? "(none)"}`,
      `- Agent state: ${this.state}`,
      `- Model: ${status?.model ?? "unknown"}`,
      `- Thinking: ${status?.thinkingLevel ?? "unknown"}`,
      `- Configured trust: ${status?.configuredTrust ?? "?"}`,
      `- Active session trust: ${status?.activeSessionTrust ?? "(no session)"}`,
    ].join("\n");
  }

  private async reply(turn: TurnContext, text: string): Promise<void> {
    await this.deps.transport.sendText(turn, text);
  }

  private async openModelSelector(turn: TurnContext): Promise<void> {
    const options = await this.deps.host.listModels();
    if (!options.length) return this.reply(turn, "没有已配置凭据的可用模型。");
    await this.beginSelector({ kind: "model", turn, page: 0, options, timeoutGeneration: 0 });
  }

  private async openThinkingSelector(turn: TurnContext): Promise<void> {
    const options = await this.deps.host.getThinkingLevels();
    if (!options.length) return this.reply(turn, "当前模型不支持思考强度设置。");
    await this.beginSelector({ kind: "thinking", turn, page: 0, options, timeoutGeneration: 0 });
  }

  private async openResumeSelector(turn: TurnContext): Promise<void> {
    const current = this.deps.host.getStatus().sessionFile;
    const options = (await this.deps.host.listSessions()).filter((item) => item.path !== current);
    if (!options.length) return this.reply(turn, "没有其他可恢复的历史会话。");
    await this.beginSelector({ kind: "resume", turn, page: 0, options, timeoutGeneration: 0 });
  }

  private async beginSelector(selector: SlashSelector): Promise<void> {
    this.clearSelector();
    this.selector = selector;
    this.refreshSelectorTimeout(selector);
    await this.renderSelector(selector);
  }

  /** Restart the selector's inactivity window and invalidate queued old timers. */
  private refreshSelectorTimeout(selector: SlashSelector): void {
    if (selector.timer) clearTimeout(selector.timer);
    const generation = ++selector.timeoutGeneration;
    const timeoutMs = normalizeDuration(
      this.deps.slashInteractionTimeoutMs,
      DEFAULT_SLASH_INTERACTION_TIMEOUT_MS,
    );
    selector.timer = setTimeout(() => {
      if (this.selector !== selector || selector.timeoutGeneration !== generation) return;
      void this.expireSelector(selector);
    }, timeoutMs);
    selector.timer.unref();
  }

  private async renderSelector(selector: SlashSelector): Promise<void> {
    const pageSize = selector.kind === "thinking" ? selector.options.length : 5;
    const pages = Math.max(1, Math.ceil(selector.options.length / pageSize));
    selector.page = Math.min(selector.page, pages - 1);
    const slice = selector.options.slice(selector.page * pageSize, (selector.page + 1) * pageSize);
    const rows = slice.map(
      (item, i) => `- **${String.fromCharCode(97 + i)}.** ${selectorLabel(item)}`,
    );
    const sections: string[] = [];
    if (selector.kind === "model" || selector.kind === "thinking") {
      const status = this.deps.host.getStatus();
      sections.push(
        "**当前设置**",
        `- 模型：${status.model ?? "unknown"}`,
        `- 思考强度：${status.thinkingLevel ?? "unknown"}`,
      );
    }
    sections.push(
      selector.kind === "resume"
        ? "**选择会话**"
        : selector.kind === "model"
          ? "**选择模型**"
          : "**选择思考强度**",
    );
    sections.push(...rows);
    if (selector.kind !== "thinking")
      sections.push(`页 ${selector.page + 1}/${pages}（回复页码翻页）`);
    if (selector.kind === "model" && !this.deps.host.hasSession()) {
      sections.push("当前没有活动会话，选择将切换该项目的默认模型。");
    }
    sections.push(
      selector.kind === "resume"
        ? "回复字母选择、页码翻页，或 `q` 退出。"
        : "回复字母选择、`字母 default` 设项目默认，或 `q` 退出。",
    );
    await this.reply(selector.turn, sections.join("\n\n"));
  }

  private async handleSelectorInput(input: string): Promise<void> {
    const selector = this.selector;
    if (!selector) return;
    const text = input.trim().toLowerCase();
    if (text === "q") {
      this.clearSelector();
      await this.reply(selector.turn, "已退出选择。");
      return;
    }
    const pageSize = selector.kind === "thinking" ? selector.options.length : 5;
    if (/^\d+$/.test(text) && selector.kind !== "thinking") {
      const page = Number(text) - 1;
      if (page >= 0 && page < Math.ceil(selector.options.length / pageSize)) {
        selector.page = page;
        this.refreshSelectorTimeout(selector);
        await this.renderSelector(selector);
      } else {
        this.refreshSelectorTimeout(selector);
        await this.reply(selector.turn, "没有该页，请回复有效页码或 q 退出。");
      }
      return;
    }
    const match = /^([a-e])(?:\s+(default))?$/.exec(text);
    const selectedLetter = match?.[1];
    const index = selectedLetter ? selectedLetter.charCodeAt(0) - 97 : -1;
    const item = selector.options[selector.page * pageSize + index];
    if (!match || !item || index >= pageSize) {
      this.refreshSelectorTimeout(selector);
      await this.reply(selector.turn, "无法识别，请回复选项字母、页码或 q 退出。");
      return;
    }
    const makeDefault =
      Boolean(match[2]) || (selector.kind === "model" && !this.deps.host.hasSession());
    this.clearSelector();
    if (selector.kind === "model") {
      const model = item as ModelChoice;
      await this.deps.host.setModel(model.provider, model.id, makeDefault);
      await this.reply(
        selector.turn,
        `✅ 已选择模型 ${model.provider}/${model.id}${makeDefault ? "，并设为项目默认" : ""}。`,
      );
    } else if (selector.kind === "thinking") {
      const actual = await this.deps.host.setThinkingLevel(item as string, makeDefault);
      await this.reply(
        selector.turn,
        `✅ 思考强度已设为 ${actual}${makeDefault ? "，并设为项目默认" : ""}。`,
      );
    } else {
      await this.switchToSession(selector.turn, (item as SessionChoice).path);
    }
  }

  private async switchToSession(turn: TurnContext, path: string): Promise<void> {
    this.state = "replacing";
    try {
      const previous = this.deps.host.getStatus().sessionId;
      const result =
        this.deps.host.getStatus().sessionFile === path
          ? { cancelled: false }
          : await this.deps.host.resumeSession(path);
      if (!result.cancelled) await this.activated(previous, true);
      await this.reply(turn, result.cancelled ? "⚠️ 已取消恢复会话。" : "✅ 已恢复会话。");
      if (this.state === "replacing") this.state = "ready";
    } catch (err) {
      this.state = "faulted";
      this.error = formatUserFacingError(err);
      await this.reply(turn, `⚠️ 恢复会话失败：${this.error}`);
    }
  }

  private async expireSelector(expected: SlashSelector): Promise<void> {
    if (this.selector !== expected) return;
    this.clearSelector();
    await this.reply(expected.turn, "⏱️ 选择已超时，请重新输入命令。").catch((err: unknown) =>
      this.deps.logger.warn({ err }, "selector timeout reply failed"),
    );
  }

  private async cancelSelector(message: string): Promise<void> {
    const selector = this.selector;
    if (!selector) return;
    this.clearSelector();
    await this.reply(selector.turn, message);
  }

  private clearSelector(): void {
    if (this.selector?.timer) clearTimeout(this.selector.timer);
    this.selector = undefined;
  }

  // --- idle auto-close -------------------------------------------------------

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = this.deps.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    if (!Number.isFinite(idleMs) || idleMs <= 0) return;
    this.idleTimer = setTimeout(() => void this.checkIdle(), idleMs);
  }

  /** `ready →(timeout)→ inactive` performs a real dispose (W3). */
  private async checkIdle(): Promise<void> {
    if (this.state === "busy" || this.state === "replacing") {
      this.scheduleIdleCheck();
      return;
    }
    // Only a live, idle session can be closed; inactive/faulted have nothing.
    if (this.state !== "ready") return;

    const idleMs = this.deps.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    if (Date.now() - this.lastActivityAt < idleMs) {
      this.scheduleIdleCheck();
      return;
    }

    // Real dispose: the SDK runtime is torn down; the wrapper/bridge
    // survive. The next message restores the persistent default identity.
    const closingSessionId = this.deps.host.getStatus().sessionId;
    const notifyClose = !closingSessionId || closingSessionId !== this.defaultSessionId;
    this.state = "replacing";
    this.invalidateRuns();
    try {
      await withTimeout(
        this.deps.host.stop(),
        normalizeDuration(this.deps.abortGraceMs, DEFAULT_ABORT_GRACE_MS),
        "idle close",
      );
      this.state = "inactive";
      this.deps.logger.info({ project: this.deps.projectId }, "session auto-closed (idle)");
      if (notifyClose && this.deps.broadcastText) {
        await this.deps
          .broadcastText("本次会话已关闭")
          .catch((err: unknown) =>
            this.deps.logger.warn(
              { err, project: this.deps.projectId },
              "idle close broadcast failed",
            ),
          );
      }
    } catch (err) {
      this.state = "faulted";
      this.error = formatUserFacingError(err);
      this.deps.logger.error({ err, project: this.deps.projectId }, "session auto-close failed");
      if (this.deps.broadcastText) {
        await this.deps
          .broadcastText(`⚠️ 会话自动关闭失败：${this.error}`)
          .catch((sendErr: unknown) =>
            this.deps.logger.error(
              { err: sendErr, project: this.deps.projectId },
              "idle-close error broadcast failed",
            ),
          );
      }
    }
  }
}

type AgentRun = {
  accumulator: ResponseAccumulator;
  origin?: TurnOrigin;
  generation: number;
  delivered?: Promise<void>;
};

type ModelChoice = { provider: string; id: string; name: string };
type SessionChoice = {
  path: string;
  id: string;
  modifiedAt: number;
  firstMessage: string;
  name?: string;
};
type SlashSelectorBase = {
  turn: TurnContext;
  page: number;
  timer?: NodeJS.Timeout;
  timeoutGeneration: number;
};
type SlashSelector =
  | (SlashSelectorBase & { kind: "model"; options: ModelChoice[] })
  | (SlashSelectorBase & { kind: "thinking"; options: string[] })
  | (SlashSelectorBase & { kind: "resume"; options: SessionChoice[] });

function selectorLabel(item: ModelChoice | SessionChoice | string): string {
  if (typeof item === "string") return item;
  if ("provider" in item)
    return `${item.provider}/${item.id}${item.name === item.id ? "" : ` (${item.name})`}`;
  const title = item.name || item.firstMessage || item.id;
  return `${new Date(item.modifiedAt).toLocaleString("zh-CN")} ${title.replace(/\s+/g, " ").slice(0, 60)}`;
}

class TurnTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = "TurnTimeoutError";
  }
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs === 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError(label)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatWarnings(warnings: TurnIssue[]): string {
  const messages = warnings.map((warning) => formatUserFacingError(warning.message));
  return `⚠️ 本轮有 Pi 扩展运行异常：${messages.join("；")}`;
}
