import type { Logger } from "../../util/logger.js";
import { classifyFetchError, getUpdates as getUpdatesDefault, type GetUpdatesFn } from "../api/api.js";
import { pauseSession, getRemainingPauseMs, STALE_TOKEN_ERRCODE } from "../api/session-guard.js";
import { loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { redactBody } from "../util/redact.js";
import type { WeixinMessage } from "../api/types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_BACKOFF_DELAY_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  token?: string;
  accountId: string;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  retryDelayMs?: number;
  backoffDelayMs?: number;
  /** Injectable for tests; defaults to the real getUpdates. */
  getUpdatesFn?: GetUpdatesFn;
  logger: Logger;
  /** Called for each raw inbound WeixinMessage (already type-filtered). */
  onInbound: (message: WeixinMessage) => Promise<void>;
};

/**
 * Long-poll loop: getUpdates -> persist get_updates_buf -> onInbound per message.
 * Runs until abort. Retry/backoff:
 *   - API errors: 2s retry; 3 consecutive failures -> 30s backoff
 *   - stale token (errcode -14): pause all requests for 1 hour
 *   - network errors: same 2s/30s policy
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const { baseUrl, token, accountId, abortSignal, longPollTimeoutMs, logger, onInbound } = opts;
  const log = logger.child({ account: accountId });
  const getUpdates = opts.getUpdatesFn ?? getUpdatesDefault;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const backoffDelayMs = opts.backoffDelayMs ?? DEFAULT_BACKOFF_DELAY_MS;

  const previousGetUpdatesBuf = loadGetUpdatesBuf(accountId);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";
  if (previousGetUpdatesBuf) {
    log.info(`resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log.info("no previous sync buf, starting fresh");
  }

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
        logger: log,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        const isStaleToken = resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;
        if (isStaleToken) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          log.error(
            `token is stale, pausing all requests for ${Math.ceil(pauseMs / 60_000)} min`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        log.error(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) body=${redactBody(JSON.stringify(resp))}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
          consecutiveFailures = 0;
          await sleep(backoffDelayMs, abortSignal);
        } else {
          await sleep(retryDelayMs, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(accountId, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const full of list) {
        log.info(
          `inbound message: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );
        // Do NOT await inbound handling here. The long-poll loop must keep
        // polling so the daemon can receive the user's reply to a pending
        // permission/UI ask. Awaited handling of a single in-flight turn would
        // deadlock the receive loop (a turn waiting on a UI response could
        // never see that response arrive). Fire-and-forget keeps the loop
        // unblocked; the bridge serializes concurrent messages via its own
        // IDLE/RUNNING/WAITING_FOR_UI state machine.
        onInbound(full).catch((err: unknown) =>
          log.error({ err }, "inbound handling failed"),
        );
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        log.info("monitor stopped (aborted)");
        return;
      }
      consecutiveFailures += 1;
      const classified = classifyFetchError(err);
      log.error(
        `getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
        consecutiveFailures = 0;
        await sleep(backoffDelayMs, abortSignal);
      } else {
        await sleep(retryDelayMs, abortSignal);
      }
    }
  }
  log.info("monitor ended");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
