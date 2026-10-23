import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlStore } from "../../src/cli/control-store.js";
import { rpcBroadcast, rpcCall, rpcPrompt } from "../../src/cli/rpc-client.js";
import { Daemon } from "../../src/daemon.js";
import { createWeixinSendFileExtension } from "../../src/pi/extensions/weixin-send-file.js";
import { WeixinUIContext } from "../../src/pi/ui-context.js";
import type { ProjectHostFactoryContext } from "../../src/projects/project-controller.js";
import { ProjectStateStore } from "../../src/projects/project-state-store.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import { createLogger } from "../../src/util/logger.js";
import { registerWeixinAccountId, saveWeixinAccount } from "../../src/weixin/auth/accounts.js";
import { WeixinFileSender } from "../../src/weixin/file-sender.js";
import {
  clearContextTokensForAccount,
  setContextToken,
} from "../../src/weixin/storage/context-token.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";
import { HistoryRuntime } from "../helpers/history-runtime.js";

const logger = createLogger({ level: "silent" });
const originalData = process.env.PI_WEIXIN_DATA_DIR;
const originalState = process.env.PI_WEIXIN_STATE_DIR;
let root: string;
let socket: string;
let store: ProjectStore;
let daemon: Daemon;
let runtimes: Map<string, HistoryRuntime>;
let transports: Map<string, FakeWeixinTransport>;
let contexts: Map<string, ProjectHostFactoryContext>;

function buildDaemon() {
  return new Daemon({
    logger,
    store,
    startRpc: true,
    rpcSocketPath: socket,
    getAccountTransport: async (id) => {
      const transport = new FakeWeixinTransport();
      transports.set(id, transport);
      return transport;
    },
    projectPiFactory: async (ctx) => {
      const runtime = new HistoryRuntime(ctx.cwd);
      contexts.set(ctx.projectId, ctx);
      runtimes.set(ctx.projectId, runtime);
      return runtime;
    },
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wx-prompt-"));
  process.env.PI_WEIXIN_DATA_DIR = root;
  process.env.PI_WEIXIN_STATE_DIR = path.join(root, "state");
  socket = path.join(root, "daemon.sock");
  runtimes = new Map();
  transports = new Map();
  contexts = new Map();
  for (const id of ["A", "B", "C"]) {
    registerWeixinAccountId(id);
    saveWeixinAccount(id, { token: `bot-${id}`, userId: `user-${id}` });
    setContextToken(id, `user-${id}`, `exact-${id}`);
  }
  store = new ProjectStore(path.join(root, "config.json"));
  for (const [name, accounts] of [
    ["foo", ["A", "B"]],
    ["bar", ["C"]],
  ] as const) {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    store.upsert(name, { cwd, accounts: [...accounts], enabled: true });
  }
  daemon = buildDaemon();
  await daemon.start();
});

afterEach(async () => {
  await daemon.stop();
  for (const id of ["A", "B", "C"]) clearContextTokensForAccount(id);
  if (originalData === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = originalData;
  if (originalState === undefined) delete process.env.PI_WEIXIN_STATE_DIR;
  else process.env.PI_WEIXIN_STATE_DIR = originalState;
  fs.rmSync(root, { recursive: true, force: true });
});

function inbound(accountId: string, text: string) {
  return transports
    .get(accountId)!
    .emit(makeInboundMessage({ accountId, senderId: `user-${accountId}`, text }));
}

async function complete(text: string, count: number, name = "foo") {
  const runtime = runtimes.get(name)!;
  await vi.waitFor(() => expect(runtime.prompts).toHaveLength(count));
  runtime.complete(text);
}

function sent(id: string) {
  return transports.get(id)!.sentTexts.map((item) => item.text);
}

describe("CLI prompt over real local UDS", () => {
  it("shares default/active histories, validates before switching, and separates broadcast from activation", async () => {
    await rpcBroadcast({ name: "foo", text: "notice" }, socket);
    expect(runtimes.get("foo")!.hasSession()).toBe(false);
    const first = rpcPrompt({ name: "foo", text: "first" }, socket);
    await complete("caller only", 1);
    const result = await first;
    expect(result).toMatchObject({ status: "success", text: "caller only" });
    const defaultId = result.sessionId!;
    expect(daemon.getProjectStatus("foo").defaultSessionId).toBe(defaultId);
    expect(sent("A")).toEqual(["notice"]);
    await expect(
      rpcPrompt({ name: "foo", text: "bad", newSession: true, sessionId: defaultId }, socket),
    ).rejects.toThrow("mutually exclusive");
    await expect(
      rpcPrompt({ name: "foo", text: "bad", newSession: true, reply: ["user:user-C"] }, socket),
    ).rejects.toThrow("unknown project");
    await expect(
      rpcPrompt({ name: "foo", text: "bad", sessionId: "missing" }, socket),
    ).rejects.toThrow("missing");
    expect(runtimes.get("foo")!.getStatus().sessionId).toBe(defaultId);
    const second = rpcPrompt({ name: "foo", text: "second", newSession: true }, socket);
    await complete("second answer", 2);
    const temporary = (await second).sessionId!;
    expect(temporary).not.toBe(defaultId);
    expect(daemon.getProjectStatus("foo").defaultSessionId).toBe(defaultId);
    expect(sent("A").filter((text) => text.includes("当前会话已切换"))).toHaveLength(1);
    const wx = inbound("B", "uses active");
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(3));
    expect(runtimes.get("foo")!.getStatus().sessionId).toBe(temporary);
    runtimes.get("foo")!.complete("wx answer");
    await wx;
    const back = rpcPrompt({ name: "foo", text: "default again" }, socket);
    await complete("default answer", 4);
    expect((await back).sessionId).toBe(defaultId);
    expect(sent("A").filter((text) => text.includes("当前会话已切换"))).toHaveLength(2);
    const explicit = rpcPrompt({ name: "foo", text: "temporary", sessionId: temporary }, socket);
    await complete("explicit", 5);
    expect((await explicit).sessionId).toBe(temporary);
    expect(sent("A").filter((text) => text.includes("当前会话已切换"))).toHaveLength(3);
  });

  it("deduplicates reply combinations and distinguishes execution failures from delivery failures", async () => {
    const first = rpcPrompt(
      { name: "foo", text: "hello", reply: ["caller", "user:all", "user:user-A", "user:all"] },
      socket,
    );
    await complete("combined", 1);
    expect(await first).toMatchObject({
      text: "combined",
      status: "success",
      delivery: { succeeded: 2, skipped: 0, failed: 0 },
    });
    expect(sent("A")).toEqual(["combined"]);
    expect(sent("B")).toEqual(["combined"]);
    vi.spyOn(transports.get("B")!, "sendText").mockRejectedValueOnce(
      new Error("delivery unavailable"),
    );
    const second = rpcPrompt({ name: "foo", text: "delivery", reply: ["user:all"] }, socket);
    await complete("not echoed", 2);
    const result = await second;
    expect(result).toMatchObject({
      status: "success",
      delivery: { succeeded: 1, skipped: 0, failed: 1 },
    });
    expect(result.text).toBeUndefined();
    const third = rpcPrompt({ name: "foo", text: "execution" }, socket);
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(3));
    runtimes.get("foo")!.completeWithError("provider failure");
    expect(await third).toMatchObject({ status: "error", error: "provider failure" });
    expect(sent("A")).not.toContain("provider failure");
    runtimes.get("foo")!.startIndependentTurn();
    runtimes.get("foo")!.completeIndependentTurn("independent");
    await vi.waitFor(() => expect(sent("B")).toContain("independent"));
    expect(sent("A").filter((text) => text === "independent")).toHaveLength(1);
  });

  it("refuses busy cross-session requests, preserves other-project execution, and rejects invalid input", async () => {
    for (const request of [
      { name: "foo", text: "  " },
      { name: "absent", text: "x" },
      { name: "foo", text: "x", reply: [] },
      { name: "foo", text: "x", reply: ["bad"] },
    ])
      await expect(rpcPrompt(request, socket)).rejects.toThrow();
    await new ControlStore(store).project("disable", "bar");
    await daemon.reload();
    await expect(rpcPrompt({ name: "bar", text: "x" }, socket)).rejects.toThrow("disabled");
    await new ControlStore(store).project("enable", "bar");
    await daemon.reload();
    const busy = rpcPrompt({ name: "foo", text: "busy" }, socket);
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(1));
    await expect(
      rpcPrompt({ name: "foo", text: "other", newSession: true }, socket),
    ).rejects.toThrow("正在执行");
    const bar = rpcPrompt({ name: "bar", text: "parallel" }, socket);
    await complete("bar", 1, "bar");
    expect((await bar).text).toBe("bar");
    runtimes.get("foo")!.complete("foo");
    await busy;
  });

  it("returns CLI questions, accepts another local CLI answer, and keeps original reply/session", async () => {
    await inbound("A", "/new");
    const defaultId = daemon.getProjectStatus("foo").defaultSessionId;
    const pending = rpcPrompt({ name: "foo", text: "question", newSession: true }, socket);
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(1));
    const ui = new WeixinUIContext({ interaction: contexts.get("foo")!.interaction, logger });
    const confirm = ui.confirm("Proceed?", "Please confirm");
    const waiting = await pending;
    expect(waiting.sessionId).not.toBe(defaultId);
    expect(waiting).toMatchObject({
      status: "waiting",
      messages: [expect.stringContaining("Proceed?")],
    });
    expect(sent("A").some((text) => text.includes("Proceed?"))).toBe(false);
    await inbound("A", "yes");
    expect(contexts.get("foo")!.interaction.isUiInteractionActive()).toBe(true);
    for (const change of [{ newSession: true }, { sessionId: "another" }])
      await expect(rpcPrompt({ name: "foo", text: "yes", ...change }, socket)).rejects.toThrow(
        "正在执行",
      );
    const answer = rpcPrompt({ name: "foo", text: "yes", reply: ["user:all"] }, socket);
    expect(await confirm).toBe(true);
    runtimes.get("foo")!.complete("original caller");
    expect(await answer).toMatchObject({
      status: "success",
      text: "original caller",
      sessionId: waiting.sessionId,
    });
    expect(runtimes.get("foo")!.prompts).toHaveLength(1);
    expect(sent("B")).not.toContain("original caller");
  });

  it("does not allow CLI to answer Weixin UI, and does not auto-approve timeout or cancellation", async () => {
    const pending = inbound("A", "wx question");
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(1));
    const ui = new WeixinUIContext({ interaction: contexts.get("foo")!.interaction, logger });
    const confirm = ui.confirm("wx", "question", { timeout: 100 });
    await vi.waitFor(() =>
      expect(contexts.get("foo")!.interaction.isUiInteractionActive()).toBe(true),
    );
    await expect(rpcPrompt({ name: "foo", text: "yes" }, socket)).rejects.toThrow("正在执行");
    expect(await confirm).toBe(false);
    runtimes.get("foo")!.complete("denied");
    await pending;
    const cli = rpcPrompt({ name: "foo", text: "cli question" }, socket);
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(2));
    const cancellation = ui.input("input", undefined, { timeout: 20 });
    expect((await cli).status).toBe("waiting");
    expect(await cancellation).toBeUndefined();
    runtimes.get("foo")!.complete("cancelled");
    await vi.waitFor(() => expect(daemon.getProjectStatus("foo").state).toBe("idle"));
  });

  it("persists empty SDK sessions in daemon state without writing config and resumes after restart", async () => {
    const originalConfig = fs.readFileSync(store.configPath, "utf8");
    await inbound("A", "/new");
    const id = daemon.getProjectStatus("foo").defaultSessionId!;
    expect((await runtimes.get("foo")!.listSessions()).map((item) => item.id)).toContain(id);
    await inbound("A", "/new");
    expect(daemon.getProjectStatus("foo").sessionId).not.toBe(id);
    await daemon.stop();
    daemon = buildDaemon();
    await daemon.start();
    expect(runtimes.get("foo")!.hasSession()).toBe(false);
    const pending = rpcPrompt({ name: "foo", text: "after restart" }, socket);
    await complete("resumed", 1);
    expect((await pending).sessionId).toBe(id);
    expect(sent("A")).toEqual([]);
    expect(fs.readFileSync(store.configPath, "utf8")).toBe(originalConfig);
    expect(new ProjectStateStore().getDefaultSession("foo", store.get("foo")!.cwd)).toBe(id);
  });

  it("forgets observed project deletion and never reuses a different cwd's default", async () => {
    await inbound("A", "/new");
    const oldCwd = store.get("foo")!.cwd;
    const config = store.get("foo")!;
    const cwd = path.join(root, "recreated");
    fs.mkdirSync(cwd);
    store.remove("foo");
    store.upsert("foo", { ...config, cwd });
    await daemon.reload();
    expect(daemon.getProjectStatus("foo").defaultSessionId).toBeUndefined();
    expect(new ProjectStateStore().getDefaultSession("foo", oldCwd)).toBeUndefined();
    await inbound("A", "/new");
    expect(new ProjectStateStore().getDefaultSession("foo", cwd)).toBeDefined();
    await new ControlStore(store).project("remove", "foo");
    await daemon.reload();
    expect(new ProjectStateStore().read().projects.foo).toBeUndefined();
  });

  it("reads legacy config defaults as fallback, with same-cwd daemon state taking precedence", async () => {
    await inbound("A", "/new");
    const id = daemon.getProjectStatus("foo").defaultSessionId!;
    await daemon.stop();
    fs.unlinkSync(new ProjectStateStore().statePath);
    store.upsert("foo", { ...store.get("foo")!, defaultSessionId: id });
    const config = fs.readFileSync(store.configPath, "utf8");
    daemon = buildDaemon();
    await daemon.start();
    const pending = rpcPrompt({ name: "foo", text: "legacy" }, socket);
    await complete("resumed", 1);
    expect((await pending).sessionId).toBe(id);
    await inbound("A", "/new");
    await inbound("A", "/default");
    const replacement = daemon.getProjectStatus("foo").defaultSessionId!;
    expect(replacement).not.toBe(id);
    await daemon.stop();
    daemon = buildDaemon();
    await daemon.start();
    expect(daemon.getProjectStatus("foo").defaultSessionId).toBe(replacement);
    expect(fs.readFileSync(store.configPath, "utf8")).toBe(config);
  });

  it("caller-only CLI can send project files to all or one user with exact tokens", async () => {
    const pending = rpcPrompt({ name: "foo", text: "send files" }, socket);
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(1));
    const ctx = contexts.get("foo")!;
    const registered: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
    createWeixinSendFileExtension({
      fileSender: new WeixinFileSender(ctx.transport),
      getCurrentTurn: () => ctx.interaction.getCurrentTurn(),
      resolveRecipients: ctx.resolveFileRecipients,
      cwd: ctx.cwd,
      logger,
    })({ registerTool: (tool) => registered.push(tool) } as ExtensionAPI);
    const execute = registered[0]!.execute;
    fs.writeFileSync(path.join(ctx.cwd, "report.txt"), "report");
    const call = (params: { path: string; userId?: string }) =>
      execute("file", params, new AbortController().signal, undefined, {} as never);
    await call({ path: "report.txt" });
    for (const id of ["A", "B"])
      expect(transports.get(id)!.sentFiles[0]?.ctx).toMatchObject({
        accountId: id,
        senderId: `user-${id}`,
        contextToken: `exact-${id}`,
      });
    await call({ path: "report.txt", userId: "user-B" });
    expect(transports.get("A")!.sentFiles).toHaveLength(1);
    expect(transports.get("B")!.sentFiles).toHaveLength(2);
    await expect(call({ path: "report.txt", userId: "user-C" })).rejects.toThrow("does not belong");
    runtimes.get("foo")!.complete("files sent");
    expect((await pending).text).toBe("files sent");
    expect(sent("A")).toEqual([]);
  });

  it("keeps CLI select/input answers in the original turn without changing reply", async () => {
    const pending = rpcPrompt({ name: "foo", text: "interactive", reply: ["user:user-A"] }, socket);
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(1));
    const ui = new WeixinUIContext({ interaction: contexts.get("foo")!.interaction, logger });
    const selection = ui.select("choose", ["red", "blue"]);
    expect((await pending).status).toBe("waiting");
    const second = rpcPrompt({ name: "foo", text: "2" }, socket);
    expect(await selection).toBe("blue");
    const input = ui.input("name");
    expect(await second).toMatchObject({
      status: "waiting",
      messages: expect.arrayContaining([expect.stringContaining("name")]),
    });
    const third = rpcPrompt({ name: "foo", text: "Alice", reply: ["caller"] }, socket);
    expect(await input).toBe("Alice");
    runtimes.get("foo")!.complete("chosen");
    const result = await third;
    expect(result.text).toBeUndefined();
    expect(result).toMatchObject({
      status: "success",
      delivery: { succeeded: 1, failed: 0, skipped: 0 },
    });
    expect(sent("A")).toEqual(["chosen"]);
    expect(sent("B")).toEqual([]);
    expect(runtimes.get("foo")!.prompts).toHaveLength(1);
  });

  it("rejects missing default after restart until explicitly creating and setting a replacement", async () => {
    await inbound("A", "/new");
    const missing = daemon.getProjectStatus("foo").defaultSessionId!;
    fs.unlinkSync(runtimes.get("foo")!.getStatus().sessionFile!);
    await daemon.stop();
    daemon = buildDaemon();
    await daemon.start();
    await expect(rpcPrompt({ name: "foo", text: "continue" }, socket)).rejects.toThrow(missing);
    expect(runtimes.get("foo")!.hasSession()).toBe(false);
    const replacement = rpcPrompt({ name: "foo", text: "repair", newSession: true }, socket);
    await complete("new", 1);
    const id = (await replacement).sessionId!;
    expect(daemon.getProjectStatus("foo").defaultSessionId).toBe(missing);
    await inbound("A", "/default");
    expect(daemon.getProjectStatus("foo").defaultSessionId).toBe(id);
    await expect(rpcCall("project.sessions", { name: "foo" }, socket)).rejects.toThrow(
      "unknown rpc",
    );
  });

  it("reports skipped reply targets and does not undo an activated session when notification fails", async () => {
    clearContextTokensForAccount("B");
    vi.spyOn(transports.get("A")!, "sendText").mockRejectedValueOnce(
      new Error("switch notice failed"),
    );
    const pending = rpcPrompt(
      { name: "foo", text: "continue", newSession: true, reply: ["user:all"] },
      socket,
    );
    await complete("result", 1);
    const result = await pending;
    expect(result).toMatchObject({
      status: "success",
      delivery: { succeeded: 1, skipped: 1, failed: 0 },
    });
    expect(result.sessionId).toBe(daemon.getProjectStatus("foo").sessionId);
  });

  it("client disconnect does not cancel work and shutdown resolves a still-waiting caller", async () => {
    const connection = net.connect(socket);
    await new Promise<void>((resolve) => connection.once("connect", resolve));
    connection.write(
      `${JSON.stringify({
        id: 1,
        method: "project.prompt",
        params: { name: "foo", text: "disconnected" },
      })}\n`,
    );
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(1));
    connection.destroy();
    runtimes.get("foo")!.complete("done after disconnect");
    await vi.waitFor(() => expect(daemon.getProjectStatus("foo").state).toBe("idle"));
    const pending = rpcPrompt({ name: "foo", text: "stop" }, socket);
    await vi.waitFor(() => expect(runtimes.get("foo")!.prompts).toHaveLength(2));
    await daemon.stop();
    expect(await pending).toMatchObject({ status: "error", error: "session stopped" });
    await expect(rpcPrompt({ name: "foo", text: "daemon down" }, socket)).rejects.toThrow(
      "not running",
    );
  });

  it("handles large fragmented UDS request and response bodies without truncation", async () => {
    const text = "测试".repeat(100_000);
    const pending = rpcPrompt({ name: "foo", text }, socket);
    await complete(text, 1);
    expect((await pending).text).toBe(text);
    expect(runtimes.get("foo")!.prompts[0]?.text).toBe(text);
  });
});
