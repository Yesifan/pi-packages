import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../../src/accounts/account-manager.js";
import { ControlStore } from "../../src/cli/control-store.js";
import { buildProgram } from "../../src/cli/index.js";
import { rpcCall } from "../../src/cli/rpc-client.js";
import { withControlLock } from "../../src/config/control-lock.js";
import * as paths from "../../src/config/paths.js";
import { Daemon, type DaemonDeps } from "../../src/daemon.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import type { AccountInfo } from "../../src/projects/types.js";
import { createLogger } from "../../src/util/logger.js";
import {
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "../../src/weixin/auth/accounts.js";
import {
  clearContextTokensForAccount,
  getContextToken,
  setContextToken,
} from "../../src/weixin/storage/context-token.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "silent" });
const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
let dataDir: string;
let socketPath: string;
let projectDir: string;
let daemons: Daemon[];
const broadcastAccounts = [
  "acct-a",
  "acct-b",
  "acct-c",
  "missing",
  "no-user",
  "no-context",
  "no-transport",
];

interface BroadcastResult {
  succeeded: number;
  skipped: number;
  failed: number;
}

function captureLogs() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    logger: pino(
      { level: "debug" },
      {
        write(line: string) {
          entries.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ),
  };
}

function saveAccount(id: string, userId?: string): void {
  registerWeixinAccountId(id);
  saveWeixinAccount(id, { token: `credential-${id}`, name: id, userId });
}

function configureProject(name: string, accounts: string[], enabled = true): void {
  new ProjectStore().upsert(name, {
    cwd: projectDir,
    accounts,
    enabled,
  });
}

beforeEach(() => {
  daemons = [];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-rpc-"));
  projectDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "rpc-proj-"));
  socketPath = path.join(dataDir, "daemon.sock");
  process.env.PI_WEIXIN_DATA_DIR = dataDir;
  vi.stubEnv("XDG_CONFIG_HOME", dataDir);
  vi.stubEnv("PI_WEIXIN_STATE_DIR", dataDir);
  vi.spyOn(paths, "resolveDaemonSocket").mockReturnValue(socketPath);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  registerWeixinAccountId("acct-a");
  saveWeixinAccount("acct-a", { token: "t-a", name: "personal" });
});

afterEach(async () => {
  for (const daemon of daemons) await daemon.stop();
  for (const id of broadcastAccounts) clearContextTokensForAccount(id);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function makeDaemon(overrides: Partial<DaemonDeps> = {}): Daemon {
  const store = new ProjectStore();
  const daemon = new Daemon({
    logger,
    store,
    startRpc: true,
    rpcSocketPath: socketPath,
    getAccountTransport: async () => new FakeWeixinTransport(),
    projectPiFactory: async () => new FakeAgentRuntime(),
    ...overrides,
  });
  daemons.push(daemon);
  return daemon;
}

describe("daemon UDS RPC", () => {
  it("rejects bound logout and replacement; unbind/save/sync/cleanup removes the monitor across restart", async () => {
    saveWeixinAccount("acct-a", { userId: "owner" });
    configureProject("foo", ["acct-a"], false);
    const transport = new FakeWeixinTransport();
    const stop = vi.spyOn(transport, "stop");
    const daemon = makeDaemon({ getAccountTransport: async () => transport });
    await daemon.start();
    const cli = new ControlStore();
    await expect(cli.logout("personal")).rejects.toThrow(/foo.*unbind/);
    await expect(
      cli.login("replacement", { name: "personal", userId: "owner", token: "fake" }),
    ).rejects.toThrow(/foo.*unbind/);
    expect(listIndexedWeixinAccountIds()).toEqual(["acct-a"]);
    expect(stop).not.toHaveBeenCalled();
    await cli.project("account.remove", "foo", { names: ["personal"] });
    await buildProgram().parseAsync(["logout", "personal"], { from: "user" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(loadWeixinAccount("acct-a")).toBeNull();
    expect(listIndexedWeixinAccountIds()).toEqual([]);
    expect(await rpcCall("account.list", {}, socketPath)).toEqual([]);
    await daemon.stop();
    const factory = vi.fn(async () => new FakeWeixinTransport());
    await makeDaemon({ getAccountTransport: factory }).start();
    expect(factory).not.toHaveBeenCalled();
  });

  it("reports committed configuration but skips cleanup when stopping fails", async () => {
    const transport = new FakeWeixinTransport();
    const daemon = makeDaemon({ getAccountTransport: async () => transport });
    await daemon.start();
    const stop = vi.spyOn(transport, "stop").mockRejectedValue(new Error("stop failed"));
    try {
      await expect(
        buildProgram().parseAsync(["logout", "personal"], { from: "user" }),
      ).rejects.toThrow(/saved; application failed/);
      expect(listIndexedWeixinAccountIds()).toEqual([]);
      expect(loadWeixinAccount("acct-a")?.token).toBe("t-a");
      expect(await rpcCall<AccountInfo[]>("account.list", {}, socketPath)).toEqual([
        expect.objectContaining({ accountId: "acct-a", registered: false, status: "error" }),
      ]);
    } finally {
      stop.mockRestore();
    }
  });

  it("reads current state after taking the lock and rebuilds same-ID credentials", async () => {
    const transports: FakeWeixinTransport[] = [];
    const factory = vi.fn(async () => {
      const t = new FakeWeixinTransport();
      transports.push(t);
      return t;
    });
    const daemon = makeDaemon({ getAccountTransport: factory });
    await daemon.start();
    const stop = vi.spyOn(transports[0]!, "stop");
    await new ControlStore().login("acct-a", { name: "personal", token: "new-fake" });
    await rpcCall("control.sync", { identity: daemon.identity }, socketPath);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenLastCalledWith("acct-a", "new-fake", undefined);
    // A reconcile queued behind a writer must read after that writer's commit.
    let reload!: Promise<void>;
    await withControlLock(async () => {
      reload = daemon.reload();
      const { saveWeixinAccountIds } = await import("../../src/weixin/auth/accounts.js");
      saveWeixinAccountIds([]);
    });
    await reload;
    expect(daemon.getControlStatus().runningAccountIds).toEqual([]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("lists registered accounts without monitors and retains unregistered actual receivers", async () => {
    registerWeixinAccountId("no-token");
    saveWeixinAccount("no-token", { name: "waiting" });
    const daemon = makeDaemon();
    await daemon.start();
    expect(await rpcCall("account.list", {}, socketPath)).toEqual([
      expect.objectContaining({ accountId: "acct-a", registered: true, status: "online" }),
      expect.objectContaining({ accountId: "no-token", registered: true, status: "stopped" }),
    ]);
    const live = vi
      .spyOn(AccountManager.prototype, "listAccounts")
      .mockReturnValue([{ accountId: "unregistered", status: "error", error: "stop failed" }]);
    try {
      expect(await rpcCall("account.list", {}, socketPath)).toContainEqual(
        expect.objectContaining({ accountId: "unregistered", registered: false, status: "error" }),
      );
    } finally {
      live.mockRestore();
    }
  });

  it("CLI saves project configuration and RPC only applies matching storage identities", async () => {
    const daemon = makeDaemon();
    await daemon.start();
    const cli = new ControlStore();
    await cli.project("create", "foo", { cwd: projectDir });
    await cli.project("account.add", "foo", { names: ["personal"] });
    await cli.project("enable", "foo");
    await expect(
      rpcCall("control.sync", { identity: "other-instance" }, socketPath),
    ).rejects.toThrow(/identity mismatch/);
    for (const method of [
      "project.create",
      "project.account.add",
      "project.enable",
      "account.logout",
    ]) {
      await expect(rpcCall(method, {}, socketPath)).rejects.toThrow(/moved to CLI/);
    }
    await rpcCall("control.sync", { identity: daemon.identity }, socketPath);
    expect(daemon.getProjectStatuses()).toEqual([
      expect.objectContaining({ name: "foo", accounts: ["personal"], state: "idle" }),
    ]);
  });

  it("broadcasts original text only to the selected project's owners, including restored tokens after restart", async () => {
    for (const id of ["acct-a", "acct-b", "acct-c"]) {
      saveAccount(id, `owner-${id}`);
      setContextToken(id, `owner-${id}`, `context-${id}`);
    }
    configureProject("foo", ["acct-a", "acct-b"]);
    configureProject("bar", ["acct-c"]);
    const transports = new Map<string, FakeWeixinTransport>();
    const getAccountTransport = async (id: string) => {
      const transport = new FakeWeixinTransport();
      transports.set(id, transport);
      return transport;
    };
    let daemon = makeDaemon({ getAccountTransport });
    await daemon.start();
    const text = "  部署完成\n原始通知内容  ";
    const send = () =>
      rpcCall<BroadcastResult>("project.broadcast", { name: "foo", text }, socketPath);
    const checkDeliveries = () => {
      for (const id of ["acct-a", "acct-b"]) {
        expect(transports.get(id)!.sentTexts).toEqual([
          {
            ctx: expect.objectContaining({
              accountId: id,
              senderId: `owner-${id}`,
              contextToken: `context-${id}`,
            }),
            text,
          },
        ]);
      }
      expect(transports.get("acct-c")!.sentTexts).toEqual([]);
    };
    expect(await send()).toEqual({ succeeded: 2, skipped: 0, failed: 0 });
    checkDeliveries();
    await daemon.stop();

    // Preserve disk files but clear the module cache to model a fresh daemon process.
    for (const id of ["acct-a", "acct-b", "acct-c"]) {
      const file = path.join(dataDir, "accounts", `${id}.context-tokens.json`);
      const persisted = fs.readFileSync(file, "utf8");
      clearContextTokensForAccount(id);
      fs.writeFileSync(file, persisted);
      expect(getContextToken(id, `owner-${id}`)).toBeUndefined();
    }
    daemon = makeDaemon({ getAccountTransport });
    await daemon.start();
    expect(await send()).toEqual({ succeeded: 2, skipped: 0, failed: 0 });
    checkDeliveries();
  });

  it("rejects invalid requests and disabled projects, and logs skipped or empty recipient sets", async () => {
    saveAccount("acct-a", "owner-a");
    setContextToken("acct-a", "owner-a", "context-a");
    saveAccount("no-user");
    saveAccount("no-context", "owner-no-context");
    // A cached token for a different sender must not substitute for the exact owner token.
    setContextToken("no-context", "other-sender", "other-context");
    registerWeixinAccountId("missing");
    registerWeixinAccountId("no-transport");
    saveWeixinAccount("no-transport", { userId: "owner-no-transport" });
    setContextToken("no-transport", "owner-no-transport", "context-no-transport");
    configureProject("disabled", ["acct-a"], false);
    configureProject("skips", ["missing", "no-user", "no-context", "no-transport"]);
    configureProject("empty", []);
    const { logger, entries } = captureLogs();
    const transports: FakeWeixinTransport[] = [];
    const daemon = makeDaemon({
      logger,
      getAccountTransport: async () => {
        const transport = new FakeWeixinTransport();
        transports.push(transport);
        return transport;
      },
    });
    await daemon.start();
    for (const params of [
      { name: "absent", text: "notice" },
      { name: "disabled", text: "notice" },
      { name: "skips", text: " \n\t " },
      { name: "skips", text: "" },
      { name: "skips", text: 42 },
      { name: 42, text: "notice" },
      { text: "notice" },
      { name: "skips" },
    ]) {
      await expect(rpcCall("project.broadcast", params, socketPath)).rejects.toThrow();
    }
    expect(
      await rpcCall("project.broadcast", { name: "skips", text: "notice" }, socketPath),
    ).toEqual({ succeeded: 0, skipped: 4, failed: 0 });
    expect(
      await rpcCall("project.broadcast", { name: "empty", text: "notice" }, socketPath),
    ).toEqual({ succeeded: 0, skipped: 0, failed: 0 });
    expect(transports.every((transport) => transport.sentTexts.length === 0)).toBe(true);
    expect(entries.filter((entry) => entry.status === "skipped")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project: "skips",
          account: "missing",
          reason: "missing-account",
        }),
        expect.objectContaining({ project: "skips", account: "no-user", reason: "missing-user" }),
        expect.objectContaining({
          project: "skips",
          account: "no-context",
          user: "owner-no-context",
          reason: "missing-context-token",
        }),
        expect.objectContaining({
          project: "skips",
          account: "no-transport",
          user: "owner-no-transport",
          reason: "missing-transport",
        }),
      ]),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        project: "empty",
        reason: "no-bound-accounts",
        succeeded: 0,
        skipped: 0,
        failed: 0,
      }),
    );
  });

  it("continues after a target fails, reports counts, and logs results without text or credentials", async () => {
    saveAccount("acct-a", "owner-a");
    saveAccount("acct-b", "owner-b");
    saveAccount("no-context", "owner-no-context");
    setContextToken("acct-a", "owner-a", "private-context-a");
    setContextToken("acct-b", "owner-b", "private-context-b");
    configureProject("foo", ["acct-a", "no-context", "acct-b"], false);
    const { logger, entries } = captureLogs();
    const failedTransport = new FakeWeixinTransport();
    const successfulTransport = new FakeWeixinTransport();
    const text = "private-notification-body";
    const send = vi
      .spyOn(failedTransport, "sendText")
      .mockRejectedValue(
        new Error(`upstream rejected: ${text}; credential-acct-a; private-context-a`),
      );
    const daemon = makeDaemon({
      logger,
      getAccountTransport: async (id) => (id === "acct-a" ? failedTransport : successfulTransport),
      // Pi startup failures must not disqualify an enabled project from explicit notifications.
      projectPiFactory: async () => {
        throw new Error("Pi unavailable");
      },
    });
    await daemon.start();
    configureProject("foo", ["acct-a", "no-context", "acct-b"], true);
    await expect(daemon.reload()).rejects.toThrow("application failed");
    expect(await rpcCall("project.broadcast", { name: "foo", text }, socketPath)).toEqual({
      succeeded: 1,
      skipped: 1,
      failed: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(successfulTransport.sentTexts).toEqual([
      {
        ctx: expect.objectContaining({
          accountId: "acct-b",
          senderId: "owner-b",
          contextToken: "private-context-b",
        }),
        text,
      },
    ]);
    expect(await rpcCall("project.list", {}, socketPath)).toHaveLength(1);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project: "foo",
          account: "acct-a",
          user: "owner-a",
          status: "failed",
          classification: "delivery-failed",
        }),
        expect.objectContaining({
          project: "foo",
          account: "no-context",
          user: "owner-no-context",
          status: "skipped",
        }),
        expect.objectContaining({
          project: "foo",
          account: "acct-b",
          user: "owner-b",
          status: "succeeded",
        }),
        expect.objectContaining({ project: "foo", succeeded: 1, skipped: 1, failed: 1 }),
      ]),
    );
    const logs = JSON.stringify(entries);
    for (const secret of [
      text,
      "credential-acct-a",
      "credential-acct-b",
      "private-context-a",
      "private-context-b",
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("reports DaemonNotRunningError when the socket is absent", async () => {
    await expect(rpcCall("project.list", {}, path.join(dataDir, "missing.sock"))).rejects.toThrow(
      /Daemon is not running/,
    );
  });
});
