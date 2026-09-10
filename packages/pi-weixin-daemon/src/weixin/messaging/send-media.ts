import path from "node:path";

import { CDN_BASE_URL } from "../auth/accounts.js";
import { uploadFileAttachmentToWeixin, uploadFileToWeixin, uploadVideoToWeixin } from "../cdn/upload.js";
import { getMimeFromFilename } from "../media/mime.js";
import { createLogger } from "../../util/logger.js";
import { sendMessage } from "../api/api.js";
import type { SendMessageReq, MessageItem } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import { generateId } from "../util/random.js";
import type { WeixinMessageSendOptions } from "./send.js";
import type { UploadedFileInfo } from "../cdn/upload.js";

const logger = createLogger();

/** Send a single MessageItem (with optional preceding text caption) downstream. */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinMessageSendOptions;
  label: string;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label } = params;
  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateId("pi-weixin-daemon");
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
      },
    };
    await sendMessage({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
      logger: opts.logger,
    });
  }
  return { messageId: lastClientId };
}

/** Send an image message using a previously uploaded file. */
export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessageWeixin" });
}

/** Send a video message using a previously uploaded file. */
export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };
  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessageWeixin" });
}

/** Send a file attachment (non-image/video) using a previously uploaded file. */
export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, fileName, uploaded, opts } = params;
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessageWeixin" });
}

/**
 * Upload a local file and send it as a weixin message, routing by MIME type:
 *   video/* → uploadVideoToWeixin + sendVideoMessageWeixin
 *   image/* → uploadFileToWeixin  + sendImageMessageWeixin
 *   else    → uploadFileAttachmentToWeixin + sendFileMessageWeixin
 */
export async function sendWeixinMediaFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinMessageSendOptions;
  cdnBaseUrl?: string;
}): Promise<{ messageId: string }> {
  const { filePath, to, text, opts } = params;
  const cdnBaseUrl = params.cdnBaseUrl ?? CDN_BASE_URL;
  const mime = getMimeFromFilename(filePath);
  const uploadOpts = { baseUrl: opts.baseUrl, token: opts.token, logger: opts.logger };

  if (mime.startsWith("video/")) {
    logger.info(`sending video filePath=${filePath} to=${to}`);
    const uploaded = await uploadVideoToWeixin({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
    return sendVideoMessageWeixin({ to, text, uploaded, opts });
  }
  if (mime.startsWith("image/")) {
    logger.info(`sending image filePath=${filePath} to=${to}`);
    const uploaded = await uploadFileToWeixin({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
    return sendImageMessageWeixin({ to, text, uploaded, opts });
  }

  const fileName = path.basename(filePath);
  logger.info(`sending file attachment filePath=${filePath} name=${fileName} to=${to}`);
  const uploaded = await uploadFileAttachmentToWeixin({ filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl });
  return sendFileMessageWeixin({ to, text, fileName, uploaded, opts });
}
