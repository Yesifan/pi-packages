import { encryptAesEcb } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";
import { createLogger } from "../../util/logger.js";
import { redactUrl } from "../util/redact.js";

const logger = createLogger();

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3;

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 * Retries up to UPLOAD_MAX_RETRIES times on server errors; client errors (4xx) abort immediately.
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  /** From getUploadUrl.upload_full_url; POST target when set (takes precedence over uploadParam). */
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(`${label}: CDN upload URL missing (need upload_full_url or upload_param)`);
  }
  logger.debug(
    `${label}: CDN POST url=${redactUrl(cdnUrl)} ciphertextSize=${ciphertext.length}`,
  );

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        logger.error(
          `${label}: CDN client error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`${label}: CDN client error ${res.status}: ${errMsg}`);
      }
      if (!res.ok) {
        const errMsg = await res.text();
        logger.warn(
          `${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        lastError = new Error(`${label}: CDN server error ${res.status}: ${errMsg}`);
        continue;
      }
      const text = await res.text();
      logger.debug(`${label}: CDN upload response=${text.slice(0, 200)}`);
      const data = JSON.parse(text) as { encrypted_query_param?: string; download_param?: string };
      downloadParam = data.encrypted_query_param ?? data.download_param;
      if (!downloadParam) {
        throw new Error(`${label}: CDN upload response missing download param`);
      }
      return { downloadParam };
    } catch (err) {
      lastError = err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.warn(`${label}: CDN upload attempt ${attempt} failed, retrying: ${String(err)}`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: CDN upload failed`);
}
