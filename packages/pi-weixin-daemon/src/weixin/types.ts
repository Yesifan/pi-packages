/**
 * Shared types connecting the weixin transport layer with the agent layer.
 *
 * These are daemon-owned types (NOT Tencent iLink API types): the weixin
 * implementation normalizes iLink wire messages into InboundMessage, and the
 * agent layer only ever sees these shapes.
 */

/** Origin of the current agent turn. Every reply goes back to this origin only. */
export interface TurnContext {
  accountId: string;
  senderId: string;
  messageId: string;
  /** iLink conversation context token; must be passed back when replying. */
  contextToken?: string;
}
export type InboundAttachmentKind = "image" | "file" | "video" | "voice";

export interface InboundAttachment {
  kind: InboundAttachmentKind;
  /** Local path after download (media/download). */
  localPath: string;
  /** Sanitized original filename, if known. */
  filename?: string;
  mimeType?: string;
}

/** A media item that failed to download/decrypt (still surfaced so the agent can tell the user). */
export interface MediaFailure {
  kind: InboundAttachmentKind;
  filename?: string;
}

/** A normalized inbound weixin message (DM). */
export interface InboundMessage {
  accountId: string;
  senderId: string;
  messageId: string;
  contextToken?: string;
  text?: string;
  attachments: InboundAttachment[];
  /** Media items whose download/decrypt failed; injected as a prompt note. */
  mediaFailures?: MediaFailure[];
  createdAt: number;
}

/**
 * Weixin transport facade implemented by the weixin layer.
 * The agent layer must never import Tencent iLink types.
 */
export interface WeixinTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(ctx: TurnContext, text: string): Promise<void>;
  sendFile(ctx: TurnContext, path: string, caption?: string): Promise<void>;
  setTyping(ctx: TurnContext, typing: boolean): Promise<void>;
  /** Subscribe to inbound DM messages. Returns an unsubscribe function. */
  onMessage(handler: (message: InboundMessage) => Promise<void>): () => void;
}
