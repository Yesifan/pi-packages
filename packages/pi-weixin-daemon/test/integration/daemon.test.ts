import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import { createLogger } from "../../src/util/logger.js";
import {
  registerWeixinAccountId,
  saveWeixinAccount,
  unregisterWeixinAccountId,
} from "../../src/weixin/auth/accounts.js";
import {
  clearContextTokensForAccount,
  getContextToken,
} from "../../src/weixin/storage/context-token.js";
import type { InboundMessage } from "../../src/weixin/types.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "silent" });
const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
let dataDir: string;

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

let fooDir: string;
let barDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "daemon-"));
  process.env.PI_WEIXIN_DATA_DIR = dataDir;
  fooDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "dfoo-"));
  barDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "dbar-"));
  for (const a of ["A", "B", "C", "D"]) {
    registerWeixinAccountId(a);
    saveWeixinAccount(a, { token: `tok-${a}` });
  }
});

afterEach(() => {
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(fooDir, { recursive: true, force: true });
  fs.rmSync(barDir, { recursive: true, force: true });
});

function makeStore(): ProjectStore {
  const store = new ProjectStore(path.join(dataDir, "config.json"));
  store.upsert("foo", { cwd: fooDir, accounts: ["A", "B"], enabled: true });
  store.upsert("bar", { cwd: barDir, accounts: ["C"], enabled: true });
  return store;
}

function msg(accountId: string, senderId: string, messageId: string, text: string): InboundMessage {
  return { accountId, senderId, messageId, text, attachments: [], createdAt: Date.now() };
}

describe("Daemon composition (fake transports + fake runtimes)", () => {
  it("unsubscribes and removes accounts before awaiting stop, tolerating repeated removal and stop failures", async () => {
    const events: string[] = [];
    const snapshots: string[][] = [];
    let releaseStop!: () => void;
    const stopping = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const daemon = new Daemon({
      logger,
      store: new ProjectStore(path.join(dataDir, "config.json")),
      getAccountTransport: async (id) => {
        const transport = new FakeWeixinTransport();
        const subscribe = transport.onMessage.bind(transport);
        transport.onMessage = (handler) => {
          const unsubscribe = subscribe(handler);
          return () => {
            events.push(`unsubscribe:${id}`);
            unsubscribe();
          };
        };
        transport.stop = async () => {
          events.push(`stop:${id}`);
          snapshots.push(daemon.getAccountStatuses().map((account) => account.accountId));
          if (id === "A") await stopping;
          if (id === "A" || id === "B") throw new Error("stop failed");
        };
        return transport;
      },
    });
    try {
      await daemon.start();
      expect(daemon.getAccountStatuses()).toHaveLength(4);
      for (const account of daemon.getAccountStatuses()) {
        expect(account).not.toHaveProperty("unsubscribe");
        expect(account).not.toHaveProperty("transport");
      }
      unregisterWeixinAccountId("A");
      const removal = daemon.reloadAccounts();
      await vi.waitFor(() => expect(events).toEqual(["unsubscribe:A", "stop:A"]));
      expect(snapshots).toEqual([["B", "C", "D"]]);
      await daemon.reloadAccounts();
      expect(events).toHaveLength(2);
      releaseStop();
      await removal;
      await daemon.stop();
      await daemon.stop();
      expect(events).toEqual([
        "unsubscribe:A",
        "stop:A",
        "unsubscribe:B",
        "stop:B",
        "unsubscribe:C",
        "stop:C",
        "unsubscribe:D",
        "stop:D",
      ]);
      expect(snapshots).toEqual([["B", "C", "D"], ["C", "D"], ["D"], []]);
      expect(daemon.getAccountStatuses()).toEqual([]);
    } finally {
      releaseStop();
      await daemon.stop();
    }
  });

  it("reload starts only new credentialed accounts, restores tokens, and keeps missing-token logging distinct", async () => {
    registerWeixinAccountId("missing");
    const testLogger = createLogger({ level: "silent" });
    const warn = vi.spyOn(testLogger, "warn");
    const getAccountTransport = vi.fn(
      async (_id: string, _token?: string, _baseUrl?: string) => new FakeWeixinTransport(),
    );
    const daemon = new Daemon({
      logger: testLogger,
      store: new ProjectStore(path.join(dataDir, "config.json")),
      getAccountTransport,
    });
    try {
      await daemon.start();
      expect(warn).toHaveBeenCalledWith(
        { account: "missing" },
        "account has no token, skipping monitor",
      );
      expect(getAccountTransport).toHaveBeenCalledTimes(4);
      warn.mockClear();
      registerWeixinAccountId("new");
      saveWeixinAccount("new", {
        token: "new-token",
        baseUrl: "https://example.test",
        userId: "new-user",
      });
      fs.writeFileSync(
        path.join(dataDir, "accounts", "new.context-tokens.json"),
        JSON.stringify({ "new-user": "new-context" }),
      );
      await daemon.reloadAccounts();
      await daemon.reloadAccounts();
      expect(getAccountTransport).toHaveBeenCalledTimes(5);
      expect(getAccountTransport).toHaveBeenLastCalledWith(
        "new",
        "new-token",
        "https://example.test",
      );
      expect(getContextToken("new", "new-user")).toBe("new-context");
      expect(
        daemon.getAccountStatuses().find((account) => account.accountId === "new"),
      ).toMatchObject({ status: "online", userId: "new-user" });
      expect(daemon.getAccountStatuses().some((account) => account.accountId === "missing")).toBe(
        false,
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
      clearContextTokensForAccount("new");
      warn.mockRestore();
    }
  });

  it("restores exact tokens and delivers Agent rounds to bound users who have not sent inbound", async () => {
    for (const id of ["A", "B", "C"]) {
      clearContextTokensForAccount(id);
      saveWeixinAccount(id, { userId: `login-${id}` });
      // Disk-only state from a previous daemon, not this process's inbound messages.
      fs.writeFileSync(
        path.join(dataDir, "accounts", `${id}.context-tokens.json`),
        JSON.stringify({ [`login-${id}`]: `cached-${id}`, "other-sender": "unrelated-token" }),
      );
    }
    const transports = new Map<string, FakeWeixinTransport>();
    const runtimes = new Map<string, FakeAgentRuntime>();
    const daemon = new Daemon({
      logger,
      store: makeStore(),
      getAccountTransport: async (id) => {
        const transport = new FakeWeixinTransport();
        transports.set(id, transport);
        return transport;
      },
      projectPiFactory: async (ctx) => {
        const runtime = new FakeAgentRuntime(ctx.cwd);
        runtimes.set(ctx.projectId, runtime);
        return runtime;
      },
    });
    try {
      await daemon.start();
      const runtime = runtimes.get("foo")!;
      // Preserve lazy lifecycle: A opens the session; B has never sent a message.
      const pending = transports.get("A")!.emit(msg("A", "other-sender", "first", "hello"));
      await vi.waitFor(() => expect(runtime.prompts).toHaveLength(1));
      runtime.complete("");
      await pending;
      for (const id of ["A", "B"]) transports.get(id)!.sentTexts.length = 0;
      runtime.startIndependentTurn();
      runtime.completeIndependentTurn("independent answer");
      await vi.waitFor(() => expect(transports.get("B")!.sentTexts).toHaveLength(1));
      for (const id of ["A", "B"]) {
        expect(transports.get(id)!.sentTexts[0]).toMatchObject({
          ctx: { senderId: `login-${id}`, contextToken: `cached-${id}` },
          text: "independent answer",
        });
        expect(transports.get(id)!.typingEvents.map((event) => event.typing)).toEqual([
          true,
          false,
        ]);
        for (const event of transports.get(id)!.typingEvents) {
          expect(event.ctx).toMatchObject({
            accountId: id,
            senderId: `login-${id}`,
            contextToken: `cached-${id}`,
          });
        }
      }
      expect(transports.get("C")!.sentTexts).toHaveLength(0);
      expect(runtime.prompts).toHaveLength(1);
      expect(await daemon.broadcastProject("foo", "notice")).toEqual({
        succeeded: 2,
        skipped: 0,
        failed: 0,
      });
    } finally {
      await daemon.stop();
      for (const id of ["A", "B", "C"]) clearContextTokensForAccount(id);
    }
  });

  it("routes account -> project; unbound account is dropped at dispatch", async () => {
    const transports = new Map<string, FakeWeixinTransport>();
    const fakes = new Map<string, FakeAgentRuntime>();
    const daemon = new Daemon({
      logger,
      store: makeStore(),
      getAccountTransport: async (id) => {
        if (!transports.has(id)) transports.set(id, new FakeWeixinTransport());
        return transports.get(id)!;
      },
      projectPiFactory: async (ctx) => {
        const fake = new FakeAgentRuntime(ctx.cwd);
        fakes.set(ctx.projectId, fake);
        return fake;
      },
    });
    await daemon.start();

    // Assert desired state: foo + bar runtimes started.
    expect(
      daemon
        .getProjectStatuses()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["bar", "foo"]);

    // C -> bar: emit on C's transport flows through dispatch -> bar runtime.
    const pC = transports.get("C")!.emit(msg("C", "u-c", "m1", "hello"));
    await tick();
    fakes.get("bar")!.complete("bar reply");
    await pC;
    expect(fakes.get("bar")!.prompts).toHaveLength(1);

    // A -> foo.
    const pA = transports.get("A")!.emit(msg("A", "u-a", "m2", "hi"));
    await tick();
    fakes.get("foo")!.complete("foo reply");
    await pA;
    expect(fakes.get("foo")!.prompts).toHaveLength(1);

    // D is registered but bound to no project -> dropped; neither runtime sees it.
    await transports.get("D")!.emit(msg("D", "u-d", "m3", "orphan"));
    await tick();
    expect(fakes.get("foo")!.prompts).toHaveLength(1);
    expect(fakes.get("bar")!.prompts).toHaveLength(1);

    await daemon.stop();
  });

  it("project enabled=false is not started and its account is dropped", async () => {
    const stores = new ProjectStore(path.join(dataDir, "config.json"));
    stores.upsert("foo", { cwd: fooDir, accounts: ["A"], enabled: false });
    const transport = new FakeWeixinTransport();
    const projectPiFactory = vi.fn(async () => new FakeAgentRuntime());
    const daemon = new Daemon({
      logger,
      store: stores,
      getAccountTransport: async (id) => (id === "A" ? transport : new FakeWeixinTransport()),
      projectPiFactory,
    });
    await daemon.start();
    await transport.emit(msg("A", "u-a", "m1", "disabled"));
    expect(projectPiFactory).not.toHaveBeenCalled();
    expect(daemon.getProjectStatuses()).toHaveLength(1);
    expect(daemon.getProjectStatuses()[0]!.state).toBe("off");
    await daemon.stop();
  });
});
