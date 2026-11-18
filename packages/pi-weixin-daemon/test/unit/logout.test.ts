import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupRemovedAccounts } from "../../src/cli/apply-control.js";
import { buildProgram } from "../../src/cli/index.js";
import { DaemonNotRunningError, rpcCall } from "../../src/cli/rpc-client.js";
import { storageIdentity } from "../../src/config/control-lock.js";
import {
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "../../src/weixin/auth/accounts.js";

vi.mock("../../src/cli/rpc-client.js", async (original) => ({
  ...(await original<typeof import("../../src/cli/rpc-client.js")>()),
  rpcCall: vi.fn(),
}));
let dir: string;
const rpc = vi.mocked(rpcCall);
const logout = (name = "personal") => buildProgram().parseAsync(["logout", name], { from: "user" });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "logout-test-"));
  vi.stubEnv("PI_WEIXIN_DATA_DIR", dir);
  vi.stubEnv("PI_WEIXIN_STATE_DIR", dir);
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  rpc.mockReset();
  registerWeixinAccountId("A");
  saveWeixinAccount("A", { name: "personal", token: "fake" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
it("resolves only locked local names, not IDs or a stale daemon mapping", async () => {
  await expect(logout("A")).rejects.toThrow(/unknown account name/);
  expect(rpc).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ identity: storageIdentity(), runningAccountIds: [] });
  await logout(" personal ");
  expect(rpc).toHaveBeenCalledWith("control.sync", { identity: storageIdentity() });
  expect(listIndexedWeixinAccountIds()).toEqual([]);
  expect(loadWeixinAccount("A")).toBeNull();
});
it("confirms offline with the instance lock and reports saved pending startup", async () => {
  rpc.mockRejectedValue(new DaemonNotRunningError());
  await logout();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("pending next startup"));
  expect(listIndexedWeixinAccountIds()).toEqual([]);
  expect(loadWeixinAccount("A")).toBeNull();
});
it("retains files after a sync failure, without rolling back the committed registry", async () => {
  rpc.mockRejectedValue(new Error("stop failed"));
  await expect(logout()).rejects.toThrow(/Configuration saved; application failed or unknown/);
  expect(listIndexedWeixinAccountIds()).toEqual([]);
  expect(loadWeixinAccount("A")?.token).toBe("fake");
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("first stop"));
});
it("reports a cleanup warning without changing successful application", async () => {
  rpc.mockResolvedValue({ identity: storageIdentity(), runningAccountIds: [] });
  const original = fs.unlinkSync.bind(fs);
  const file = path.join(dir, "accounts", "A.json");
  vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
    if (p === file) throw new Error("denied");
    original(p);
  });
  await logout();
  expect(listIndexedWeixinAccountIds()).toEqual([]);
  expect(loadWeixinAccount("A")?.token).toBe("fake");
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining(`manually remove residual file ${file}`),
  );
});
it("does not clean credentials that were registered again after an earlier stop confirmation", async () => {
  saveWeixinAccount("A", { token: "new-fake" });
  await cleanupRemovedAccounts(["A"]);
  expect(loadWeixinAccount("A")?.token).toBe("new-fake");
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("registered again"));
});
