import { inspect } from "node:util";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiGetFetch,
  getConfig,
  getUpdates,
  getUploadUrl,
  sendMessage,
  sendTyping,
} from "../../src/weixin/api/api.js";

const markers = "PRIVATE-TEXT BOT-SECRET CONTEXT-SECRET";
const baseUrl = "https://example.test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function capture() {
  const logs: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => logs.push(line) });
  return { logs, logger };
}

const endpoints = [
  "getconfig",
  "sendtyping",
  "getuploadurl",
  "sendmessage",
  "getupdates",
  "get",
] as const;

function request(
  endpoint: (typeof endpoints)[number],
  logger: ReturnType<typeof capture>["logger"],
) {
  const opts = { baseUrl, logger, token: "BOT-SECRET" };
  switch (endpoint) {
    case "getconfig":
      return getConfig({ ...opts, ilinkUserId: "user", contextToken: "CONTEXT-SECRET" });
    case "sendtyping":
      return sendTyping({
        ...opts,
        body: { ilink_user_id: "user", typing_ticket: "ticket", status: 1 },
      });
    case "getuploadurl":
      return getUploadUrl({
        ...opts,
        filekey: "file",
        media_type: 3,
        to_user_id: "user",
        rawsize: 1,
        rawfilemd5: "md5",
        filesize: 16,
      });
    case "sendmessage":
      return sendMessage({
        ...opts,
        body: {
          msg: {
            context_token: "CONTEXT-SECRET",
            item_list: [{ type: 1, text_item: { text: "PRIVATE-TEXT" } }],
          },
        },
      });
    case "getupdates":
      return getUpdates({ ...opts, get_updates_buf: "" });
    case "get":
      return apiGetFetch({ ...opts, endpoint: "ilink/bot/test", label: "test" });
  }
}

describe("API failure diagnostics", () => {
  for (const endpoint of endpoints) {
    it.each(["http", "network", "invalid-json", "business"] as const)(
      `${endpoint}: does not leak payloads on %s`,
      async (failure) => {
        const { logger, logs } = capture();
        const fetch = vi.fn();
        if (failure === "network")
          fetch.mockRejectedValue(
            new Error(markers, { cause: { code: `ECONNREFUSED ${markers}` } }),
          );
        else
          fetch.mockResolvedValue(
            new Response(
              failure === "invalid-json"
                ? markers
                : JSON.stringify({ ret: -14, errcode: -14, errmsg: markers, echoed: markers }),
              { status: failure === "http" ? 503 : 200 },
            ),
          );
        vi.stubGlobal("fetch", fetch);
        let error: unknown;
        let result: unknown;
        try {
          result = await request(endpoint, logger);
        } catch (err) {
          error = err;
          logger.error({ err }, "caller failure");
        }
        if (
          failure === "http" ||
          failure === "network" ||
          (failure === "invalid-json" && endpoint !== "sendtyping" && endpoint !== "get") ||
          (failure === "business" && endpoint === "sendmessage")
        )
          expect(error).toBeInstanceOf(Error);
        // Business handling remains with each caller; only sendMessage previously threw.
        if (failure === "business" && endpoint !== "sendmessage") {
          expect(error).toBeUndefined();
          if (endpoint !== "sendtyping" && endpoint !== "get") {
            expect(result).toMatchObject({ ret: -14, errcode: -14 });
          }
        }
        for (const marker of markers.split(" ")) {
          expect(logs.join("")).not.toContain(marker);
          expect(inspect(error)).not.toContain(marker);
        }
        if (error instanceof Error) expect(error.cause).toBeUndefined();
        const entries = logs.map((line) => JSON.parse(line));
        expect(entries).toContainEqual(
          expect.objectContaining({
            method: endpoint === "get" ? "GET" : "POST",
            endpoint: expect.stringContaining("/ilink/bot/"),
            type: failure === "network" ? "tcp" : failure,
            ...(failure === "http" ? { status: 503 } : {}),
          }),
        );
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );
  }

  it.each(["timeout", "external"] as const)(
    "preserves real %s signal handling for long polling",
    async (kind) => {
      vi.useFakeTimers();
      const { logger, logs } = capture();
      const external = new AbortController();
      const fetch = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException(markers, "AbortError")),
              { once: true },
            );
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const pending = getUpdates({
        baseUrl,
        logger,
        timeoutMs: 10,
        abortSignal: external.signal,
        get_updates_buf: "cursor",
      });
      if (kind === "external") external.abort();
      else await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toEqual({ ret: 0, msgs: [], get_updates_buf: "cursor" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logs.join("")).not.toContain(markers);
      expect(logs.join("")).toContain('"type":"timeout"');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves AbortError and long-poll empty-response control flow", async () => {
    const { logger, logs } = capture();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException(markers, "AbortError")));
    await expect(getConfig({ baseUrl, logger, ilinkUserId: "user" })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(getUpdates({ baseUrl, logger, get_updates_buf: "cursor" })).resolves.toEqual({
      ret: 0,
      msgs: [],
      get_updates_buf: "cursor",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      getUpdates({ baseUrl, logger, abortSignal: controller.signal, get_updates_buf: "cursor" }),
    ).resolves.toMatchObject({ ret: 0, msgs: [] });
    expect(logs.join("")).not.toContain(markers);
    expect(logs.join("")).toContain('"type":"timeout"');
  });
});
