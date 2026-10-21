import type { Logger } from "../util/logger.js";
import {
  RecipientUnavailableError,
  type ResolveRecipientAccount,
  resolveRecipient,
} from "../weixin/recipient.js";
import type { InboundMessage, TurnContext, WeixinTransport } from "../weixin/types.js";

export class OutboundDeliveryError extends Error {
  constructor(
    readonly operation: "text" | "file" | "typing",
    readonly accountId: string,
    options: { cause: unknown },
  ) {
    // Upstream errors can contain payloads or credentials; never retain them in logged errors.
    super(`weixin ${operation} delivery failed for account ${accountId}`, {
      cause: options.cause instanceof RecipientUnavailableError ? options.cause : undefined,
    });
    this.name = "OutboundDeliveryError";
  }
}

/**
 * Per-project outbound facade. Routes every outbound call to the per-account
 * transport owning the TurnContext's accountId. Inbound is NOT broadcast here —
 * the daemon's dispatch routes account -> project -> ProjectController.handleMessage,
 * so the controller consumes inbound directly (see ProjectController).
 */
export class ProjectTransport implements WeixinTransport {
  constructor(
    private readonly getTransport: (accountId: string) => WeixinTransport | undefined,
    private readonly resolveAccount: ResolveRecipientAccount,
    private readonly logger: Logger,
  ) {}

  resolve(ctx: TurnContext): { ctx: TurnContext; transport: WeixinTransport } {
    try {
      const recipient = resolveRecipient(ctx, this.resolveAccount);
      const transport = this.getTransport(ctx.accountId);
      if (!transport) throw new RecipientUnavailableError("missing-transport", recipient.senderId);
      return { ctx: recipient, transport };
    } catch (err) {
      if (err instanceof RecipientUnavailableError) {
        this.logger.warn(
          { account: ctx.accountId, status: "skipped", reason: err.reason },
          "weixin delivery target skipped",
        );
      }
      throw err;
    }
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(ctx: TurnContext, text: string): Promise<void> {
    try {
      const target = this.resolve(ctx);
      await target.transport.sendText(target.ctx, text);
    } catch (cause) {
      throw new OutboundDeliveryError("text", ctx.accountId, { cause });
    }
  }

  async sendFile(ctx: TurnContext, path: string, caption?: string): Promise<void> {
    try {
      const target = this.resolve(ctx);
      await target.transport.sendFile(target.ctx, path, caption);
    } catch (cause) {
      throw new OutboundDeliveryError("file", ctx.accountId, { cause });
    }
  }

  async setTyping(ctx: TurnContext, typing: boolean): Promise<void> {
    try {
      const target = this.resolve(ctx);
      await target.transport.setTyping(target.ctx, typing);
    } catch (cause) {
      throw new OutboundDeliveryError("typing", ctx.accountId, { cause });
    }
  }

  /** Outbound-only facade: inbound dispatch goes directly to ProjectController. */
  onMessage(_handler: (message: InboundMessage) => Promise<void>): () => void {
    return () => {};
  }
}
