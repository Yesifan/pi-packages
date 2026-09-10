/** Unified CDN URL construction for Weixin CDN upload/download. */

/** 服务端未返回 full_url 时回退到客户端拼接 URL。 */
export const ENABLE_CDN_URL_FALLBACK = true;

/** Build a CDN download URL from encrypt_query_param. */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** Build a CDN upload URL from upload_param and filekey. */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}
