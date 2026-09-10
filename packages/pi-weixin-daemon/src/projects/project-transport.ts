import type { InboundMessage, TurnContext, WeixinTransport } from "../weixin/types.js";

export class OutboundDeliveryError extends Error {
  constructor(
    readonly operation: "text" | "file" | "typing",
    readonly accountId: string,
    options: { cause: unknown },
  ) {
    super(`weixin ${operation} delivery failed for account ${accountId}`, options);
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
  private readonly accountIds: Set<string>;
  private handlers: Array<(message: InboundMessage) => Promise<void>> = [];

  constructor(
    accounts: string[],
    private readonly getTransport: (accountId: string) => WeixinTransport | undefined,
  ) {
    this.accountIds = new Set(accounts);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(ctx: TurnContext, text: string): Promise<void> {
    try {
      await this.require(ctx).sendText(ctx, text);
    } catch (cause) {
      throw new OutboundDeliveryError("text", ctx.accountId, { cause });
    }
  }

  async sendFile(ctx: TurnContext, path: string, caption?: string): Promise<void> {
    try {
      await this.require(ctx).sendFile(ctx, path, caption);
    } catch (cause) {
      throw new OutboundDeliveryError("file", ctx.accountId, { cause });
    }
  }

  async setTyping(ctx: TurnContext, typing: boolean): Promise<void> {
    try {
      await this.require(ctx).setTyping(ctx, typing);
    } catch (cause) {
      throw new OutboundDeliveryError("typing", ctx.accountId, { cause });
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private require(ctx: TurnContext): WeixinTransport {
    const t = this.getTransport(ctx.accountId);
    if (!t) {
      throw new Error(`no weixin transport for account: ${ctx.accountId}`);
    }
    return t;
  }
}
