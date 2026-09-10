import fs from "node:fs";
import type { HostImage, HostPromptInput } from "../pi/types.js";
import type { InboundAttachment, InboundMessage } from "../weixin/types.js";

/**
 * Build a Hermes-style context note for a non-image attachment (file/video/voice).
 * Tells the agent what the attachment is, where it is, and to read/process it
 * itself rather than punting back to the user.
 */
function contextNote(a: InboundAttachment): string {
  const path = a.localPath;
  const name = a.filename ?? "附件";
  switch (a.kind) {
    case "file":
      return `[用户发送了一个文件: '${name}'。已保存于: ${path}。内容未内联（可能是 PDF/DOCX 等二进制）。若用户的请求涉及该文件内容，请自己用终端或文档工具提取文本后再回答，而不是让用户粘贴内容。]`;
    case "video":
      return `[用户发送了一个视频: '${name}'。已保存于: ${path}。若用户的请求涉及视频内容，请自己用视频分析/媒体工具检查后再回答，而不是让用户描述。]`;
    case "voice":
      return `[用户发送了一条语音消息，已保存于: ${path}。]`;
    default:
      return `[用户发送了一个附件: '${name}'。已保存于: ${path}。]`;
  }
}

/**
 * Build the domain prompt input: message text + context notes for non-image
 * attachments (files/videos/voice; images go as true multimodal input) + any
 * failed media note, and an optional "-- from weixin <name>" sender marker.
 */
export function buildPromptInput(msg: InboundMessage, senderLabel?: string): HostPromptInput {
  const parts: string[] = [msg.text ?? ""];
  for (const a of msg.attachments) {
    if (a.kind === "image") continue; // passed as images
    parts.push(contextNote(a));
  }
  for (const f of msg.mediaFailures ?? []) {
    parts.push(`[附件下载失败，可能无法处理: ${f.filename ?? f.kind}]`);
  }
  if (senderLabel) {
    // Put the sender marker on its own line, preceded by a blank line.
    parts.push("");
    parts.push(`-- from weixin ${senderLabel}`);
  }
  return { text: parts.join("\n"), images: imagesOf(msg) };
}

/** Weixin images -> true multimodal domain images (base64 + detected mime). */
function imagesOf(msg: InboundMessage): HostImage[] | undefined {
  const images = msg.attachments.filter((a) => a.kind === "image");
  if (images.length === 0) return undefined;
  const contents: HostImage[] = [];
  for (const img of images) {
    try {
      const buf = fs.readFileSync(img.localPath);
      contents.push({
        data: buf.toString("base64"),
        mimeType: img.mimeType ?? "image/jpeg",
      });
    } catch {
      // Skip unreadable images; the prompt text still flows.
    }
  }
  return contents.length > 0 ? contents : undefined;
}
