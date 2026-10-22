import fs from "node:fs";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/util/logger.js";
import type { GetUpdatesFn } from "../../src/weixin/api/api.js";
import { _resetForTest, getRemainingPauseMs } from "../../src/weixin/api/session-guard.js";
import type { GetUpdatesResp, WeixinMessage } from "../../src/weixin/api/types.js";
import { monitorWeixinProvider } from "../../src/weixin/monitor/monitor.js";

const logger = createLogger({ level: "silent" });

const OLD_ENV = process.env.PI_WEIXIN_STATE_DIR;
const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "monitor-state-"));
  process.env.PI_WEIXIN_STATE_DIR = stateDir;
  process.env.PI_WEIXIN_DATA_DIR = stateDir;
});

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.PI_WEIXIN_STATE_DIR;
  else process.env.PI_WEIXIN_STATE_DIR = OLD_ENV;
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.useRealTimers();
  _resetForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: 1,
    from_user_id: "user-1",
    message_type: 1,
    message_state: 2,
    context_token: "tok-1",
    item_list: [{ type: 1, text_item: { text: "hello" } }],
    create_time_ms: Date.now(),
    ...overrides,
  };
}

describe("monitorWeixinProvider", () => {
  it.each([
    {
      name: "mixed business/network failures accumulate and backoff resets the counter",
      responses: [{ ret: 1 }, new Error("network"), { errcode: 1 }, { ret: 1 }],
      times: [0, 2000, 4000, 34000, 36000],
    },
    {
      name: "success resets mixed failure counts",
      responses: [{ ret: 1 }, new Error("network"), { ret: 0 }, { ret: 1 }],
      times: [0, 2000, 4000, 4000, 6000],
    },
    {
      name: "stale ret resets failures and waits an hour",
      responses: [{ ret: 1 }, new Error("network"), { ret: -14 }, { ret: 1 }],
      times: [0, 2000, 4000, 3604000, 3606000],
    },
    {
      name: "stale errcode resets failures and waits an hour",
      responses: [{ ret: 1 }, new Error("network"), { errcode: -14 }, { ret: 1 }],
      times: [0, 2000, 4000, 3604000, 3606000],
    },
  ])("$name", async ({ responses, times }) => {
    vi.useFakeTimers();
    const started = Date.now();
    const calls: number[] = [];
    const control = new AbortController();
    const getUpdatesFn: GetUpdatesFn = vi.fn(async () => {
      calls.push(Date.now() - started);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (response) return response;
      control.abort();
      return { ret: 0 };
    });
    const monitoring = monitorWeixinProvider({
      baseUrl: "https://example.test",
      accountId: "acct-a",
      abortSignal: control.signal,
      getUpdatesFn,
      logger,
      onInbound: vi.fn(async () => {}),
    });
    await vi.runAllTimersAsync();
    await monitoring;
    expect(calls).toEqual(times);
  });

  it.each(["retry", "backoff", "stale"])(
    "aborts during %s waiting without another poll",
    async (waiting) => {
      vi.useFakeTimers();
      const control = new AbortController();
      const getUpdatesFn: GetUpdatesFn = vi.fn(async () => ({
        ret: waiting === "stale" ? -14 : 1,
      }));
      const monitoring = monitorWeixinProvider({
        baseUrl: "https://example.test",
        accountId: "acct-a",
        abortSignal: control.signal,
        getUpdatesFn,
        logger,
        onInbound: vi.fn(async () => {}),
      });
      await vi.advanceTimersByTimeAsync(waiting === "backoff" ? 4000 : 0);
      expect(getUpdatesFn).toHaveBeenCalledTimes(waiting === "backoff" ? 3 : 1);
      if (waiting === "stale") expect(getRemainingPauseMs("acct-a")).toBe(3600000);
      control.abort();
      await monitoring;
      expect(vi.getTimerCount()).toBe(0);
      expect(getUpdatesFn).toHaveBeenCalledTimes(waiting === "backoff" ? 3 : 1);
    },
  );

  it.each(["business", "http", "invalid-json", "network"])(
    "keeps retry/backoff and safe caller logs after %s API failures",
    async (failure) => {
      const control = new AbortController();
      const logs: string[] = [];
      const log = pino({ level: "debug" }, { write: (line: string) => logs.push(line) });
      const marker = "PRIVATE-TEXT BOT-SECRET CONTEXT-SECRET";
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (++calls === 4) {
            control.abort();
            return new Response(JSON.stringify({ ret: 0, msgs: [] }));
          }
          if (failure === "network")
            throw new Error(marker, { cause: { code: `ECONNREFUSED ${marker}` } });
          return new Response(
            failure === "invalid-json"
              ? marker
              : JSON.stringify({ ret: -1, errcode: 1001, errmsg: marker }),
            { status: failure === "http" ? 500 : 200 },
          );
        }),
      );
      await monitorWeixinProvider({
        baseUrl: "https://example.test",
        accountId: "acct-a",
        abortSignal: control.signal,
        retryDelayMs: 1,
        backoffDelayMs: 1,
        logger: log,
        onInbound: vi.fn(async () => {}),
      });
      expect(calls).toBe(4);
      expect(logs.join("")).toContain("3 consecutive failures");
      for (const secret of marker.split(" ")) expect(logs.join("")).not.toContain(secret);
    },
  );

  it("polls, persists get_updates_buf and forwards inbound messages", async () => {
    const control = new AbortController();
    const onInbound = vi.fn(async () => {});
    const responses: GetUpdatesResp[] = [
      { ret: 0, msgs: [makeMessage()], get_updates_buf: "buf-1", longpolling_timeout_ms: 100 },
      {
        ret: 0,
        msgs: [makeMessage({ message_id: 2, context_token: "tok-2" })],
        get_updates_buf: "buf-2",
      },
    ];
    const fakeGetUpdates: GetUpdatesFn = vi.fn(async (params) => {
      const resp = responses.shift();
      if (!resp) {
        control.abort();
        return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
      }
      return resp;
    });

    const promise = monitorWeixinProvider({
      baseUrl: "https://example.com",
      accountId: "acct-a",
      abortSignal: control.signal,
      retryDelayMs: 1,
      backoffDelayMs: 1,
      getUpdatesFn: fakeGetUpdates,
      logger,
      onInbound,
    });
    await promise;

    expect(onInbound).toHaveBeenCalledTimes(2);
    expect(onInbound).toHaveBeenCalledWith(expect.objectContaining({ context_token: "tok-1" }));
    expect(onInbound).toHaveBeenCalledWith(expect.objectContaining({ context_token: "tok-2" }));

    // sync buf persisted (second response buf-2 wins)
    const syncFile = path.join(stateDir, "accounts", "acct-a.sync.json");
    expect(fs.existsSync(syncFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(syncFile, "utf-8"));
    expect(saved.get_updates_buf).toBe("buf-2");

    // longpolling_timeout_ms respected (applied from the second poll onward)
    const secondCall = (fakeGetUpdates as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(secondCall.timeoutMs).toBe(100);
  }, 10_000);

  it("retries on API errors and backs off after MAX_CONSECUTIVE_FAILURES", async () => {
    const control = new AbortController();
    const onInbound = vi.fn(async () => {});
    let calls = 0;
    const fakeGetUpdates: GetUpdatesFn = vi.fn(async (params) => {
      calls += 1;
      if (calls <= 3) {
        return { ret: -1, errcode: 1001, errmsg: "boom", get_updates_buf: params.get_updates_buf };
      }
      control.abort();
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    });

    await monitorWeixinProvider({
      baseUrl: "https://example.com",
      accountId: "acct-a",
      abortSignal: control.signal,
      retryDelayMs: 1,
      backoffDelayMs: 1,
      getUpdatesFn: fakeGetUpdates,
      logger,
      onInbound,
    });

    expect(calls).toBe(4); // 3 failures + 1 success
    expect(onInbound).not.toHaveBeenCalled();
  }, 10_000);

  it("resumes from a persisted get_updates_buf", async () => {
    const stateWeixin = path.join(stateDir, "accounts");
    fs.mkdirSync(stateWeixin, { recursive: true });
    fs.writeFileSync(
      path.join(stateWeixin, "acct-a.sync.json"),
      JSON.stringify({ get_updates_buf: "prev-buf" }),
      "utf-8",
    );

    const control = new AbortController();
    const onInbound = vi.fn(async () => {});
    const fakeGetUpdates: GetUpdatesFn = vi.fn(async (params) => {
      control.abort();
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    });

    await monitorWeixinProvider({
      baseUrl: "https://example.com",
      accountId: "acct-a",
      abortSignal: control.signal,
      retryDelayMs: 1,
      backoffDelayMs: 1,
      getUpdatesFn: fakeGetUpdates,
      logger,
      onInbound,
    });

    const firstCall = (fakeGetUpdates as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(firstCall.get_updates_buf).toBe("prev-buf");
  }, 10_000);

  it("does not block the poll loop while a turn is in-flight (deadlock fix)", async () => {
    const control = new AbortController();
    let releaseFirst!: () => void;
    let inboundCalls = 0;
    let pollCalls = 0;

    // First inbound blocks forever (simulates a turn waiting on a permission/
    // UI response). The loop must still keep polling so it can receive the
    // user's reply to that pending ask; otherwise it deadlocks.
    const onInbound = vi.fn(async () => {
      inboundCalls += 1;
      if (inboundCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    const responses: GetUpdatesResp[] = [
      { ret: 0, msgs: [makeMessage()], get_updates_buf: "buf-1" },
      { ret: 0, msgs: [makeMessage({ message_id: 2 })], get_updates_buf: "buf-2" },
    ];
    const fakeGetUpdates: GetUpdatesFn = vi.fn(async (params) => {
      pollCalls += 1;
      const resp = responses.shift();
      if (!resp) {
        control.abort();
        return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
      }
      return resp;
    });

    const promise = monitorWeixinProvider({
      baseUrl: "https://example.com",
      accountId: "acct-a",
      abortSignal: control.signal,
      retryDelayMs: 1,
      backoffDelayMs: 1,
      getUpdatesFn: fakeGetUpdates,
      logger,
      onInbound,
    });

    // While the first inbound is still awaiting, the loop must have advanced
    // to a second poll AND ingested the second message.
    await vi.waitFor(() => expect(pollCalls).toBeGreaterThanOrEqual(2));
    expect(inboundCalls).toBeGreaterThanOrEqual(2);

    releaseFirst();
    await promise;
    expect(onInbound).toHaveBeenCalledTimes(2);
  }, 10_000);
});
