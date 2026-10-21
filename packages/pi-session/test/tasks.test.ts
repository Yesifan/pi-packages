import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { SessionTasks, type TaskReport, type TaskSession } from "../src/tasks.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: vi.fn(),
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fake() {
  const done = deferred();
  const session = {
    prompt: vi.fn(() => done.promise),
    steer: vi.fn(async () => "queued" as const),
    dispose: vi.fn(),
    getLastAssistantText: () => "answer",
    messages: [],
    isStreaming: true as boolean,
  } satisfies TaskSession;
  return { session, done };
}
const target = { id: "full-target-id", cwd: "/target", path: "/target/session.jsonl" };
const request = { ...target, prompt: "question", callerId: "caller" };
const runtimes: SessionTasks[] = [];
function runtime(load: () => Promise<TaskSession>) {
  const tasks = new SessionTasks({ find: () => target, load });
  runtimes.push(tasks);
  return tasks;
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((tasks) => tasks.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("accepts immediately, reserves during loading, and rejects loading steering", async () => {
  const loading = deferred<TaskSession>();
  const tasks = runtime(() => loading.promise);
  const report = vi.fn();
  expect(await tasks.ask(request, report)).toMatchObject({ status: "accepted" });
  await expect(tasks.ask(request, report)).rejects.toThrow("busy");
  await expect(tasks.ask({ ...request, steer: true }, report)).rejects.toThrow("loading");
  const { session, done } = fake();
  loading.resolve(session);
  await vi.waitFor(() =>
    expect(session.prompt).toHaveBeenCalledWith("question", { source: "extension" }),
  );
  done.resolve();
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ status: "completed", id: target.id, path: target.path }),
  );
  expect(session.dispose).toHaveBeenCalledOnce();
});

it("steers through SDK with extension source, no separate report, and rejects missing/current sessions", async () => {
  const { session, done } = fake();
  const tasks = runtime(async () => session);
  const report = vi.fn();
  const steerReport = vi.fn();
  await expect(tasks.ask({ ...request, callerId: target.id }, report)).rejects.toThrow("current");
  await expect(tasks.ask({ ...request, steer: true }, report)).rejects.toThrow("No active");
  await tasks.ask(request, report);
  await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
  expect(await tasks.ask({ ...request, prompt: "adjust", steer: true }, steerReport)).toMatchObject(
    { status: "steered" },
  );
  expect(session.steer).toHaveBeenCalledWith("adjust", undefined, { source: "extension" });
  session.isStreaming = false;
  await expect(tasks.ask({ ...request, steer: true }, report)).rejects.toThrow("not streaming");
  done.resolve();
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  expect(steerReport).not.toHaveBeenCalled();
  await expect(tasks.ask({ ...request, steer: true }, report)).rejects.toThrow("No active");
});

it.each(["finished", "closed", "idle"])(
  "rejects queued steering when input handling races with %s",
  async (phase) => {
    const { session, done } = fake();
    const steering = deferred<"queued">();
    session.steer.mockImplementation(() => steering.promise);
    const tasks = runtime(async () => session);
    const report = vi.fn();
    await tasks.ask(request, report);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
    const pending = tasks.ask({ ...request, steer: true }, vi.fn());
    if (phase === "finished") {
      done.resolve();
      await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
      // A new task with the same ID must not validate the old steering request.
      await tasks.ask(request, report);
    } else if (phase === "closed") {
      await tasks.close();
    } else {
      session.isStreaming = false;
    }
    steering.resolve("queued");
    await expect(pending).rejects.toThrow("stopped before steering");
    done.resolve();
  },
);

it.each(["completed", "closed", "loading", "bind failed"])(
  "awaits shutdown before disposal on default SDK load: %s",
  async (phase) => {
    const { session, done } = fake();
    const binding = deferred();
    const shutdown = deferred();
    const bindExtensions = vi.fn(() => binding.promise);
    const emit = vi.fn(() => shutdown.promise);
    const sdkSession = { ...session, bindExtensions, extensionRunner: { emit } };
    vi.mocked(createAgentSession).mockResolvedValue({
      session: sdkSession as unknown as AgentSession,
    } as Awaited<ReturnType<typeof createAgentSession>>);
    vi.spyOn(SessionManager, "open").mockReturnValue(SessionManager.inMemory());
    const tasks = new SessionTasks({ find: () => target });
    runtimes.push(tasks);
    const report = vi.fn();
    await tasks.ask(request, report);
    await vi.waitFor(() => expect(bindExtensions).toHaveBeenCalledOnce());
    let closing: Promise<void> | undefined;
    if (phase === "loading") closing = tasks.close();
    if (phase === "bind failed") binding.reject(new Error("bind failed"));
    else binding.resolve();
    if (phase === "completed" || phase === "closed") {
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
      if (phase === "completed") done.resolve();
      else closing = tasks.close();
    }
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" }),
    );
    expect(session.dispose).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    if (closing) expect(tasks.close()).toBe(closing);
    shutdown.resolve();
    await closing;
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
    done.resolve();
    if (phase === "completed" || phase === "bind failed") {
      await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          status: phase === "completed" ? "completed" : "failed",
        }),
      );
    } else expect(report).not.toHaveBeenCalled();
    await tasks.close();
    expect(emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  },
);

it("clears loading and prompt failures so a later ask loads afresh", async () => {
  const first = fake();
  const second = fake();
  const load = vi
    .fn<() => Promise<TaskSession>>()
    .mockRejectedValueOnce(new Error("load failed"))
    .mockResolvedValueOnce(first.session)
    .mockResolvedValueOnce(second.session);
  const tasks = runtime(load);
  const report = vi.fn();
  await tasks.ask(request, report);
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", text: "load failed" }),
    ),
  );
  await tasks.ask(request, report);
  first.done.reject(new Error("run failed"));
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", text: "run failed" }),
    ),
  );
  expect(first.session.dispose).toHaveBeenCalledOnce();
  await tasks.ask(request, report);
  second.done.resolve();
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3));
  expect(load).toHaveBeenCalledTimes(3);
});

it.each(["loading", "running"])("close during %s disposes without late reports", async (phase) => {
  const { session, done } = fake();
  const loading = deferred<TaskSession>();
  const tasks = runtime(() => loading.promise);
  const report = vi.fn();
  await tasks.ask(request, report);
  if (phase === "running") {
    loading.resolve(session);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
  }
  tasks.close();
  tasks.close();
  loading.resolve(session);
  done.resolve();
  await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
  expect(report).not.toHaveBeenCalled();
  await expect(tasks.ask(request, report)).rejects.toThrow("closed");
});

it("reports terminal model error even if SDK prompt resolves", async () => {
  const { session, done } = fake();
  const messages: TaskSession["messages"] = [];
  const tasks = runtime(async () => ({ ...session, messages }));
  const report = vi.fn();
  await tasks.ask(request, report);
  await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
  messages.push({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    timestamp: 1,
    stopReason: "error",
    errorMessage: "model failed",
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  done.resolve();
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", text: "model failed" }),
    ),
  );
});

it("reopens the same real SDK file for each run and binds reporting to each caller callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-tasks-"));
  try {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    const cwd = join(root, "project");
    await mkdir(cwd);
    const original = SessionManager.create(cwd);
    original.appendMessage({ role: "user", content: "existing", timestamp: 1 });
    const tasks = new SessionTasks({
      load: async (found) => {
        const manager = SessionManager.open(found.path);
        return {
          messages: [],
          isStreaming: false,
          prompt: async (text) => {
            manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
          },
          steer: async () => "queued",
          dispose: vi.fn(),
          getLastAssistantText: () => "saved",
        };
      },
    });
    runtimes.push(tasks);
    const first = vi.fn<(result: TaskReport) => void>();
    const second = vi.fn<(result: TaskReport) => void>();
    const input = { id: original.getSessionId(), cwd, prompt: "first", callerId: "caller" };
    await tasks.ask(input, first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    await tasks.ask({ ...input, prompt: "second" }, second);
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(first).toHaveBeenCalledOnce();
    const reopened = SessionManager.open(original.getSessionFile()!);
    expect(reopened.getSessionId()).toBe(input.id);
    expect(reopened.getEntries().filter((entry) => entry.type === "message")).toHaveLength(3);
    expect(await SessionManager.list(cwd)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
