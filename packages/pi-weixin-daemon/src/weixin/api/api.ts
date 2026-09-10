import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger, type Logger } from "../../util/logger.js";
import { redactBody, redactUrl } from "../util/redact.js";
import type {
  BaseInfo,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetUpdatesReq,
  GetUpdatesResp,
  NotifyStopResp,
  NotifyStartResp,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Long-poll timeout for getUpdates (server may hold the request up to this). */
  longPollTimeoutMs?: number;
  logger?: Logger;
};

export type GetUpdatesFn = typeof getUpdates;

const defaultLogger = createLogger();

// ---------------------------------------------------------------------------
// Identity: iLink-App-Id / iLink-App-ClientVersion / bot_agent
// ---------------------------------------------------------------------------

/** iLink-App-Id: 直接读取 package.json 顶层 ilink_appid 字段。 */
const ILINK_APP_ID: string = "bot";

interface PackageJson {
  name?: string;
  version?: string;
}

/** Read our own package.json (dev: src/, publish: dist/ — walk up to find it). */
function readOwnPackageJson(): PackageJson {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const { root } = path.parse(dir);
  while (dir && dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as PackageJson;
        if (parsed.name === "pi-weixin-daemon") return parsed;
      } catch {
        // keep walking up
      }
    }
    dir = path.dirname(dir);
  }
  return {};
}

const pkg = readOwnPackageJson();

const CHANNEL_VERSION: string = pkg.version ?? "0.1.0";

/** Default `bot_agent` value (UA-style, like Tencent's OpenClaw default). */
const DEFAULT_BOT_AGENT = `pi-weixin-daemon/${pkg.version ?? "0.1.0"}`;

/** Maximum length (bytes) of the sanitized `bot_agent` string. */
const BOT_AGENT_MAX_LEN = 256;

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP
 * High 8 bits fixed to 0; remaining bits: major<<16 | minor<<8 | patch.
 * e.g. "1.0.11" -> 0x0001000B = 65547
 */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION: number = buildClientVersion(pkg.version ?? "0.0.0");

/**
 * Sanitize a `bot_agent` string into a wire-safe value.
 *
 * Grammar (UA-style):
 *   bot_agent = product *( SP product )
 *   product   = name "/" version [ SP "(" comment ")" ]
 *   name      = 1*32( ALPHA / DIGIT / "_" / "." / "-" )
 *   version   = 1*32( ALPHA / DIGIT / "_" / "." / "+" / "-" )
 *   comment   = 1*64( printable ASCII minus "(" ")" )
 *
 * Tokens that fail to parse are dropped silently. Returns `DEFAULT_BOT_AGENT`
 * when the input is empty / all tokens dropped / exceeds the length cap.
 */
export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;

  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;

  const rawTokens = trimmed.split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i]!;
    if (tok.startsWith("(") && !tok.endsWith(")")) {
      let acc = tok;
      while (i + 1 < rawTokens.length && !acc.endsWith(")")) {
        i += 1;
        acc += " " + rawTokens[i]!;
      }
      tokens.push(acc);
    } else {
      tokens.push(tok);
    }
  }

  const accepted: string[] = [];
  let pendingProduct: string | null = null;
  for (const tok of tokens) {
    if (tok.startsWith("(") && tok.endsWith(")")) {
      const inner = tok.slice(1, -1);
      if (pendingProduct && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`);
        pendingProduct = null;
      } else {
        if (pendingProduct) {
          accepted.push(pendingProduct);
          pendingProduct = null;
        }
      }
      continue;
    }
    if (pendingProduct) {
      accepted.push(pendingProduct);
      pendingProduct = null;
    }
    if (productRe.test(tok)) {
      pendingProduct = tok;
    }
  }
  if (pendingProduct) accepted.push(pendingProduct);

  if (accepted.length === 0) return DEFAULT_BOT_AGENT;

  const joined = accepted.join(" ");
  if (Buffer.byteLength(joined, "utf-8") <= BOT_AGENT_MAX_LEN) return joined;

  const truncated: string[] = [];
  let len = 0;
  for (const t of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(t, "utf-8");
    if (len + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(t);
    len += add;
  }
  return truncated.length > 0 ? truncated.join(" ") : DEFAULT_BOT_AGENT;
}

/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo(): BaseInfo {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(DEFAULT_BOT_AGENT),
  };
}

/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** Build headers shared by both GET and POST requests. */
function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildHeaders(opts: { token?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

/**
 * Classify a fetch-level error into a category for logging / diagnostics.
 * This does NOT cover HTTP-level errors (4xx/5xx) — those are thrown separately.
 */
export function classifyFetchError(err: unknown): {
  type: "dns" | "tcp" | "tls" | "timeout" | "unknown";
  description: string;
  code?: string;
} {
  if (err instanceof Error && err.name === "AbortError") {
    return { type: "timeout", description: "request timeout" };
  }

  const cause = (err as NodeJS.ErrnoException)?.cause;
  const causeCode = (cause as { code?: string })?.code ?? "";
  const causeStr = String(cause ?? err ?? "") + " " + String(causeCode);
  const matchedCode = causeCode || (typeof cause === "string" ? cause : "");

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(causeStr)) {
    return {
      type: "dns",
      description: "DNS resolution failed, check DNS configuration",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/ECONNREFUSED/i.test(causeStr)) {
    return {
      type: "tcp",
      description: "TCP connection refused",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(causeStr)) {
    return {
      type: "tcp",
      description: "TCP connection timeout or unreachable",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(causeStr)) {
    return {
      type: "tls",
      description: "TLS handshake error",
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }

  return { type: "unknown", description: "network request failed" };
}

/**
 * GET fetch wrapper. When `timeoutMs` is set, the request is aborted after
 * that many milliseconds. Returns the raw response text on success.
 */
export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
  logger?: Logger;
}): Promise<string> {
  const log = params.logger ?? defaultLogger;
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildCommonHeaders();
  log.debug(`GET ${redactUrl(url.toString())}`);

  const timeoutMs = params.timeoutMs;
  const controller = timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
  const t =
    controller != null && timeoutMs != null ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: hdrs,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    log.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    const classified = classifyFetchError(err);
    log.error(
      `${params.label}: GET fetch failed url=${redactUrl(url.toString())} timeoutMs=${timeoutMs ?? "none"} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""} error=${String(err)}`,
    );
    throw err;
  }
}

/** Combine an internal timeout controller with an optional external abort signal. */
function combineAbortSignals(params: {
  internal?: AbortController;
  external?: AbortSignal;
}): { signal?: AbortSignal; cleanup: () => void } {
  const { internal, external } = params;
  if (!external) {
    return { signal: internal?.signal, cleanup: () => {} };
  }
  if (!internal) {
    return { signal: external, cleanup: () => {} };
  }
  if (external.aborted) {
    internal.abort();
    return { signal: internal.signal, cleanup: () => {} };
  }
  const onExternalAbort = () => internal.abort();
  external.addEventListener("abort", onExternalAbort, { once: true });
  return {
    signal: internal.signal,
    cleanup: () => external.removeEventListener("abort", onExternalAbort),
  };
}

/**
 * Common fetch wrapper: POST JSON to a Weixin API endpoint.
 * Returns the raw response text on success; throws on HTTP error or timeout.
 */
export async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  label: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
}): Promise<string> {
  const log = params.logger ?? defaultLogger;
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token });
  log.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);

  const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;
  const t =
    controller != null && params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  const { signal, cleanup } = combineAbortSignals({
    internal: controller,
    external: params.abortSignal,
  });
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      ...(signal ? { signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    log.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    const classified = classifyFetchError(err);
    log.error(
      `${params.label}: POST fetch failed url=${redactUrl(url.toString())} timeoutMs=${params.timeoutMs ?? "none"} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""} error=${String(err)}`,
    );
    throw err;
  } finally {
    cleanup();
  }
}

/**
 * Long-poll getUpdates. Server should hold the request until new messages or timeout.
 * On client-side timeout, returns an empty response with ret=0 so the caller can
 * simply retry. This is normal for long-poll.
 */
export async function getUpdates(
  params: GetUpdatesReq & {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    logger?: Logger;
  },
): Promise<GetUpdatesResp> {
  const log = params.logger ?? defaultLogger;
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      abortSignal: params.abortSignal,
      logger: log,
    });
    const resp: GetUpdatesResp = JSON.parse(rawText);
    return resp;
  } catch (err) {
    // Long-poll timeout or external abort are both normal control-flow exits.
    if (err instanceof Error && err.name === "AbortError") {
      if (params.abortSignal?.aborted) {
        log.debug("getUpdates: aborted by external signal");
      } else {
        log.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
      }
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
    logger: params.logger,
  });
  const resp: GetUploadUrlResp = JSON.parse(rawText);
  return resp;
}

/** Send a single message downstream. */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
    logger: params.logger,
  });
  const resp: SendMessageResp = JSON.parse(rawText);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
}

/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
    logger: params.logger,
  });
  const resp: GetConfigResp = JSON.parse(rawText);
  return resp;
}

/** Send a typing indicator to a user. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
    logger: params.logger,
  });
}

/** Notify Weixin that this bot client is stopping (daemon shutdown). */
export async function notifyStop(params: WeixinApiOptions): Promise<NotifyStopResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStop",
    logger: params.logger,
  });
  return JSON.parse(rawText) as NotifyStopResp;
}

/** Notify Weixin that this bot client is starting (daemon startup). */
export async function notifyStart(params: WeixinApiOptions): Promise<NotifyStartResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "notifyStart",
    logger: params.logger,
  });
  return JSON.parse(rawText) as NotifyStartResp;
}
