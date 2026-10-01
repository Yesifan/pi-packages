import fs from "node:fs";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcCall } from "../../src/cli/rpc-client.js";
import { Daemon, type DaemonDeps } from "../../src/daemon.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import { createLogger } from "../../src/util/logger.js";
import { registerWeixinAccountId, saveWeixinAccount } from "../../src/weixin/auth/accounts.js";
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
  new ProjectStore(path.join(dataDir, "config.json")).upsert(name, {
    cwd: projectDir,
    accounts,
    enabled,
  });
}

beforeEach(() => {
  daemons = [];
  dataDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "rpc-data-"));
  projectDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "rpc-proj-"));
  socketPath = path.join(dataDir, "daemon.sock");
  process.env.PI_WEIXIN_DATA_DIR = dataDir;
  registerWeixinAccountId("acct-a");
  saveWeixinAccount("acct-a", { token: "t-a", name: "personal" });
});

afterEach(async () => {
  for (const daemon of daemons) await daemon.stop();
  for (const id of broadcastAccounts) clearContextTokensForAccount(id);
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function makeDaemon(overrides: Partial<DaemonDeps> = {}): Daemon {
  const store = new ProjectStore(path.join(dataDir, "config.json"));
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
  it("project create/add account/enable via RPC round-trip against a running daemon", async () => {
    const daemon = makeDaemon();
    await daemon.start();

    // Initially empty.
    let list = await rpcCall<Array<{ name: string; state: string }>>(
      "project.list",
      {},
      socketPath,
    );
    expect(list).toEqual([]);

    // Create (disabled by default, accounts=[]).
    await rpcCall("project.create", { name: "foo", cwd: projectDir }, socketPath);
    list = await rpcCall<Array<{ name: string; enabled: boolean; accounts: string[] }>>(
      "project.list",
      {},
      socketPath,
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("foo");
    expect(list[0]!.enabled).toBe(false);
    expect(list[0]!.accounts).toEqual([]);

    // Add an account by label.
    await rpcCall("project.account.add", { name: "foo", accounts: ["personal"] }, socketPath);
    list = await rpcCall<Array<{ name: string; accounts: string[] }>>(
      "project.list",
      {},
      socketPath,
    );
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
    list = await rpcCall<Array<{ name: string; accounts: string[] }>>(
      "project.list",
      {},
      socketPath,
    );
    expect(list[0]!.accounts).toEqual([]);

    // Remove.
    await rpcCall("project.remove", { name: "foo" }, socketPath);
    list = await rpcCall<Array<{ name: string }>>("project.list", {}, socketPath);
    expect(list).toEqual([]);

    await daemon.stop();
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
    configureProject("foo", ["acct-a", "no-context", "acct-b"]);
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
