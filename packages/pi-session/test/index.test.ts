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
  const pi = {
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    sendMessage,
  } as unknown as ExtensionAPI;
  piSession(pi);
  return { ctx, handlers, tools, sendMessage, addAutocompleteProvider };
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

it("installs only in TUI and does not duplicate registrations on repeated startup", async () => {
  for (const mode of ["print", "rpc", "json"] as const) {
    const h = harness(cwd, mode);
    await h.handlers.get("session_start")!({}, h.ctx);
    expect(h.addAutocompleteProvider).not.toHaveBeenCalled();
    expect(h.tools.size).toBe(0);
  }
  const h = harness(cwd);
  await h.handlers.get("session_start")!({}, h.ctx);
  await h.handlers.get("session_start")!({}, h.ctx);
  expect(h.addAutocompleteProvider).toHaveBeenCalledTimes(1);
  expect(h.tools.size).toBe(2);
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

  it("reports only to the originating lifecycle, closes on shutdown and re-registers after reload", async () => {
    const h = harness(cwd);
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
  });
});
