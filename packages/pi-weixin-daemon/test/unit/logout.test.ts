import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/cli/index.js";
import { DaemonNotRunningError, rpcCall } from "../../src/cli/rpc-client.js";
import {
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "../../src/weixin/auth/accounts.js";

vi.mock("../../src/cli/rpc-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cli/rpc-client.js")>()),
  rpcCall: vi.fn(),
}));

let dataDir: string;
const rpc = vi.mocked(rpcCall);
const logout = (account = "personal") =>
  buildProgram().parseAsync(["logout", account], { from: "user" });

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "logout-test-"));
  vi.stubEnv("PI_WEIXIN_DATA_DIR", dataDir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  rpc.mockReset();
  registerWeixinAccountId("acct-a");
  saveWeixinAccount("acct-a", { token: "test-token", name: "personal" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("logout", () => {
  it.each(["personal", "acct-a"])("uses RPC for online account %s", async (account) => {
    rpc.mockResolvedValueOnce([{ accountId: "acct-a", name: "personal" }]);
    rpc.mockResolvedValueOnce({});
    await logout(account);
    expect(rpc).toHaveBeenNthCalledWith(2, "account.logout", { accountId: "acct-a" });
    expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
    expect(listIndexedWeixinAccountIds()).toEqual(["acct-a"]);
    expect(console.log).toHaveBeenCalledWith('Logged out account "acct-a".');
  });

  it.each(["personal", "acct-a"])("clears offline account %s by ID", async (account) => {
    rpc.mockRejectedValueOnce(new DaemonNotRunningError());
    await logout(account);
    expect(loadWeixinAccount("acct-a")).toBeNull();
    expect(listIndexedWeixinAccountIds()).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      'Logged out account "acct-a" (daemon not running; credentials cleared).',
    );
  });

  it("uses the daemon alias mapping when local metadata has no name", async () => {
    saveWeixinAccount("acct-a", { name: "" });
    rpc.mockResolvedValueOnce([{ accountId: "acct-a", name: "personal" }]);
    rpc.mockResolvedValueOnce({});
    await logout();
    expect(rpc).toHaveBeenNthCalledWith(2, "account.logout", { accountId: "acct-a" });
    expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
  });

  it("keeps the resolved ID if the logout connection is refused after listing", async () => {
    saveWeixinAccount("acct-a", { name: "" });
    rpc.mockResolvedValueOnce([{ accountId: "acct-a", name: "personal" }]);
    rpc.mockRejectedValueOnce(new DaemonNotRunningError());
    await logout();
    expect(loadWeixinAccount("acct-a")).toBeNull();
    expect(listIndexedWeixinAccountIds()).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  for (const stage of ["account.list", "account.logout"]) {
    it.each(["business error", "rpc timeout", "invalid response", "EACCES", "ECONNRESET"])(
      `preserves credentials on ${stage} failure: %s`,
      async (message) => {
        const error = new Error(message);
        if (stage === "account.logout") {
          rpc.mockResolvedValueOnce([{ accountId: "acct-a", name: "personal" }]);
        }
        rpc.mockRejectedValueOnce(error);
        await expect(logout()).rejects.toBe(error);
        expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
        expect(listIndexedWeixinAccountIds()).toEqual(["acct-a"]);
        expect(console.log).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledTimes(stage === "account.list" ? 1 : 2);
      },
    );
  }

  it("does not clear credentials when account list is invalid", async () => {
    rpc.mockResolvedValueOnce(null);
    await expect(logout()).rejects.toThrow();
    expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
    expect(console.log).not.toHaveBeenCalled();
  });
});
