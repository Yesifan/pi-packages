import fs from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../util/logger.js";
import { sanitizeDirName, sanitizeFilename } from "../../util/sanitize.js";
import type { InboundAttachment, InboundAttachmentKind, MediaFailure } from "../types.js";
import type { MessageItem, WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { CDN_BASE_URL } from "../auth/accounts.js";
import {
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
} from "../cdn/pic-decrypt.js";
import { getMimeFromFilename } from "./mime.js";

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Best-effort image format detection from magic bytes.
 * Returns a mime type, or undefined when unknown.
 */
export function detectImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && (buf.subarray(0, 4).toString("ascii") === "GIF8")) {
    return "image/gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return "image/bmp";
  }
  return undefined;
}

/** Write a buffer under <inboxDir>/<messageKey>/<filename>, returning the local path. */
async function saveInboundMedia(params: {
  inboxDir: string;
  messageKey: string;
  filename: string;
  buf: Buffer;
  logger: Logger;
}): Promise<string> {
  const { inboxDir, messageKey, filename, buf, logger } = params;
  const dir = path.join(inboxDir, sanitizeDirName(messageKey));
  await fs.mkdir(dir, { recursive: true });
  const safeName = sanitizeFilename(filename) || "media.bin";
  const filePath = path.join(dir, safeName);
  await fs.writeFile(filePath, buf);
  logger.info(`saved inbound media: ${filePath} (${buf.length} bytes)`);
  return filePath;
}

function attachment(kind: InboundAttachmentKind, localPath: string, filename?: string, mimeType?: string): InboundAttachment {
  return { kind, localPath, filename, mimeType };
}

/** A single media item's outcome: either a usable attachment, or a recorded failure. */
interface MediaDownloadResult {
  attachment?: InboundAttachment;
  failure?: MediaFailure;
}

/**
 * Download and decrypt media from a single MessageItem into the inbox.
 * Returns a result carrying either a usable attachment or a recorded failure.
 * Unsupported types return `{}` (neither) — they never block message processing.
 */
export async function downloadMediaFromItem(
  item: MessageItem,
  deps: { inboxDir: string; messageKey: string; cdnBaseUrl?: string; logger: Logger },
): Promise<MediaDownloadResult> {
  const { inboxDir, messageKey, logger } = deps;
  const cdnBaseUrl = deps.cdnBaseUrl ?? CDN_BASE_URL;
  const label = "inbound";

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return {};
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media.aes_key;
    try {
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(
            img.media.encrypt_query_param ?? "",
            aesKeyBase64,
            cdnBaseUrl,
            `${label} image`,
            img.media.full_url,
          )
        : await downloadPlainCdnBuffer(
            img.media.encrypt_query_param ?? "",
            cdnBaseUrl,
            `${label} image-plain`,
            img.media.full_url,
          );
      const mime = detectImageMime(buf) ?? "image/jpeg";
      const ext = mime === "image/jpeg" ? ".jpg" : mime.replace("image/", ".");
      const filePath = await saveInboundMedia({
        inboxDir,
        messageKey,
        filename: `image${ext}`,
        buf,
        logger,
      });
      return { attachment: attachment("image", filePath, `image${ext}`, mime) };
    } catch (err) {
      logger.error(`${label} image download/decrypt failed: ${String(err)}`);
      return { failure: { kind: "image", filename: "image" } };
    }
  }

  if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) || !fileItem?.media?.aes_key) {
      return {};
    }
    const filename = fileItem.file_name ?? "file.bin";
    try {
      const buf = await downloadAndDecryptBuffer(
        fileItem.media.encrypt_query_param ?? "",
        fileItem.media.aes_key,
        cdnBaseUrl,
        `${label} file`,
        fileItem.media.full_url,
      );
      const mime = getMimeFromFilename(filename);
      const filePath = await saveInboundMedia({ inboxDir, messageKey, filename, buf, logger });
      return { attachment: attachment("file", filePath, filename, mime) };
    } catch (err) {
      logger.error(`${label} file download failed: ${String(err)}`);
      return { failure: { kind: "file", filename } };
    }
  }

  if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if ((!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url) || !videoItem?.media?.aes_key) {
      return {};
    }
    try {
      const buf = await downloadAndDecryptBuffer(
        videoItem.media.encrypt_query_param ?? "",
        videoItem.media.aes_key,
        cdnBaseUrl,
        `${label} video`,
        videoItem.media.full_url,
      );
      const filePath = await saveInboundMedia({
        inboxDir,
        messageKey,
        filename: "video.mp4",
        buf,
        logger,
      });
      return { attachment: attachment("video", filePath, "video.mp4", "video/mp4") };
    } catch (err) {
      logger.error(`${label} video download failed: ${String(err)}`);
      return { failure: { kind: "video", filename: "video.mp4" } };
    }
  }

  if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key) {
      return {};
    }
    try {
      const buf = await downloadAndDecryptBuffer(
        voice.media.encrypt_query_param ?? "",
        voice.media.aes_key,
        cdnBaseUrl,
        `${label} voice`,
        voice.media.full_url,
      );
      // v0.1: voice is delivered as a downloadable file (no silk transcode).
      const filePath = await saveInboundMedia({
        inboxDir,
        messageKey,
        filename: "voice.silk",
        buf,
        logger,
      });
      return { attachment: attachment("voice", filePath, "voice.silk", "audio/silk") };
    } catch (err) {
      logger.error(`${label} voice download failed: ${String(err)}`);
      return { failure: { kind: "voice", filename: "voice.silk" } };
    }
  }

  return {};
}

/** Download all media items of a raw message into the inbox. */
export async function downloadAttachmentsFromMessage(
  raw: WeixinMessage,
  deps: { inboxDir?: string; cdnBaseUrl?: string; logger: Logger },
): Promise<{ attachments: InboundAttachment[]; failures: MediaFailure[] }> {
  // No inbox => no place to persist inbound media; drop attachments (text still flows).
  if (!deps.inboxDir) return { attachments: [], failures: [] };
  const messageKey = String(raw.message_id ?? raw.client_id ?? Date.now());
  const attachments: InboundAttachment[] = [];
  const failures: MediaFailure[] = [];
  for (const item of raw.item_list ?? []) {
    const result = await downloadMediaFromItem(item, { ...deps, messageKey, inboxDir: deps.inboxDir });
    if (result.attachment) attachments.push(result.attachment);
    else if (result.failure) failures.push(result.failure);
  }
  return { attachments, failures };
}
