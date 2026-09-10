import type { Logger } from "../../util/logger.js";
import { sendMessage } from "../api/api.js";
import type { SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import { generateId } from "../util/random.js";

/** Outbound text message options (mirrors Tencent's WeixinMessageSendOptions). */
export type WeixinMessageSendOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  contextToken?: string;
  logger?: Logger;
};

/** Hard safety cap per text message (server may reject very long payloads). */
export const MAX_TEXT_MESSAGE_LEN = 4000;

/** Split long text into <= maxLen chunks at newline boundaries when possible. */
export function splitTextChunks(text: string, maxLen = MAX_TEXT_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Send a plain text message downstream.
 * `to` is the user id the message goes to (the sender of the inbound message).
 */
export async function sendTextMessage(params: {
  to: string;
  text: string;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    opts.logger?.warn(`sendTextMessage: contextToken missing for to=${to}, sending without context`);
  }
  const chunks = splitTextChunks(text);
  let lastMessageId = "";
  let succeededChunks = 0;
  opts.logger?.debug({ to, chunkCount: chunks.length, totalLength: text.length }, "sending weixin text");
  for (const [chunkOffset, chunk] of chunks.entries()) {
    const chunkIndex = chunkOffset + 1;
    const clientId = generateId("pi-weixin-daemon");
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: chunk ? [{ type: MessageItemType.TEXT, text_item: { text: chunk } }] : [],
        context_token: opts.contextToken ?? undefined,
      },
    };
    try {
      await sendMessage({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
        logger: opts.logger,
      });
    } catch (err) {
      opts.logger?.error(
        {
          err,
          to,
          clientId,
          chunkIndex,
          chunkCount: chunks.length,
          chunkLength: chunk.length,
          succeededChunks,
          remainingChunks: chunks.length - chunkIndex,
        },
        "weixin text chunk delivery failed",
      );
      throw err;
    }
    succeededChunks += 1;
    lastMessageId = clientId;
    opts.logger?.debug(
      { to, clientId, chunkIndex, chunkCount: chunks.length, chunkLength: chunk.length },
      "weixin text chunk sent",
    );
  }
  if (chunks.length > 1) {
    opts.logger?.info({ to, chunkCount: chunks.length, totalLength: text.length }, "weixin text chunks sent");
  }
  return { messageId: lastMessageId };
}
