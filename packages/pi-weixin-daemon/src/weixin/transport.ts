import type { Logger } from "../util/logger.js";
import type { InboundMessage, TurnContext, WeixinTransport } from "./types.js";
import { getConfig, notifyStart, notifyStop, sendTyping as sendTypingApi } from "./api/api.js";
import { WeixinConfigManager } from "./api/config-cache.js";
import { MessageType, TypingStatus, type WeixinMessage } from "./api/types.js";
import { resolveWeixinBaseUrl } from "./auth/accounts.js";
import { downloadAttachmentsFromMessage } from "./media/media-download.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import { normalizeInboundMessage } from "./normalize.js";
import { sendTextMessage } from "./messaging/send.js";
import { restoreContextTokens, setContextToken } from "./storage/context-token.js";

/** Inbound gate reply when the account is not bound to any project. */
const GATE_UNBOUND_REPLY = "⚠️ 该账号尚未绑定任何项目，请先绑定 project 后再使用。";

/** Inbound gate reply when the account's bound project is disabled. */
const GATE_DISABLED_REPLY = "⚠️ 该项目已停用，启用后再发送消息。";

export interface WeixinTransportOptions {
  accountId: string;
  /** API base URL; defaults to the account's stored baseUrl or the official endpoint. */
  baseUrl?: string;
  token?: string;
  /**
   * Inbox directory for inbound media: <cwd>/.pi-weixin/inbox.
   * Multi-project: use `resolveInboxDir` instead so the inbox follows the
   * account's current project binding (and media is gated before download).
   */
  inboxDir?: string;
  /**
   * Resolve the effective inbox directory for this account at message time.
   * Explicitly overrides `inboxDir`. When `dir` is undefined, the account has no
   * bound/active project: the whole message is dropped (no media download, no
   * emit) and a gate reply is sent (knowing `reason` picks the right message) —
   * the "gate before download" rule.
   */
  resolveInboxDir?: (
    accountId: string,
  ) => { dir?: string; reason?: "unbound" | "disabled" } | undefined;
  logger: Logger;
  cdnBaseUrl?: string;
}

/**
 * WeixinTransport facade for one account: owns the long-poll monitor, message
 * normalization, outbound text/file sending and the typing indicator.
 *
 * The agent layer only ever sees InboundMessage/TurnContext (weixin/types).
 */
export class ILinkWeixinTransport implements WeixinTransport {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly configManager: WeixinConfigManager;
  private abortController: AbortController | undefined;
  private monitorPromise: Promise<void> | undefined;
  private handlers: Array<(message: InboundMessage) => Promise<void>> = [];
  private stopped = false;

  constructor(private readonly opts: WeixinTransportOptions) {
    this.baseUrl = opts.baseUrl ?? resolveWeixinBaseUrl(opts.accountId);
    this.token = opts.token;
    this.configManager = new WeixinConfigManager(
      { baseUrl: this.baseUrl, token: this.token },
      opts.logger,
    );
  }

  get accountId(): string {
    return this.opts.accountId;
  }

  async start(): Promise<void> {
    if (this.monitorPromise) return;
    const log = this.opts.logger;

    restoreContextTokens(this.opts.accountId);

    // Best-effort start notification (mirrors Tencent's notifyStart on channel start).
    try {
      await notifyStart({ baseUrl: this.baseUrl, token: this.token, logger: log });
    } catch (err) {
      log.warn(`notifyStart failed (ignored): ${String(err)}`);
    }

    this.abortController = new AbortController();
    this.monitorPromise = monitorWeixinProvider({
      baseUrl: this.baseUrl,
      token: this.token,
      accountId: this.opts.accountId,
      abortSignal: this.abortController.signal,
      logger: log,
      onInbound: async (raw: WeixinMessage) => {
        await this.handleInbound(raw);
      },
    });
    this.monitorPromise.catch((err: unknown) => {
      log.error({ err }, `monitor crashed for account ${this.opts.accountId}`);
    });
    log.info({ accountId: this.opts.accountId, baseUrl: this.baseUrl }, "transport started");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const log = this.opts.logger;
    this.abortController?.abort();
    await this.monitorPromise?.catch(() => {});
    this.monitorPromise = undefined;
    // Best-effort stop notification.
    try {
      await notifyStop({ baseUrl: this.baseUrl, token: this.token, logger: log });
    } catch (err) {
      log.warn(`notifyStop failed (ignored): ${String(err)}`);
    }
    log.info({ accountId: this.opts.accountId }, "transport stopped");
  }

  async sendText(ctx: TurnContext, text: string): Promise<void> {
    await sendTextMessage({
      to: ctx.senderId,
      text,
      opts: {
        baseUrl: this.baseUrl,
        token: this.token,
        contextToken: ctx.contextToken,
        logger: this.opts.logger,
      },
    });
  }

  /** Send a file as a native weixin attachment (CDN upload + FILE/IMAGE/VIDEO message). */
  async sendFile(ctx: TurnContext, filePath: string, caption?: string): Promise<void> {
    await sendWeixinMediaFile({
      filePath,
      to: ctx.senderId,
      text: caption ?? "",
      opts: {
        baseUrl: this.baseUrl,
        token: this.token,
        contextToken: ctx.contextToken,
        logger: this.opts.logger,
      },
      cdnBaseUrl: this.opts.cdnBaseUrl,
    });
  }

  async setTyping(ctx: TurnContext, typing: boolean): Promise<void> {
    const log = this.opts.logger;
    try {
      const { typingTicket } = await this.configManager.getForUser(ctx.senderId, ctx.contextToken);
      if (!typingTicket) {
        log.debug(`no typing ticket for user ${ctx.senderId}, skipping sendTyping`);
        return;
      }
      await sendTypingApi({
        baseUrl: this.baseUrl,
        token: this.token,
        body: {
          ilink_user_id: ctx.senderId,
          typing_ticket: typingTicket,
          status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
        },
        logger: log,
      });
    } catch (err) {
      log.warn(`sendTyping failed (ignored): ${String(err)}`);
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private async handleInbound(raw: WeixinMessage): Promise<void> {
    // getUpdates may include bot-originated records. Only user messages are
    // valid Pi input; reject everything else before project lookup, media
    // download, context-token persistence, or participant registration.
    if (raw.message_type !== undefined && raw.message_type !== MessageType.USER) {
      this.opts.logger.debug(
        {
          accountId: this.opts.accountId,
          messageId: raw.message_id,
          messageType: raw.message_type,
          messageState: raw.message_state,
        },
        "dropping non-user inbound message",
      );
      return;
    }

    // Multi-project gate before media download: when a project inbox resolver is
    // configured and yields no dir, the account is unbound / project disabled —
    // drop the message entirely (never download, never emit into Pi) and tell
    // the user why.
    const resolved = this.opts.resolveInboxDir?.(this.opts.accountId);
    if (this.opts.resolveInboxDir && !resolved?.dir) {
      await this.replyGate(raw, resolved?.reason);
      return;
    }
    const inboxDir = resolved?.dir ?? this.opts.inboxDir;

    // Media is downloaded to <inboxDir>/<messageKey>/ before normalization.
    // Download failures never block message processing; the failure is recorded
    // so the agent can surface it to the user.
    const { attachments, failures } = await downloadAttachmentsFromMessage(raw, {
      inboxDir,
      cdnBaseUrl: this.opts.cdnBaseUrl,
      logger: this.opts.logger,
    });
    const msg = normalizeInboundMessage(this.opts.accountId, raw, attachments, failures);
    if (msg.senderId && msg.contextToken) {
      setContextToken(this.opts.accountId, msg.senderId, msg.contextToken);
    }
    for (const handler of [...this.handlers]) {
      await handler(msg);
    }
  }

  /** Send a gate (unbound / disabled) reply back to the sender. */
  private async replyGate(raw: WeixinMessage, reason?: "unbound" | "disabled"): Promise<void> {
    if (!raw.from_user_id) return;
    const ctx: TurnContext = {
      accountId: this.opts.accountId,
      senderId: raw.from_user_id,
      messageId: "gate",
      contextToken: raw.context_token,
    };
    const text = reason === "disabled" ? GATE_DISABLED_REPLY : GATE_UNBOUND_REPLY;
    try {
      await this.sendText(ctx, text);
    } catch (err) {
      this.opts.logger.warn({ err, accountId: this.opts.accountId }, "gate reply failed (ignored)");
    }
  }
}
