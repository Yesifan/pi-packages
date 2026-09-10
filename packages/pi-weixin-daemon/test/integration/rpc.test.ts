import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Daemon } from "../../src/daemon.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import { registerWeixinAccountId, saveWeixinAccount } from "../../src/weixin/auth/accounts.js";
import { rpcCall } from "../../src/cli/rpc-client.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeWeixinTransport } from "../helpers/fake-transport.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";

const logger = createLogger({ level: "silent" });
const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
let dataDir: string;
let socketPath: string;
let projectDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "rpc-data-"));
  projectDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "rpc-proj-"));
  socketPath = path.join(dataDir, "daemon.sock");
  process.env.PI_WEIXIN_DATA_DIR = dataDir;
  registerWeixinAccountId("acct-a");
  saveWeixinAccount("acct-a", { token: "t-a", name: "personal" });
});

afterEach(() => {
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function makeDaemon(): Daemon {
  const store = new ProjectStore(path.join(dataDir, "config.json"));
  return new Daemon({
    logger,
    store,
    startRpc: true,
    rpcSocketPath: socketPath,
    getAccountTransport: async () => new FakeWeixinTransport(),
    projectPiFactory: async () => new FakeAgentRuntime(),
  });
}

describe("daemon UDS RPC", () => {
  it("project create/add account/enable via RPC round-trip against a running daemon", async () => {
    const daemon = makeDaemon();
    await daemon.start();

    // Initially empty.
    let list = await rpcCall<Array<{ name: string; state: string }>>("project.list", {}, socketPath);
    expect(list).toEqual([]);

    // Create (disabled by default, accounts=[]).
    await rpcCall("project.create", { name: "foo", cwd: projectDir }, socketPath);
    list = await rpcCall<Array<{ name: string; enabled: boolean; accounts: string[] }>>("project.list", {}, socketPath);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("foo");
    expect(list[0]!.enabled).toBe(false);
    expect(list[0]!.accounts).toEqual([]);

    // Add an account by label.
    await rpcCall("project.account.add", { name: "foo", accounts: ["personal"] }, socketPath);
    list = await rpcCall<Array<{ name: string; accounts: string[] }>>("project.list", {}, socketPath);
    expect(list[0]!.accounts).toEqual(["personal"]);

    // Enable -> runtime starts.
    await rpcCall("project.enable", { name: "foo" }, socketPath);
    const statuses = await rpcCall<Array<{ state: string }>>("project.list", {}, socketPath);
    expect(statuses[0]!.state).toBe("idle");

    // daemon.status snapshot.
    const status = await rpcCall<{ version: string; projects: unknown[]; accounts: unknown[] }>(
      "daemon.status",
      {},
      socketPath,
    );
    expect(status.version).toBeTruthy();
    expect(status.projects).toHaveLength(1);

    // Remove account by label.
    await rpcCall("project.account.remove", { name: "foo", accounts: ["personal"] }, socketPath);
    list = await rpcCall<Array<{ name: string; accounts: string[] }>>("project.list", {}, socketPath);
    expect(list[0]!.accounts).toEqual([]);

    // Remove.
    await rpcCall("project.remove", { name: "foo" }, socketPath);
    list = await rpcCall<Array<{ name: string }>>("project.list", {}, socketPath);
    expect(list).toEqual([]);

    await daemon.stop();
  });

  it("reports DaemonNotRunningError when the socket is absent", async () => {
    await expect(rpcCall("project.list", {}, path.join(dataDir, "missing.sock"))).rejects.toThrow(
      /Daemon is not running/,
    );
  });
});
