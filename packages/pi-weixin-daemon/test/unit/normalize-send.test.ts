import { describe, it, expect } from "vitest";
import { normalizeInboundMessage, extractText } from "../../src/weixin/normalize.js";
import { splitTextChunks } from "../../src/weixin/messaging/send.js";
import type { WeixinMessage } from "../../src/weixin/api/types.js";

describe("normalizeInboundMessage", () => {
  const raw: WeixinMessage = {
    message_id: 42,
    from_user_id: "user-a",
    message_type: 1,
    context_token: "tok-xyz",
    item_list: [
      { type: 1, text_item: { text: "first" } },
      { type: 1, text_item: { text: "second" } },
    ],
    create_time_ms: 1700000000000,
  };

  it("maps fields and concatenates text items", () => {
    const msg = normalizeInboundMessage("acct-1", raw);
    expect(msg.accountId).toBe("acct-1");
    expect(msg.senderId).toBe("user-a");
    expect(msg.messageId).toBe("42");
    expect(msg.contextToken).toBe("tok-xyz");
    expect(msg.text).toBe("first\nsecond");
    expect(msg.createdAt).toBe(1700000000000);
  });

  it("keeps attachments for user messages, drops for bot messages", () => {
    const withAttachments = [{ kind: "file", localPath: "/x" }] as const;
    expect(normalizeInboundMessage("a", raw, [...withAttachments]).attachments.length).toBe(1);

    const botMsg = normalizeInboundMessage("a", { ...raw, message_type: 2 }, [...withAttachments]);
    expect(botMsg.attachments).toEqual([]);
  });

  it("falls back to client_id for messageId when message_id missing", () => {
    const msg = normalizeInboundMessage("a", { ...raw, message_id: undefined, client_id: "cid-9" });
    expect(msg.messageId).toBe("cid-9");
  });

  it("returns undefined text when no text items", () => {
    const msg = normalizeInboundMessage("a", { ...raw, item_list: [{ type: 2 }] });
    expect(msg.text).toBeUndefined();
  });
});

describe("extractText", () => {
  it("ignores non-text items", () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: 2, image_item: {} },
        { type: 1, text_item: { text: "only" } },
      ],
    };
    expect(extractText(msg)).toBe("only");
  });

  it("extracts voice STT text and treats it as message text", () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: 3, voice_item: { text: "转写内容" } },
        { type: 1, text_item: { text: "文字" } },
      ],
    };
    expect(extractText(msg)).toBe("转写内容\n文字");
  });
});

describe("splitTextChunks", () => {
  it("returns single chunk for short text", () => {
    expect(splitTextChunks("short")).toEqual(["short"]);
  });

  it("splits long text at newline boundaries", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i} `.repeat(30)).join("\n");
    const chunks = splitTextChunks(long, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
    }
    expect(chunks.join("\n")).toBe(long);
  });

  it("splits without newlines by hard cut", () => {
    const long = "x".repeat(2500);
    const chunks = splitTextChunks(long, 1000);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
  });
});
