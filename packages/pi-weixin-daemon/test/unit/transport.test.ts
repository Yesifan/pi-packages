import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WeixinMessage } from "../../src/weixin/api/types.js";

// --- module mocks -----------------------------------------------------------

const { apiMocks, capturedOnInbound } = vi.hoisted(() => {
  return {
    apiMocks: {
      getConfig: vi.fn(),
      sendTyping: vi.fn(),
      sendMessage: vi.fn(),
      notifyStart: vi.fn(),
      notifyStop: vi.fn(),
    },
    capturedOnInbound: { current: undefined as ((m: WeixinMessage) => Promise<void>) | undefined },
  };
});

vi.mock("../../src/weixin/api/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/weixin/api/api.js")>();
  return {
    ...actual,
    getConfig: apiMocks.getConfig,
    sendTyping: apiMocks.sendTyping,
    sendMessage: apiMocks.sendMessage,
    notifyStart: apiMocks.notifyStart,
    notifyStop: apiMocks.notifyStop,
  };
});

vi.mock("../../src/weixin/monitor/monitor.js", () => ({
  monitorWeixinProvider: vi.fn(async (opts: { onInbound: (m: WeixinMessage) => Promise<void> }) => {
    capturedOnInbound.current = opts.onInbound;
  }),
}));

// --- tests ------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { ILinkWeixinTransport } from "../../src/weixin/transport.js";
import { createLogger } from "../../src/util/logger.js";
import { TypingStatus } from "../../src/weixin/api/types.js";

const logger = createLogger({ level: "silent" });

const OLD_ENV = process.env.PI_WEIXIN_STATE_DIR;
const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "transport-state-"));
  process.env.PI_WEIXIN_STATE_DIR = stateDir;
  process.env.PI_WEIXIN_DATA_DIR = stateDir;
  apiMocks.getConfig.mockResolvedValue({ ret: 0, typing_ticket: "ticket-abc" });
  apiMocks.sendTyping.mockResolvedValue(undefined);
  apiMocks.sendMessage.mockResolvedValue(undefined);
  apiMocks.notifyStart.mockResolvedValue({ ret: 0 });
  apiMocks.notifyStop.mockResolvedValue({ ret: 0 });
  capturedOnInbound.current = undefined;
});

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.PI_WEIXIN_STATE_DIR;
  else process.env.PI_WEIXIN_STATE_DIR = OLD_ENV;
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeRawMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: 7,
    from_user_id: "user-1",
    message_type: 1,
    message_state: 2,
    context_token: "tok-msg-7",
    item_list: [{ type: 1, text_item: { text: "hi" } }],
    create_time_ms: Date.now(),
    ...overrides,
  };
}

describe("ILinkWeixinTransport (mocked api)", () => {
  it("start() notifies start; stop() aborts monitor and notifies stop", async () => {
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      logger,
    });
    await t.start();
    expect(apiMocks.notifyStart).toHaveBeenCalledTimes(1);

    await t.stop();
    expect(apiMocks.notifyStop).toHaveBeenCalledTimes(1);
  });

  it("sendText passes context_token and the sender as recipient", async () => {
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      logger,
    });
    await t.sendText(
      { accountId: "acct-a", senderId: "user-1", messageId: "m", contextToken: "tok-ctx" },
      "hello world",
    );
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    const body = apiMocks.sendMessage.mock.calls[0]?.[0];
    expect(body.body.msg.to_user_id).toBe("user-1");
    expect(body.body.msg.context_token).toBe("tok-ctx");
    expect(body.body.msg.item_list[0].text_item.text).toBe("hello world");
  });

  it("setTyping fetches the typing ticket and sends status", async () => {
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      logger,
    });
    const ctx = { accountId: "acct-a", senderId: "user-1", messageId: "m" };
    await t.setTyping(ctx, true);
    expect(apiMocks.getConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ilinkUserId: "user-1" }),
    );
    expect(apiMocks.sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { ilink_user_id: "user-1", typing_ticket: "ticket-abc", status: TypingStatus.TYPING },
      }),
    );

    await t.setTyping(ctx, false);
    const last = apiMocks.sendTyping.mock.calls.at(-1)?.[0];
    expect(last.body.status).toBe(TypingStatus.CANCEL);
  });

  it("drops BOT messages before project gate and handler dispatch", async () => {
    const resolveInboxDir = vi.fn(() => ({ dir: "/unused" }));
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      resolveInboxDir,
      logger,
    });
    await t.start();

    const handler = vi.fn(async () => undefined);
    t.onMessage(handler);
    await capturedOnInbound.current!(makeRawMessage({ message_type: 2 }));

    expect(resolveInboxDir).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();
    await t.stop();
  });

  it("keeps accepting legacy messages with no message_type", async () => {
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      logger,
    });
    await t.start();

    const handler = vi.fn(async () => undefined);
    t.onMessage(handler);
    await capturedOnInbound.current!(makeRawMessage({ message_type: undefined }));

    expect(handler).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  it("forwards normalized inbound messages to handlers and stores context tokens", async () => {
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      logger,
    });
    await t.start();

    const seen: string[] = [];
    t.onMessage(async (msg) => {
      seen.push(`${msg.senderId}:${msg.text}`);
    });

    await capturedOnInbound.current!(makeRawMessage());

    expect(seen).toEqual(["user-1:hi"]);
    // context token persisted to disk for restart
    const file = path.join(stateDir, "accounts", "acct-a.context-tokens.json");
    expect(fs.existsSync(file)).toBe(true);

    await t.stop();
  });

  it("replies to the sender when the account is unbound (gate)", async () => {
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      resolveInboxDir: () => ({ dir: undefined, reason: "unbound" }),
      logger,
    });
    await t.start();

    await capturedOnInbound.current!(makeRawMessage());

    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    const body = apiMocks.sendMessage.mock.calls[0]?.[0];
    expect(body.body.msg.to_user_id).toBe("user-1");
    expect(String(body.body.msg.item_list[0].text_item.text)).toContain("尚未绑定任何项目");

    await t.stop();
  });

  it("replies with a disabled message when the bound project is disabled (gate)", async () => {
    const t = new ILinkWeixinTransport({
      accountId: "acct-a",
      token: "tok",
      baseUrl: "https://example.com",
      resolveInboxDir: () => ({ dir: undefined, reason: "disabled" }),
      logger,
    });
    await t.start();

    await capturedOnInbound.current!(makeRawMessage());

    const body = apiMocks.sendMessage.mock.calls[0]?.[0];
    expect(String(body.body.msg.item_list[0].text_item.text)).toContain("项目已停用");

    await t.stop();
  });
});
