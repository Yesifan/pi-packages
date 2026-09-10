import type { InboundMessage, TurnContext, WeixinTransport } from "../../src/weixin/types.js";

/** In-memory WeixinTransport recording every outbound call; can emit inbound messages. */
export class FakeWeixinTransport implements WeixinTransport {
  sentTexts: Array<{ ctx: TurnContext; text: string }> = [];
  sentFiles: Array<{ ctx: TurnContext; path: string; caption?: string }> = [];
  typingEvents: Array<{ ctx: TurnContext; typing: boolean }> = [];
  private handlers: Array<(message: InboundMessage) => Promise<void>> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(ctx: TurnContext, text: string): Promise<void> {
    this.sentTexts.push({ ctx, text });
  }

  async sendFile(ctx: TurnContext, path: string, caption?: string): Promise<void> {
    this.sentFiles.push({ ctx, path, caption });
  }

  async setTyping(ctx: TurnContext, typing: boolean): Promise<void> {
    this.typingEvents.push({ ctx, typing });
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  async emit(message: InboundMessage): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(message);
    }
  }

  /** All text sent to a given account (in order). */
  textsTo(accountId: string): string[] {
    return this.sentTexts.filter((s) => s.ctx.accountId === accountId).map((s) => s.text);
  }

  reset(): void {
    this.sentTexts = [];
    this.sentFiles = [];
    this.typingEvents = [];
  }
}

export function makeTurn(accountId = "acct-a", senderId = "user-a"): TurnContext {
  return { accountId, senderId, messageId: "m-1", contextToken: "tok-1" };
}

export function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    accountId: "acct-a",
    senderId: "user-a",
    messageId: "m-1",
    text: "hello",
    attachments: [],
    createdAt: Date.now(),
    ...overrides,
  };
}
