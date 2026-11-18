import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildSessionFactory } from "../../src/child-session.js";
import { SubagentError } from "../../src/errors.js";
import { PersistentSubagentStore } from "../../src/store.js";
import type { RootUiBroker } from "../../src/ui.js";
import { createHarness, deferred } from "../helpers/runtime-harness.js";

interface Call {
  finish(text: string, reason?: AssistantMessage["stopReason"]): void;
}
interface Control {
  calls: Call[];
  prompts: Promise<void>[];
  finishUnexpectedCalls?: boolean;
  disposed: Map<string, ReturnType<typeof deferred<void>>>;
  waiters: Map<number, ReturnType<typeof deferred<void>>>;
  pause?: { reached: ReturnType<typeof deferred<void>>; resume: ReturnType<typeof deferred<void>> };
  inputPause?: {
    reached: ReturnType<typeof deferred<void>>;
    resume: ReturnType<typeof deferred<void>>;
  };
}
const KEY = "__piSubagentsRuntimeSdkLifecycle";
afterEach(() => {
  Reflect.deleteProperty(globalThis, KEY);
});
async function realHarness() {
  const h = await createHarness();
  const control: Control = { calls: [], prompts: [], disposed: new Map(), waiters: new Map() };
  Reflect.set(globalThis, KEY, control);
  const model = {
    id: "local-model",
    name: "Local model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  const config = {
    api: "runtime-gate",
    apiKey: "local-test",
    baseUrl: "https://unused.invalid",
    models: [model],
  };
  await writeFile(
    path.join(h.agentDir, "models.json"),
    JSON.stringify({ providers: { "runtime-gate": config } }),
  );
  const aiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  const extension = `
import { createAssistantMessageEventStream } from ${JSON.stringify(aiPath)};
export default function(pi) {
  pi.registerProvider("runtime-gate", {
    ...${JSON.stringify(config)},
    streamSimple(model, context, options) {
      const state = globalThis[${JSON.stringify(KEY)}];
      const stream = createAssistantMessageEventStream();
      let ended = false;
      const finish = (text, stopReason = "stop") => {
        if (ended) return;
        ended = true;
        options?.signal?.removeEventListener("abort", abort);
        const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (stopReason === "aborted" || stopReason === "error") stream.push({ type: "error", reason: stopReason, error: message });
        else stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      };
      const abort = () => finish("", "aborted");
      options?.signal?.addEventListener("abort", abort, { once: true });
      const index = state.calls.push({ finish }) - 1;
      state.waiters.get(index)?.resolve();
      // Regression tests must fail on provider count, not hang waiting for a rogue run.
      if (state.finishUnexpectedCalls) finish("unexpected provider call");
      return stream;
    }
  });
  pi.registerCommand("fixture-command", { description: "fixture", handler: async () => {} });
  pi.on("input", async (event) => {
    if (event.text === "consume") return { action: "handled" };
    const pause = globalThis[${JSON.stringify(KEY)}].inputPause;
    if (pause && (event.text === "late steer" || event.text === "late input")) { pause.reached.resolve(); await pause.resume.promise; }
    return { action: "continue" };
  });
  pi.on("before_agent_start", async () => {
    const state = globalThis[${JSON.stringify(KEY)}];
    if (state.pause) { const pause = state.pause; pause.reached.resolve(); await pause.resume.promise; }
  });
}
`;
  for (const cwd of [h.cwd, h.external]) {
    const extensions = path.join(cwd, ".pi", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, "local-runtime.js"), extension);
    await writeFile(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        cacheWarming: "off",
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(h.agentDir, "auth.json"),
    modelsPath: path.join(h.agentDir, "models.json"),
  });
  Object.assign(h.ctx, {
    model: modelRuntime.getModel("runtime-gate", "local-model") as Model<Api>,
  });
  const factory = new ChildSessionFactory(
    h.agentDir,
    path.join(h.root, "extension.js"),
    Reflect.get(h.runtime, "uiBroker") as RootUiBroker,
    async () => true,
  );
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "open").mockImplementation(async (options) => {
    const opened = await open(options);
    const disposed = deferred();
    control.disposed.set(options.name, disposed);
    const prompt = opened.session.prompt.bind(opened.session);
    vi.spyOn(opened.session, "prompt").mockImplementation((...args) => {
      const pending = prompt(...args);
      control.prompts.push(pending);
      void pending.catch(() => undefined);
      return pending;
    });
    const dispose = opened.dispose;
    opened.dispose = async () => {
      await dispose();
      disposed.resolve();
    };
    return opened;
  });
  Reflect.set(h.runtime, "childFactory", factory);
  const waitCall = async (index: number) => {
    if (control.calls[index]) return control.calls[index]!;
    const waiter = control.waiters.get(index) ?? deferred();
    control.waiters.set(index, waiter);
    await waiter.promise;
    return control.calls[index]!;
  };
  return { ...h, factory, control, waitCall };
}

describe("actual SDK runtime lifecycle and report processing", () => {
  it("reports an explicit abort from the locked SDK once to the live root", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "start" }, h.ctx);
    await h.waitCall(0);
    const session = h.agent("worker").currentExecution!.session!;
    await session.abort();
    await h.waitReport(0);
    await h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.report).toMatchObject({ outcome: "aborted", error: { code: "ABORTED" } });
    expect(h.agent("worker").state).toBe("interrupted");
    expect(h.scope.executions.size).toBe(0);
  });

  it("processes a cancelled child's report through the real SDK before its parent finishes", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parentCall = await h.waitCall(0);
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "worker", prompt: "start" },
      h.ctx,
    );
    await h.waitCall(1);
    const parent = h.agent("parent").currentExecution!;
    const child = h.agent("parent").children.get("worker")!.currentExecution!;
    await child.session!.abort();
    await h.control.disposed.get("worker")!.promise;
    await h.flush();
    expect(parent.pendingReports.size).toBe(1);
    expect(h.reports).toHaveLength(0);
    parentCall.finish("preliminary");
    const processing = await h.waitCall(2);
    expect(parent.pendingReports.size).toBe(1);
    const entry = parent
      .session!.sessionManager.getBranch()
      .find((value) => value.type === "custom_message" && value.customType === "subagent-report");
    expect(entry).toMatchObject({ details: { outcome: "aborted" } });
    processing.finish("handled cancelled child");
    await h.waitReport(0);
    expect(parent.pendingReports.size).toBe(0);
    expect(h.reports[0]?.report.result).toBe("handled cancelled child");
  });

  it("uses public steering expansion, handled and command rejection without another execution", async () => {
    const h = await realHarness();
    const prompts = path.join(h.cwd, ".pi", "prompts");
    const skills = path.join(h.cwd, ".pi", "skills", "fixture");
    await mkdir(prompts, { recursive: true });
    await mkdir(skills, { recursive: true });
    await writeFile(path.join(prompts, "focus.md"), "Expanded focus: $1");
    await writeFile(
      path.join(skills, "SKILL.md"),
      "---\nname: fixture\ndescription: fixture skill\n---\nSkill instructions",
    );
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "start" }, h.ctx);
    const first = await h.waitCall(0);
    const execution = h.agent("worker").currentExecution!;
    const session = execution.session!;
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "consume", isSteer: true }, h.ctx),
    ).rejects.toMatchObject({ code: "PROMPT_HANDLED" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.runtime.askSubagent(
        h.caller,
        { name: "worker", prompt: "canceled", isSteer: true },
        h.ctx,
        controller.signal,
      ),
    ).rejects.toBeDefined();
    await expect(
      h.runtime.askSubagent(
        h.caller,
        { name: "worker", prompt: "/fixture-command", isSteer: true },
        h.ctx,
      ),
    ).rejects.toThrow();
    expect(session.getSteeringMessages()).toEqual([]);
    await h.runtime.askSubagent(
      h.caller,
      { name: "worker", prompt: "/focus auth", isSteer: true },
      h.ctx,
    );
    await h.runtime.askSubagent(
      h.caller,
      { name: "worker", prompt: "/skill:fixture details", isSteer: true },
      h.ctx,
    );
    expect(session.getSteeringMessages()[0]).toBe("Expanded focus: auth");
    expect(session.getSteeringMessages()[1]).toContain("Skill instructions");
    expect(h.agent("worker").currentExecution).toBe(execution);
    first.finish("preliminary");
    (await h.waitCall(1)).finish("template response");
    (await h.waitCall(2)).finish("steered final");
    await h.waitReport(0);
    expect(h.reports).toHaveLength(1);
  });

  it("holds the writer lock and mount until a steering hook exits during shutdown", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "start" }, h.ctx);
    await h.waitCall(0);
    const pause = { reached: deferred(), resume: deferred() };
    h.control.inputPause = pause;
    const steering = h.runtime.askSubagent(
      h.caller,
      { name: "worker", prompt: "late steer", isSteer: true },
      h.ctx,
    );
    await pause.reached.promise;
    let stopped = false;
    const shutdown = h.runtime.shutdown().then(() => {
      stopped = true;
    });
    await h.control.prompts[0];
    expect(stopped).toBe(false);
    expect(h.agent("worker").currentExecution?.session).toBeDefined();
    const contender = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    try {
      await expect(contender.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
    } finally {
      await contender.close();
      pause.resume.resolve();
    }
    await expect(steering).resolves.toMatchObject({ status: "steered" });
    await shutdown;
    expect(h.scope.executions.size).toBe(0);
    expect(h.reports).toHaveLength(0);
    const next = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    await next.open();
    await next.close();
  });

  it("aborts a run that starts after shutdown while ordinary input was suspended", async () => {
    const h = await realHarness();
    const pause = { reached: deferred(), resume: deferred() };
    h.control.inputPause = pause;
    h.control.finishUnexpectedCalls = true;
    const result = await h.runtime.createSubagent(
      h.caller,
      { name: "worker", prompt: "late input" },
      h.ctx,
    );
    expect(result.status).toBe("submitted");
    await pause.reached.promise;
    const execution = h.agent("worker").currentExecution!;
    const session = execution.session!;
    const abort = vi.spyOn(session, "abort");
    let stopped = false;
    const shutdown = h.runtime.shutdown().then(() => {
      stopped = true;
    });
    const contender = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    try {
      // The first abort completes while input is suspended: it cannot stop a future run.
      expect(abort).toHaveBeenCalledTimes(1);
      await abort.mock.results[0]!.value;
      expect(stopped).toBe(false);
      expect(execution.session).toBe(session);
      await expect(contender.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
    } finally {
      await contender.close();
      pause.resume.resolve();
      await shutdown;
    }
    expect(h.scope.executions.size).toBe(0);
    expect(h.agent("worker").state).toBe("interrupted");
    expect(execution.session).toBeUndefined();
    expect(h.reports).toHaveLength(0);
    const next = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    try {
      await next.open();
    } finally {
      await next.close();
    }
    expect(h.control.calls).toHaveLength(0);
  });

  it("aborts a submitted startup and joins its hook before releasing the writer lock", async () => {
    const h = await realHarness();
    const pause = { reached: deferred(), resume: deferred() };
    h.control.pause = pause;
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "start" }, h.ctx);
    await pause.reached.promise;
    let stopped = false;
    const shutdown = h.runtime.shutdown().then(() => {
      stopped = true;
    });
    const contender = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    try {
      await expect(contender.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
      expect(stopped).toBe(false);
    } finally {
      await contender.close();
      pause.resume.resolve();
    }
    await shutdown;
    expect(h.control.calls).toHaveLength(0);
    expect(h.agent("worker").state).toBe("interrupted");
    expect(h.agent("worker").currentExecution).toBeUndefined();
  });

  it("does not retract a submitted task when its tool is canceled during startup", async () => {
    const h = await realHarness();
    const pause = { reached: deferred(), resume: deferred() };
    h.control.pause = pause;
    const controller = new AbortController();
    const result = await h.runtime.createSubagent(
      h.caller,
      { name: "prepared", prompt: "task" },
      h.ctx,
      controller.signal,
    );
    expect(result.status).toBe("submitted");
    await pause.reached.promise;
    controller.abort();
    pause.resume.resolve();
    h.control.pause = undefined;
    (await h.waitCall(0)).finish("submitted result");
    await h.waitReport(0);
    expect(h.reports[0]?.report.result).toBe("submitted result");
  });

  it("rejects failed durable preparation before calling the SDK and releases reservations", async () => {
    const h = await realHarness();
    const save = h.store.setChild.bind(h.store);
    vi.spyOn(h.store, "setChild").mockImplementation((...args) => {
      if (args[3].state === "running")
        return Promise.reject(new SubagentError("STORE_ERROR", "preparation write failed"));
      return save(...args);
    });
    await expect(
      h.runtime.createSubagent(h.caller, { name: "worker", prompt: "must not start" }, h.ctx),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });
    expect(h.control.prompts).toHaveLength(0);
    expect(h.control.calls).toHaveLength(0);
    expect(h.scope.children.has("worker")).toBe(false);
    expect(h.scope.executions.size).toBe(0);
    expect(h.reports).toHaveLength(0);
  });

  it("keeps the parent alive until a queued report has a persisted Pi receipt and later settled processing", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parentCall = await h.waitCall(0);
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "worker", prompt: "work" },
      h.ctx,
    );
    const childCall = await h.waitCall(1);
    const parent = h.agent("parent").currentExecution!;
    childCall.finish("child result");
    const child = h.agent("parent").children.get("worker")!;
    // Wait for the child's own finalization, whose queued send Promise resolves immediately.
    await h.control.disposed.get("worker")!.promise;
    await h.flush();
    expect(child.currentExecution).toBeUndefined();
    expect(parent.pendingChildren.size).toBe(0);
    expect(parent.pendingReports.size).toBe(1);
    expect(h.reports).toHaveLength(0);
    parentCall.finish("parent preliminary");
    const continued = await h.waitCall(2);
    expect(parent.pendingReports.size).toBe(1);
    expect(parent.finalizing).toBe(false);
    expect(
      parent
        .session!.sessionManager.getBranch()
        .some((entry) => entry.type === "custom_message" && entry.customType === "subagent-report"),
    ).toBe(true);
    continued.finish("parent final after child");
    await h.waitReport(0);
    expect(h.reports[0]?.report.result).toBe("parent final after child");
    expect(parent.pendingReports.size).toBe(0);
    expect(h.scope.executions.size).toBe(0);
    expect(h.scope.deliveries.size).toBe(0);
  });

  it("reports a prompt rejection emitted after the SDK finally-settled event", async () => {
    const h = await realHarness();
    const open = h.factory.open.bind(h.factory);
    h.factory.open = async (options) => {
      const opened = await open(options);
      vi.spyOn(opened.session.agent, "prompt").mockRejectedValue(new Error("accepted run failed"));
      return opened;
    };
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    await h.waitReport(0);
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "failed",
      result: "",
      error: { message: "accepted run failed" },
    });
    expect(h.agent("worker").currentExecution).toBeUndefined();
    expect(h.reports).toHaveLength(1);
  });

  it("captures report-triggered SDK prompt rejection after its settled receipt", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parentCall = await h.waitCall(0);
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "child", prompt: "work" },
      h.ctx,
    );
    const childCall = await h.waitCall(1);
    const execution = h.agent("parent").currentExecution!;
    parentCall.finish("preliminary");
    await h.control.prompts[0];
    const prompt = execution.session!.agent.prompt.bind(execution.session!.agent);
    vi.spyOn(execution.session!.agent, "prompt").mockImplementation(async (...args) => {
      await prompt(...args);
      throw new Error("report processing prompt failed");
    });
    childCall.finish("child result");
    const reportCall = await h.waitCall(2);
    reportCall.finish("must not mask prompt failure");
    await h.waitReport(0);
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "failed",
      result: "",
      error: { message: "report processing prompt failed" },
    });
    expect(h.reports).toHaveLength(1);
  });

  it("keeps E1 busy until late steering settles, without starting a second SDK run", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "first" }, h.ctx);
    const first = await h.waitCall(0);
    const session = h.agent("worker").currentExecution!.session!;
    const oldAgentPrompt = vi.spyOn(session.agent, "prompt");
    const pause = { reached: deferred(), resume: deferred() };
    h.control.inputPause = pause;
    const steering = h.runtime.askSubagent(
      h.caller,
      { name: "worker", prompt: "late steer", isSteer: true },
      h.ctx,
    );
    await pause.reached.promise;
    first.finish("first result");
    await h.control.prompts[0];
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "second" }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_BUSY" });
    expect(h.reports).toHaveLength(0);
    pause.resume.resolve();
    await expect(steering).resolves.toMatchObject({ status: "steered" });
    await h.waitReport(0);
    expect(oldAgentPrompt).not.toHaveBeenCalled();
    expect(h.control.calls).toHaveLength(1);
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "second" }, h.ctx);
    const second = await h.waitCall(1);
    expect(h.agent("worker").currentExecution!.session!.getSteeringMessages()).toEqual([]);
    second.finish("second result");
    await h.waitReport(1);
  });

  it.each([false, true])(
    "steering cancellation during input hooks respects the queued boundary (streaming=%s)",
    async (streaming) => {
      const h = await realHarness();
      await h.runtime.createSubagent(
        h.caller,
        { name: "parent", prompt: "coordinate", cwd: h.external },
        h.ctx,
      );
      const parentCall = await h.waitCall(0);
      await h.runtime.createSubagent(
        h.nestedCaller("parent"),
        { name: "child", prompt: "work" },
        h.ctx,
      );
      await h.waitCall(1);
      const execution = h.agent("parent").currentExecution!;
      const pause = { reached: deferred(), resume: deferred() };
      h.control.inputPause = pause;
      const controller = new AbortController();
      const steering = h.runtime.askSubagent(
        h.caller,
        { name: "parent", prompt: "late steer", isSteer: true },
        h.ctx,
        controller.signal,
      );
      const outcome = expect(steering).resolves.toMatchObject({ status: "steered" });
      await pause.reached.promise;
      if (!streaming) {
        parentCall.finish("preliminary");
        await h.control.prompts[0];
      }
      controller.abort();
      pause.resume.resolve();
      await outcome;
      expect(h.control.calls).toHaveLength(2);
      expect(h.agent("parent").currentExecution).toBe(execution);
      expect(execution.failure).toBeUndefined();
      expect(execution.session!.getSteeringMessages()).toEqual(["late steer"]);
    },
  );

  it("queues late steering without launching another SDK run", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parentCall = await h.waitCall(0);
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "child", prompt: "work" },
      h.ctx,
    );
    await h.waitCall(1);
    const pause = { reached: deferred(), resume: deferred() };
    h.control.inputPause = pause;
    const steering = h.runtime.askSubagent(
      h.caller,
      { name: "parent", prompt: "late steer", isSteer: true },
      h.ctx,
    );
    const outcome = expect(steering).resolves.toMatchObject({ status: "steered" });
    await pause.reached.promise;
    parentCall.finish("preliminary");
    await h.control.prompts[0];
    pause.resume.resolve();
    await outcome;
    expect(h.control.calls).toHaveLength(2);
    expect(h.reports).toHaveLength(0);
    expect(h.agent("parent").currentExecution!.session!.getSteeringMessages()).toEqual([
      "late steer",
    ]);
  });

  it("joins a suspended opening before releasing the root writer lock on shutdown", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(h.caller, { name: "sibling", prompt: "active" }, h.ctx);
    await h.waitCall(0);
    const sibling = h.agent("sibling").currentExecution!;
    const abort = vi.spyOn(sibling.session!, "abort");
    const reached = deferred();
    const resume = deferred();
    const open = h.factory.open.bind(h.factory);
    h.factory.open = async (options) => {
      const result = await open(options);
      reached.resolve();
      await resume.promise;
      return result;
    };
    const pending = h.runtime.createSubagent(h.caller, { name: "prepared", prompt: "task" }, h.ctx);
    const outcome = expect(pending).rejects.toMatchObject({ code: "ROOT_CLOSING" });
    await reached.promise;
    const file = h.agent("prepared").identity!.sessionFile;
    let stopped = false;
    const shutdown = h.runtime.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    try {
      expect(abort).toHaveBeenCalled();
      await h.control.disposed.get("sibling")!.promise;
      expect(stopped).toBe(false);
      const contender = new PersistentSubagentStore(h.agentDir, h.scope.identity);
      await expect(contender.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
      await contender.close();
    } finally {
      resume.resolve();
    }
    await Promise.all([shutdown, outcome]);
    expect(h.control.calls).toHaveLength(1);
    expect(h.scope.executions.size).toBe(0);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
