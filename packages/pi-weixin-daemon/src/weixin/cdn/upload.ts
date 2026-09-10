import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getUploadUrl, type WeixinApiOptions } from "../api/api.js";
import { UploadMediaType } from "../api/types.js";
import { redactUrl } from "../util/redact.js";
import { tempFileName } from "../util/random.js";
import { getExtensionFromContentTypeOrUrl } from "../media/mime.js";
import { aesEcbPaddedSize } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";
import { createLogger } from "../../util/logger.js";

const logger = createLogger();

export type UploadedFileInfo = {
  filekey: string;
  /** 由 upload_param 上传后 CDN 返回的下载加密参数; fill into media.encrypt_query_param */
  downloadEncryptedQueryParam: string;
  /** AES-128-ECB key, hex-encoded; convert to base64 for CDNMedia.aes_key */
  aeskey: string;
  /** Plaintext file size in bytes */
  fileSize: number;
  /** Ciphertext file size in bytes (AES-128-ECB with PKCS7 padding) */
  fileSizeCiphertext: number;
};

/** Common upload pipeline: read file → hash → gen aeskey → getUploadUrl → uploadBufferToCdn. */
async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  label: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  logger.debug(
    `${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5} filekey=${filekey}`,
  );

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    logger.error(
      `${label}: getUploadUrl returned no upload URL, resp=${JSON.stringify(uploadUrlResp)}`,
    );
    throw new Error(`${label}: getUploadUrl returned no upload URL`);
  }

  const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    cdnBaseUrl,
    aeskey,
    label: `${label}[orig filekey=${filekey}]`,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/** Upload a local image file to the Weixin CDN with AES-128-ECB encryption. */
export async function uploadFileToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.IMAGE,
    label: "uploadFileToWeixin",
  });
}

/** Upload a local video file to the Weixin CDN. */
export async function uploadVideoToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.VIDEO,
    label: "uploadVideoToWeixin",
  });
}

/**
 * Upload a local file attachment (non-image, non-video) to the Weixin CDN.
 * Uses media_type=FILE; no thumbnail required.
 */
export async function uploadFileAttachmentToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.FILE,
    label: "uploadFileAttachmentToWeixin",
  });
}

/**
 * Download a remote media URL to a local temp file in destDir.
 * Returns the local file path; extension inferred from Content-Type / URL.
 */
export async function downloadRemoteImageToTemp(url: string, destDir: string): Promise<string> {
  logger.debug(`downloadRemoteImageToTemp: fetching url=${redactUrl(url)}`);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    logger.error(`downloadRemoteImageToTemp: fetch network error url=${redactUrl(url)} error=${String(err)}`);
    throw err;
  }
  if (!res.ok) {
    const msg = `remote media download failed: ${res.status} ${res.statusText} url=${redactUrl(url)}`;
    logger.error(`downloadRemoteImageToTemp: ${msg}`);
    throw new Error(msg);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });
  const ext = getExtensionFromContentTypeOrUrl(res.headers.get("content-type"), url);
  const name = tempFileName("weixin-remote", ext);
  const filePath = path.join(destDir, name);
  await fs.writeFile(filePath, buf);
  logger.debug(`downloadRemoteImageToTemp: saved to ${filePath} ext=${ext}`);
  return filePath;
}
