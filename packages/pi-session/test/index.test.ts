import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piSession from "../src/index.js";
import type { TaskReport } from "../src/tasks.js";

const mocks = vi.hoisted(() => ({
  runtimes: [] as { ask: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
}));
vi.mock("../src/tasks.js", () => ({
  SessionTasks: class {
    ask = vi.fn(async () => ({ status: "accepted" }));
    close = vi.fn();
    constructor() {
      mocks.runtimes.push(this);
    }
  },
}));

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => Promise<{ action?: string; text?: string } | undefined> | undefined;
function harness(cwd: string, mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const addAutocompleteProvider = vi.fn();
  const sendMessage = vi.fn();
  const sessionManager = SessionManager.create(cwd);
  const ctx = {
    cwd,
    mode,
    sessionManager,
    ui: { addAutocompleteProvider, notify: vi.fn() },
  } as unknown as ExtensionContext;
  const registerTool = vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool));
  const pi = {
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerTool,
    sendMessage,
  } as unknown as ExtensionAPI;
  piSession(pi);
  return { ctx, handlers, tools, sendMessage, addAutocompleteProvider, registerTool };
}

let root: string;
let cwd: string;
let other: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-session-extension-"));
  cwd = join(root, "project with spaces");
  other = join(root, "other");
  await Promise.all([mkdir(cwd), mkdir(other)]);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
  mocks.runtimes.length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function saved(project: string, name: string) {
  const session = SessionManager.create(project);
  session.appendMessage({ role: "user", content: "history needle", timestamp: Date.now() });
  session.appendSessionInfo(name);
  return session;
}

const modes = ["tui", "rpc", "json", "print"] as const;

it.each(modes)("registers tools at factory time and starts idempotently in %s", async (mode) => {
  const target = saved(cwd, "Notes");
  const h = harness(cwd, mode);
  expect(h.registerTool).toHaveBeenCalledTimes(2);
  expect(mocks.runtimes).toHaveLength(0);
  const search = () =>
    h.tools
      .get("search-session")!
      .execute("tool", { query: "needle" }, undefined, undefined, h.ctx as ExtensionToolContext);
  await expect(search()).rejects.toThrow("active caller session");
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.handlers.get("session_start")!({}, h.ctx);
  expect(h.addAutocompleteProvider).toHaveBeenCalledTimes(1);
  expect(h.registerTool).toHaveBeenCalledTimes(2);
  expect(mocks.runtimes).toHaveLength(1);
  expect((await search()).details).toMatchObject({ sessions: [{ id: target.getSessionId() }] });
  await h.tools
    .get("ask-session")!
    .execute(
      "tool",
      { id: target.getSessionId(), prompt: "hello" },
      undefined,
      undefined,
      h.ctx as ExtensionToolContext,
    );
  expect(mocks.runtimes[0].ask).toHaveBeenCalledOnce();
  await h.handlers.get("session_shutdown")!({}, h.ctx);
  await h.handlers.get("session_shutdown")!({}, h.ctx);
  expect(mocks.runtimes[0].close).toHaveBeenCalledOnce();
  await expect(search()).rejects.toThrow("active caller session");
});

it.each(modes)("tolerates autocomplete and notify failures in %s", async (mode) => {
  const h = harness(cwd, mode);
  h.addAutocompleteProvider.mockImplementation(() => {
    throw new Error("no editor");
  });
  vi.mocked(h.ctx.ui.notify).mockImplementation(() => {
    throw new Error("no notification");
  });
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.handlers.get("session_start")!({}, h.ctx);
  expect(h.addAutocompleteProvider).toHaveBeenCalledOnce();
  expect(h.ctx.ui.notify).toHaveBeenCalledOnce();
  await expect(
    h.tools
      .get("ask-session")!
      .execute(
        "tool",
        { id: "target", prompt: "hello" },
        undefined,
        undefined,
        h.ctx as ExtensionToolContext,
      ),
  ).resolves.toMatchObject({ details: { status: "accepted" } });
});

it.each(modes)("expands interactive/rpc input but skips extension input in %s", async (mode) => {
  const target = saved(cwd, "Notes");
  const h = harness(cwd, mode);
  const input = `@s:${target.getSessionId()}`;
  for (const source of ["interactive", "rpc", "extension"]) {
    const result = await h.handlers.get("input")!({ text: input, source }, h.ctx);
    expect(result).toEqual(
      source === "extension"
        ? { action: "continue" }
        : {
            action: "transform",
            text: `Read or search Notes ${target.getSessionFile()} if more context is needed.`,
          },
    );
  }
});

it("keeps input unchanged even when enumeration and warning both fail", async () => {
  const h = harness(cwd, "rpc");
  const list = vi.spyOn(SessionManager, "list").mockRejectedValue(new Error("enumeration failed"));
  vi.mocked(h.ctx.ui.notify).mockImplementation(() => {
    throw new Error("notify failed");
  });
  try {
    expect(await h.handlers.get("input")!({ text: "@s:unknown", source: "rpc" }, h.ctx)).toEqual({
      action: "continue",
    });
    expect(h.ctx.ui.notify).toHaveBeenCalledOnce();
  } finally {
    list.mockRestore();
  }
});

it("discovers real SDK sessions, refreshes names, inserts IDs and expands only interactive input", async () => {
  const local = saved(cwd, "Design notes");
  const external = saved(other, "Design elsewhere");
  const h = harness(cwd);
  await h.handlers.get("session_start")!({}, h.ctx);
  const original = { getSuggestions: vi.fn(async () => null), applyCompletion: vi.fn() };
  const provider = h.addAutocompleteProvider.mock.calls[0][0](original);
  const options = { signal: new AbortController().signal };
  const localResults = await provider.getSuggestions(["@s:Design"], 0, 9, options);
  expect(localResults.items.map((x: { value: string }) => x.value)).toEqual([
    `@s:${local.getSessionId()}`,
  ]);
  expect((await provider.getSuggestions(["@as:Design"], 0, 10, options)).items).toHaveLength(2);
  local.appendSessionInfo("Renamed notes");
  expect((await provider.getSuggestions(["@s:Renamed"], 0, 10, options)).items[0].label).toBe(
    "Renamed notes",
  );
  const input = `before @s:${local.getSessionId()}\n@as:${external.getSessionId()} after`;
  const result = await h.handlers.get("input")!({ text: input, source: "interactive" }, h.ctx);
  expect(result?.action).toBe("transform");
  expect(result?.text).toBe(
    `before Read or search Renamed notes ${local.getSessionFile()} if more context is needed.\nRead or search Design elsewhere ${external.getSessionFile()} if more context is needed. after`,
  );
  expect(await h.handlers.get("input")!({ text: input, source: "extension" }, h.ctx)).toEqual({
    action: "continue",
  });
  expect(h.sendMessage).not.toHaveBeenCalled();
});

describe("tool registration boundary", () => {
  it("invalidates reports before slow shutdown completes, including a restart with the same caller ID", async () => {
    const h = harness(cwd, "rpc");
    await h.handlers.get("session_start")!({}, h.ctx);
    const runtime = mocks.runtimes[0];
    await h.tools
      .get("ask-session")!
      .execute(
        "tool",
        { id: "target", prompt: "hello" },
        undefined,
        undefined,
        h.ctx as ExtensionToolContext,
      );
    const report = runtime.ask.mock.calls[0][1] as (value: TaskReport) => void;
    const value: TaskReport = {
      id: "target",
      cwd,
      path: "/target.jsonl",
      status: "failed",
      text: "failed",
    };
    report(value);
    expect(h.sendMessage.mock.calls[0][0].content).toContain(
      "For related follow-up work, reuse ask-session with this full session ID.",
    );
    let finishCleanup!: () => void;
    runtime.close.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
    );
    const shutdown = h.handlers.get("session_shutdown")!({}, h.ctx);
    report(value);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    await h.handlers.get("session_start")!({}, h.ctx);
    report(value);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    finishCleanup();
    await shutdown;
    expect(mocks.runtimes).toHaveLength(2);
    expect(h.registerTool).toHaveBeenCalledTimes(2);
  });
  it.each([
    [
      "accepted",
      (id: string) =>
        `Accepted background task for session ${id}.\nReports arrive automatically; do not poll, redo, or re-delegate accepted work.\nWhile relevant reports are pending, give only a brief progress update identifying the pending sessions, then end your turn. Give the final answer only after all relevant reports arrive.`,
    ],
    [
      "steered",
      (id: string) =>
        `Steering queued for session ${id}. Continue waiting for the original task's report; no separate report is created.`,
    ],
    [
      "handled",
      (_id: string) =>
        "Instructions were handled by the target's input handler, not queued as steering. This response is not a completion report and does not confirm that the original task is still active.",
    ],
  ])("preserves %s JSON/details and appends status-specific guidance", async (status, guidance) => {
    const h = harness(cwd, "rpc");
    await h.handlers.get("session_start")!({}, h.ctx);
    const id = saved(cwd, "Target").getSessionId();
    const value = { status, id, path: "/target.jsonl" };
    mocks.runtimes[0].ask.mockResolvedValue(value);
    const result = await h.tools
      .get("ask-session")!
      .execute(
        "tool",
        { id, prompt: "hello", steer: status !== "accepted" },
        undefined,
        undefined,
        h.ctx as ExtensionToolContext,
      );
    expect(result.details).toEqual(value);
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(value) });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: "text", text: guidance(id) });
    expect(h.tools.get("ask-session")!.description).toContain(
      "Runs in the background and reports completion or failure automatically. Do not poll or repeat accepted work. Use steer=true to adjust an active task; ask again after completion for follow-up work.",
    );
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
  it("searches selected cwd and rejects unauthorized cwd before starting ask", async () => {
    const target = saved(cwd, "Notes");
    const h = harness(cwd);
    await h.handlers.get("session_start")!({}, h.ctx);
    const search = h.tools.get("search-session")!;
    const result = await search.execute(
      "tool",
      { query: "needle", cwd: "" },
      undefined,
      undefined,
      h.ctx as ExtensionToolContext,
    );
    expect(result.details).toMatchObject({ sessions: [{ id: target.getSessionId() }] });
    await expect(
      h.tools
        .get("ask-session")!
        .execute(
          "tool",
          { id: "id", prompt: "hello", cwd: other },
          undefined,
          undefined,
          h.ctx as ExtensionToolContext,
        ),
    ).rejects.toThrow("Unauthorized");
    expect(mocks.runtimes[0].ask).not.toHaveBeenCalled();
  });

  it.each(modes)(
    "reports only to the originating lifecycle and restarts after shutdown in %s",
    async (mode) => {
      const h = harness(cwd, mode);
      await h.handlers.get("session_start")!({}, h.ctx);
      const runtime = mocks.runtimes[0];
      await h.tools
        .get("ask-session")!
        .execute(
          "tool",
          { id: "target", prompt: "hello" },
          undefined,
          undefined,
          h.ctx as ExtensionToolContext,
        );
      expect(runtime.ask.mock.calls[0][0]).toMatchObject({
        cwd,
        id: "target",
        callerId: h.ctx.sessionManager.getSessionId(),
      });
      const report = runtime.ask.mock.calls[0][1] as (value: TaskReport) => void;
      const value: TaskReport = {
        id: "target",
        cwd,
        path: "/session.jsonl",
        text: "answer",
        status: "completed",
      };
      report(value);
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sendMessage.mock.calls[0][0].content).toContain(
        "For related follow-up work, reuse ask-session with this full session ID.",
      );
      expect(h.sendMessage.mock.calls[0][0].details).toEqual(value);
      expect(h.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      expect(runtime.close).toHaveBeenCalledTimes(1);
      report(value);
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      const newCtx = { ...h.ctx, cwd: other, sessionManager: SessionManager.create(other) };
      await h.handlers.get("session_start")!({}, newCtx);
      expect(h.addAutocompleteProvider).toHaveBeenCalledTimes(2);
      report(value);
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
    },
  );
});
