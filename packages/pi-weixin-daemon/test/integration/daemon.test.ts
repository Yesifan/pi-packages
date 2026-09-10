import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Daemon } from "../../src/daemon.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import { registerWeixinAccountId, saveWeixinAccount } from "../../src/weixin/auth/accounts.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeWeixinTransport } from "../helpers/fake-transport.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import type { InboundMessage } from "../../src/weixin/types.js";

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
    expect(daemon.getProjectStatuses().map((p) => p.name).sort()).toEqual(["bar", "foo"]);

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
    const daemon = new Daemon({
      logger,
      store: stores,
      getAccountTransport: async () => new FakeWeixinTransport(),
      projectPiFactory: async () => new FakeAgentRuntime(),
    });
    await daemon.start();
    expect(daemon.getProjectStatuses()).toHaveLength(1);
    expect(daemon.getProjectStatuses()[0]!.state).toBe("off");
    await daemon.stop();
  });
});
