import type { MessageItem, WeixinMessage } from "./api/types.js";
import { MessageItemType, MessageType } from "./api/types.js";
import type { InboundAttachment, InboundMessage, MediaFailure } from "./types.js";
import { generateId } from "./util/random.js";

/** Collect text + voice STT, optionally annotating voice for the Agent prompt only. */
export function extractText(message: WeixinMessage, annotateVoice = false): string | undefined {
  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MessageItemType.VOICE && item.voice_item?.text?.trim()) {
      // Control/UI routing needs the original transcript, without the prompt note.
      parts.push(
        annotateVoice
          ? `${item.voice_item.text}【以上为用户的语音转录的信息，可能有识别错误】`
          : item.voice_item.text,
      );
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Normalize a raw iLink WeixinMessage into a daemon-owned InboundMessage.
 *
 * Media attachments (image/file/video) are resolved by the transport
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
      : (raw.client_id ?? generateId("msg"));

  // Only user-originated, finished messages are agent input.
  const isUserMessage = raw.message_type === undefined || raw.message_type === MessageType.USER;

  return {
    accountId,
    senderId: raw.from_user_id ?? "",
    messageId,
    contextToken: raw.context_token,
    text: extractText(raw),
    promptText: extractText(raw, true),
    attachments: isUserMessage ? attachments : [],
    mediaFailures: isUserMessage ? mediaFailures : [],
    createdAt: raw.create_time_ms ?? Date.now(),
  };
}

/** List downloadable media items; voice is handled only as transcript text. */
export function listMediaItems(message: WeixinMessage): MessageItem[] {
  return (message.item_list ?? []).filter(
    (item) =>
      item.type === MessageItemType.IMAGE ||
      item.type === MessageItemType.FILE ||
      item.type === MessageItemType.VIDEO,
  );
}
