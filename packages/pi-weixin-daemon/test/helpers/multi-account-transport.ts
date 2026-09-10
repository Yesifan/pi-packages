import type { InboundMessage, TurnContext, WeixinTransport } from "../../src/weixin/types.js";

/**
 * Routes outbound calls to the transport owning the TurnContext's account.
 * Inbound subscriptions are fan-out over all registered transports.
 *
 * The daemon registers one WeixinTransport per account; the bridge and the
 * weixin runtime extension only ever talk to this facade.
 */
export class MultiAccountTransport implements WeixinTransport {
  private byAccount = new Map<string, WeixinTransport>();
  private handlers: Array<(message: InboundMessage) => Promise<void>> = [];
  private unsubscribes: Array<() => void> = [];

  register(accountId: string, transport: WeixinTransport): void {
    if (this.byAccount.has(accountId)) {
      throw new Error(`transport already registered for account: ${accountId}`);
    }
    this.byAccount.set(accountId, transport);
    this.unsubscribes.push(
      transport.onMessage(async (message) => {
        for (const handler of [...this.handlers]) {
          await handler(message);
        }
      }),
    );
  }

  unregister(accountId: string): void {
    this.byAccount.delete(accountId);
  }

  has(accountId: string): boolean {
    return this.byAccount.has(accountId);
  }

  async start(): Promise<void> {
    // transports are started/stopped by the daemon directly
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
  }

  async sendText(ctx: TurnContext, text: string): Promise<void> {
    const t = this.require(ctx);
    await t.sendText(ctx, text);
  }

  async sendFile(ctx: TurnContext, path: string, caption?: string): Promise<void> {
    const t = this.require(ctx);
    await t.sendFile(ctx, path, caption);
  }

  async setTyping(ctx: TurnContext, typing: boolean): Promise<void> {
    const t = this.require(ctx);
    await t.setTyping(ctx, typing);
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private require(ctx: TurnContext): WeixinTransport {
    const t = this.byAccount.get(ctx.accountId);
    if (!t) {
      throw new Error(`no weixin transport for account: ${ctx.accountId}`);
    }
    return t;
  }
}
