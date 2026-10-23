import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../../src/cli/doctor.js";
import { projectCommand } from "../../src/cli/project.js";
import { DaemonNotRunningError, rpcCall } from "../../src/cli/rpc-client.js";
import { registerWeixinAccountId, saveWeixinAccount } from "../../src/weixin/auth/accounts.js";

vi.mock("../../src/cli/rpc-client.js", async (original) => ({
  ...(await original<typeof import("../../src/cli/rpc-client.js")>()),
  rpcCall: vi.fn(),
}));
vi.mock("../../src/pi/sdk-info.js", () => ({
  isPiSdkAvailable: () => true,
  piSdkVersion: () => "test",
  checkModelAvailability: async () => ({ ok: true, detail: "test" }),
}));
const rpc = vi.mocked(rpcCall);
let dir: string;
let oldExitCode: typeof process.exitCode;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-select-"));
  vi.stubEnv("PI_WEIXIN_DATA_DIR", dir);
  vi.stubEnv("XDG_STATE_HOME", dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  oldExitCode = process.exitCode;
  process.exitCode = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rpc.mockReset();
  registerWeixinAccountId("local");
  saveWeixinAccount("local", { name: "personal", token: "local-token" });
  registerWeixinAccountId("remote");
  saveWeixinAccount("remote", { name: "different", token: "remote-token" });
});
afterEach(() => {
  process.exitCode = oldExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
const doctor = (...args: string[]) => doctorCommand().parseAsync(args, { from: "user" });
describe("doctor account names", () => {
  it("uses daemon names, never local mapping or ID fallback", async () => {
    rpc.mockResolvedValue([{ accountId: "remote", name: "personal" }]);
    await doctor("--account", " personal ");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("account remote"));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("account local"));
    await expect(doctor("--account", "remote")).rejects.toThrow(/unknown account name/);
    await expect(doctor("--account", "Personal")).rejects.toThrow(/unknown account name/);
  });
  it("uses the daemon account list even without explicit selection", async () => {
    rpc.mockResolvedValue([{ accountId: "remote", name: "personal" }]);
    await doctor();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("account remote"));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("account local"));
  });
  it("selects local names only when definitely offline", async () => {
    rpc.mockRejectedValue(new DaemonNotRunningError());
    await doctor("--account", " personal ");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("account local"));
    await expect(doctor("--account", "local")).rejects.toThrow(/unknown account name/);
  });
  it("rejects duplicate names and non-offline errors", async () => {
    rpc.mockResolvedValueOnce([
      { accountId: "local", name: "personal" },
      { accountId: "remote", name: "personal" },
    ]);
    await expect(doctor("--account", "personal")).rejects.toThrow(/ambiguous account name/);
    rpc.mockRejectedValueOnce(new Error("rpc timeout"));
    await expect(doctor("--account", "personal")).rejects.toThrow("rpc timeout");
  });
});
describe("project CLI account names", () => {
  it.each(["add", "remove"])(
    "resolves %s names once against the daemon and sends accountIds",
    async (verb) => {
      rpc.mockResolvedValueOnce([{ accountId: "remote", name: "local" }]).mockResolvedValueOnce([]);
      await projectCommand().parseAsync(["foo", verb, " local "], { from: "user" });
      expect(rpc).toHaveBeenLastCalledWith(`project.account.${verb}`, {
        name: "foo",
        accountIds: ["remote"],
      });
    },
  );
  it.each(["remote", "Personal", "unknown"])(
    "rejects ID or unknown name %s without mutating",
    async (name) => {
      rpc.mockResolvedValueOnce([{ accountId: "remote", name: "personal" }]);
      await projectCommand().parseAsync(["foo", "add", name], { from: "user" });
      expect(process.exitCode).toBe(1);
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects ambiguous names without mutation", async () => {
    rpc.mockResolvedValueOnce([
      { accountId: "local", name: "personal" },
      { accountId: "remote", name: "personal" },
    ]);
    await projectCommand().parseAsync(["foo", "remove", "personal"], { from: "user" });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ambiguous account name"));
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
