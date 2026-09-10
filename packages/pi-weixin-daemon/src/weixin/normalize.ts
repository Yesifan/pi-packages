import type { InboundAttachment, InboundMessage, MediaFailure } from "./types.js";
import type { MessageItem, WeixinMessage } from "./api/types.js";
import { MessageItemType, MessageType } from "./api/types.js";
import { generateId } from "./util/random.js";

/** Collect the concatenated text from a message's item_list (text + voice STT). */
export function extractText(message: WeixinMessage): string | undefined {
  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      // Weixin's own STT output (voice_item.text); non-Chinese may be poor, but
      // it's the zero-cost default — voice is treated as text when available.
      parts.push(item.voice_item.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Normalize a raw iLink WeixinMessage into a daemon-owned InboundMessage.
 *
 * Media attachments (image/file/video/voice) are resolved by the transport
 * (download + decrypt) before this function is called; the transport passes
 * the downloaded local paths in `attachments`.
 */
export function normalizeInboundMessage(
  accountId: string,
  raw: WeixinMessage,
  attachments: InboundAttachment[] = [],
  mediaFailures: MediaFailure[] = [],
): InboundMessage {
  const messageId =
    raw.message_id !== undefined && raw.message_id !== 0
      ? String(raw.message_id)
      : raw.client_id ?? generateId("msg");

  // Only user-originated, finished messages are agent input.
  const isUserMessage =
    raw.message_type === undefined || raw.message_type === MessageType.USER;

  return {
    accountId,
    senderId: raw.from_user_id ?? "",
    messageId,
    contextToken: raw.context_token,
    text: extractText(raw),
    attachments: isUserMessage ? attachments : [],
    mediaFailures: isUserMessage ? mediaFailures : [],
    createdAt: raw.create_time_ms ?? Date.now(),
  };
}

/** List media items (non-text) in a message; used by the transport for downloads. */
export function listMediaItems(message: WeixinMessage): MessageItem[] {
  return (message.item_list ?? []).filter(
    (item) =>
      item.type === MessageItemType.IMAGE ||
      item.type === MessageItemType.FILE ||
      item.type === MessageItemType.VIDEO ||
      item.type === MessageItemType.VOICE,
  );
}
