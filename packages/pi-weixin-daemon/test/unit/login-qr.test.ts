import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiGetFetch, apiPostFetch } from "../../src/weixin/api/api.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "../../src/weixin/auth/login-qr.js";

vi.mock("../../src/weixin/api/api.js", () => ({
  apiGetFetch: vi.fn(),
  apiPostFetch: vi.fn(),
  parseApiResponse: JSON.parse,
}));
vi.mock("../../src/weixin/auth/accounts.js", () => ({
  listIndexedWeixinAccountIds: () => [],
  loadWeixinAccount: vi.fn(),
}));
vi.mock("qrcode-terminal", () => ({ default: { generate: vi.fn() } }));

const apiBaseUrl = "https://ilinkai.weixin.qq.com";
const confirmed = {
  status: "confirmed",
  bot_token: "bot-secret",
  ilink_bot_id: "bot-id",
  ilink_user_id: "login-user",
  baseurl: "https://account.example.test",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.mocked(apiPostFetch).mockResolvedValue(
    JSON.stringify({ qrcode: "qr-original", qrcode_img_content: "https://qr.example.test" }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function statuses(...responses: object[]): void {
  for (const response of responses)
    vi.mocked(apiGetFetch).mockResolvedValueOnce(JSON.stringify(response));
}

async function start() {
  return startWeixinLoginWithQr({ apiBaseUrl });
}

async function complete(sessionKey: string, timeoutMs?: number) {
  const result = waitForWeixinLogin({ sessionKey, apiBaseUrl, timeoutMs });
  await vi.runAllTimersAsync();
  return result;
}

// Supply input at the stdin boundary, without opening a real terminal or reading credentials.
function input(code: string): void {
  vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
  const originalOn = process.stdin.on;
  vi.spyOn(process.stdin, "on").mockImplementation((event, listener) => {
    if (event === "data") {
      void Promise.resolve().then(() => listener(`${code}\n`));
      return process.stdin;
    }
    return originalOn.call(process.stdin, event, listener);
  });
}

describe("QR login (mock API)", () => {
  it("returns confirmed credentials and consumes the login", async () => {
    const { sessionKey } = await start();
    statuses(confirmed);
    expect(await complete(sessionKey)).toEqual({
      connected: true,
      botToken: "bot-secret",
      accountId: "bot-id",
      userId: "login-user",
      baseUrl: "https://account.example.test",
      message: "已将此实例连接到微信。",
    });
    expect(await complete(sessionKey)).toMatchObject({
      connected: false,
      message: "当前没有进行中的登录，请先发起登录。",
    });
  });

  it("keeps already-bound success distinct from newly issued credentials", async () => {
    const { sessionKey } = await start();
    statuses({ status: "binded_redirect" });
    expect(await complete(sessionKey)).toEqual({
      connected: false,
      alreadyConnected: true,
      message: "已连接过此实例，无需重复连接。",
    });
  });

  it("follows the redirected host and uses refreshed QR contents", async () => {
    const { sessionKey } = await start();
    vi.mocked(apiPostFetch).mockResolvedValueOnce(
      JSON.stringify({ qrcode: "qr-refreshed", qrcode_img_content: "https://qr.example.test/new" }),
    );
    statuses(
      { status: "scaned_but_redirect", redirect_host: "redirect.example.test" },
      { status: "expired" },
      confirmed,
    );
    expect(await complete(sessionKey)).toMatchObject({ connected: true });
    expect(vi.mocked(apiGetFetch).mock.calls.map(([opts]) => opts.baseUrl)).toEqual([
      apiBaseUrl,
      "https://redirect.example.test",
      "https://redirect.example.test",
    ]);
    expect(vi.mocked(apiGetFetch).mock.calls[2]?.[0].endpoint).toContain("qrcode=qr-refreshed");
    expect(vi.mocked(apiPostFetch).mock.calls[1]?.[0].baseUrl).toBe(apiBaseUrl);
  });

  it("submits the verification code then clears it after scaned", async () => {
    input("123456");
    const { sessionKey } = await start();
    statuses({ status: "need_verifycode" }, { status: "scaned" }, confirmed);
    expect(await complete(sessionKey)).toMatchObject({ connected: true });
    expect(vi.mocked(apiGetFetch).mock.calls[1]?.[0].endpoint).toContain("verify_code=123456");
    expect(vi.mocked(apiGetFetch).mock.calls[2]?.[0].endpoint).not.toContain("verify_code");
  });

  it("clears a blocked verification code before refreshing", async () => {
    input("123456");
    const { sessionKey } = await start();
    statuses({ status: "need_verifycode" }, { status: "verify_code_blocked" }, confirmed);
    expect(await complete(sessionKey)).toMatchObject({ connected: true });
    expect(apiPostFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiGetFetch).mock.calls[2]?.[0].endpoint).not.toContain("verify_code");
  });

  it.each(["expired", "verify_code_blocked"])(
    "limits QR refreshes after repeated %s",
    async (status) => {
      const { sessionKey } = await start();
      statuses({ status }, { status }, { status });
      expect(await complete(sessionKey)).toMatchObject({
        connected: false,
        message: expect.stringContaining("连接流程已停止"),
      });
      expect(apiPostFetch).toHaveBeenCalledTimes(3);
      expect(apiGetFetch).toHaveBeenCalledTimes(3);
    },
  );

  it("rejects an expired local QR before polling", async () => {
    const { sessionKey } = await start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await complete(sessionKey)).toMatchObject({
      connected: false,
      message: "二维码已过期，请重新生成。",
    });
    expect(apiGetFetch).not.toHaveBeenCalled();
  });

  it("ends polling at the caller deadline", async () => {
    const { sessionKey } = await start();
    statuses({ status: "wait" });
    expect(await complete(sessionKey, 1000)).toMatchObject({
      connected: false,
      message: "登录超时，请重试。",
    });
    expect(apiGetFetch).toHaveBeenCalledTimes(1);
  });
});
