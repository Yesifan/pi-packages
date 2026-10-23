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
  it.each(["acct-a", "Personal", "unknown", " "])(
    "rejects non-name %s online and offline",
    async (name) => {
      rpc.mockResolvedValueOnce([{ accountId: "acct-a", name: "personal" }]);
      await expect(logout(name)).rejects.toThrow(/account name/);
      rpc.mockRejectedValueOnce(new DaemonNotRunningError());
      await expect(logout(name)).rejects.toThrow(/account name/);
      expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
    },
  );

  it("uses only the daemon mapping, including name/ID collisions", async () => {
    rpc.mockResolvedValueOnce([
      { accountId: "remote", name: "acct-a" },
      { accountId: "acct-a", name: "other" },
    ]);
    rpc.mockResolvedValueOnce({});
    await logout("acct-a");
    expect(rpc).toHaveBeenLastCalledWith("account.logout", { accountId: "remote" });
  });

  it("does not let local names override daemon names", async () => {
    rpc.mockResolvedValueOnce([{ accountId: "remote", name: "personal" }]);
    rpc.mockResolvedValueOnce({});
    await logout();
    expect(rpc).toHaveBeenLastCalledWith("account.logout", { accountId: "remote" });
  });

  it("rejects duplicate names online and offline", async () => {
    registerWeixinAccountId("acct-b");
    saveWeixinAccount("acct-b", { name: "personal" });
    rpc.mockResolvedValueOnce([
      { accountId: "acct-a", name: "personal" },
      { accountId: "acct-b", name: "personal" },
    ]);
    await expect(logout()).rejects.toThrow(/ambiguous account name/);
    rpc.mockRejectedValueOnce(new DaemonNotRunningError());
    await expect(logout()).rejects.toThrow(/ambiguous account name/);
    expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
  });

  it.each(["personal", " personal "])("uses RPC for online account %s", async (account) => {
    rpc.mockResolvedValueOnce([{ accountId: "acct-a", name: "personal" }]);
    rpc.mockResolvedValueOnce({});
    await logout(account);
    expect(rpc).toHaveBeenNthCalledWith(2, "account.logout", { accountId: "acct-a" });
    expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
    expect(listIndexedWeixinAccountIds()).toEqual(["acct-a"]);
    expect(console.log).toHaveBeenCalledWith('Logged out account "acct-a".');
  });

  it.each(["personal", " personal "])("clears offline account %s by ID", async (account) => {
    rpc.mockRejectedValueOnce(new DaemonNotRunningError());
    await logout(account);
    expect(loadWeixinAccount("acct-a")).toBeNull();
    expect(listIndexedWeixinAccountIds()).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      'Logged out account "acct-a" (daemon not running; credentials cleared).',
    );
  });

  it.each(["EACCES", "EPERM", "EIO"])(
    "does not unregister or report success when offline deletion fails: %s",
    async (code) => {
      rpc.mockRejectedValueOnce(new DaemonNotRunningError());
      const error = Object.assign(new Error("unlink failed"), { code });
      vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
        throw error;
      });
      await expect(logout()).rejects.toBe(error);
      expect(loadWeixinAccount("acct-a")?.token).toBe("test-token");
      expect(listIndexedWeixinAccountIds()).toEqual(["acct-a"]);
      expect(console.log).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

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
