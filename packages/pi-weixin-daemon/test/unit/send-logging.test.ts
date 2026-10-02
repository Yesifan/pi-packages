import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageItemType, MessageState, MessageType } from "../../src/weixin/api/types.js";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../../src/weixin/api/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/weixin/api/api.js")>();
  return { ...actual, sendMessage };
});

import { sendTextMessage } from "../../src/weixin/messaging/send.js";

function logger() {
  const logs: string[] = [];
  const log = pino({ level: "debug" }, { write: (line: string) => logs.push(line) });
  vi.spyOn(log, "debug");
  vi.spyOn(log, "info");
  vi.spyOn(log, "warn");
  vi.spyOn(log, "error");
  return { log, logs };
}

afterEach(() => vi.unstubAllGlobals());

describe("sendTextMessage chunk logging", () => {
  beforeEach(() => sendMessage.mockReset());

  it("logs chunk progress without logging message content", async () => {
    const { log, logs } = logger();
    const text = `PRIVATE-${"x".repeat(4000)}PRIVATE-TAIL`;
    const error = new Error(`network down: ${text.slice(4000)} BOT-SECRET CONTEXT-SECRET`, {
      cause: { code: `ECONNREFUSED ${text.slice(4000)} BOT-SECRET CONTEXT-SECRET` },
    });
    sendMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);

    await expect(
      sendTextMessage({
        to: "user-a",
        text,
        opts: {
          baseUrl: "https://example.test",
          token: "BOT-SECRET",
          contextToken: "CONTEXT-SECRET",
          logger: log,
        },
      }),
    ).rejects.toBe(error);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "tcp",
        chunkIndex: 2,
        chunkCount: 2,
        succeededChunks: 1,
      }),
      "weixin text chunk delivery failed",
    );
    const recorded = logs.join("");
    for (const secret of ["PRIVATE-", "PRIVATE-TAIL", "BOT-SECRET", "CONTEXT-SECRET"]) {
      expect(recorded).not.toContain(secret);
    }
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe("sendMessage API logging", () => {
  it.each(["success", "api-error", "http-error", "fetch-error"])(
    "omits request/response payloads and raw errors on %s without changing sending semantics",
    async (outcome) => {
      const api = await vi.importActual<typeof import("../../src/weixin/api/api.js")>(
        "../../src/weixin/api/api.js",
      );
      const { log, logs } = logger();
      const text = "PRIVATE-NOTICE";
      const echoed = `${text} BOT-SECRET CONTEXT-SECRET`;
      const raw = JSON.stringify({ ret: outcome === "api-error" ? -14 : 0, errmsg: echoed });
      const fetchError = new Error(echoed, { cause: `ECONNREFUSED ${echoed}` });
      const fetch = vi.fn();
      if (outcome === "fetch-error") fetch.mockRejectedValue(fetchError);
      else
        fetch.mockResolvedValue(
          new Response(raw, { status: outcome === "http-error" ? 500 : 200 }),
        );
      vi.stubGlobal("fetch", fetch);
      const request = api.sendMessage({
        baseUrl: "https://example.test",
        token: "BOT-SECRET",
        logger: log,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: "user-a",
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
            context_token: "CONTEXT-SECRET",
          },
        },
      });
      if (outcome === "fetch-error") await expect(request).rejects.toBe(fetchError);
      else if (outcome === "api-error")
        await expect(request).rejects.toThrow(`sendMessage ret=-14 errmsg=${echoed}`);
      else if (outcome === "http-error")
        await expect(request).rejects.toThrow(`sendMessage 500: ${raw}`);
      else await expect(request).resolves.toBeUndefined();

      expect(fetch).toHaveBeenCalledWith(
        "https://example.test/ilink/bot/sendmessage",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer BOT-SECRET" }),
          body: expect.stringContaining(text),
        }),
      );
      const recorded = logs.join("");
      for (const secret of [text, "BOT-SECRET", "CONTEXT-SECRET"]) {
        expect(recorded).not.toContain(secret);
      }
      expect(recorded).toContain("body=omitted");
      if (outcome !== "fetch-error") expect(recorded).toContain("response=omitted");
    },
  );
});
