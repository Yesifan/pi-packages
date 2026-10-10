import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
      return stream;
    }
  });
  pi.on("input", async (event) => {
    const pause = globalThis[${JSON.stringify(KEY)}].inputPause;
    if (pause && event.text === "late steer") { pause.reached.resolve(); await pause.resume.promise; }
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
  it("throws out of stale preflight after preaccept cancellation, preventing an SDK provider call", async () => {
    const h = await realHarness();
    const pause = { reached: deferred(), resume: deferred() };
    h.control.pause = pause;
    const controller = new AbortController();
    const pending = h.runtime.createSubagent(
      h.caller,
      { name: "prepared", prompt: "task" },
      h.ctx,
      controller.signal,
    );
    const outcome = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await pause.reached.promise;
    controller.abort();
    await outcome;
    pause.resume.resolve();
    h.control.pause = undefined;
    await Promise.allSettled(h.control.prompts);
    expect(h.control.calls).toHaveLength(0);
    expect(h.scope.children.has("prepared")).toBe(false);
    expect(h.scope.executions.size).toBe(0);
    expect(h.reports).toHaveLength(0);
  });

  it("stops SDK start on failed durable acceptance, retaining identity and reporting failure", async () => {
    const h = await realHarness();
    vi.spyOn(h.store, "setChildSync").mockImplementation(() => {
      throw new SubagentError("STORE_ERROR", "acceptance write failed");
    });
    await expect(
      h.runtime.createSubagent(h.caller, { name: "worker", prompt: "must not start" }, h.ctx),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });
    await h.waitReport(0);
    expect(h.control.calls).toHaveLength(0);
    expect(h.agent("worker").identity).toBeDefined();
    expect(h.agent("worker").state).toBe("idle");
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "failed",
      result: "",
      error: { code: "STORE_ERROR" },
    });
    expect(await readFile(h.agent("worker").identity!.sessionFile, "utf8")).not.toContain(
      "must not start",
    );
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

  it("throws from a late E1 steering hook without starting the disposed session or touching E2", async () => {
    const h = await realHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "first" }, h.ctx);
    const first = await h.waitCall(0);
    const oldAgentPrompt = vi.spyOn(h.agent("worker").currentExecution!.session!.agent, "prompt");
    const pause = { reached: deferred(), resume: deferred() };
    h.control.inputPause = pause;
    const steering = h.runtime.askSubagent(
      h.caller,
      { name: "worker", prompt: "late steer", isSteer: true },
      h.ctx,
    );
    const outcome = expect(steering).rejects.toMatchObject({ code: "ROOT_CLOSING" });
    await pause.reached.promise;
    first.finish("first result");
    await h.waitReport(0);
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "second" }, h.ctx);
    const second = await h.waitCall(1);
    const execution = h.agent("worker").currentExecution;
    pause.resume.resolve();
    await outcome;
    await Promise.resolve();
    for (const rogue of h.control.calls.slice(2)) rogue.finish("unexpected stale run");
    expect(oldAgentPrompt).not.toHaveBeenCalled();
    expect(h.control.calls).toHaveLength(2);
    expect(h.agent("worker").currentExecution).toBe(execution);
    expect(execution?.session?.isStreaming).toBe(true);
    second.finish("second result");
    await h.waitReport(1);
    expect(h.reports[1]?.report.result).toBe("second result");
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
      const outcome = streaming
        ? expect(steering).resolves.toMatchObject({ status: "steered" })
        : expect(steering).rejects.toMatchObject({ code: "ABORTED" });
      await pause.reached.promise;
      if (!streaming) {
        parentCall.finish("preliminary");
        await h.control.prompts[0];
      }
      controller.abort();
      pause.resume.resolve();
      await outcome;
      await h.control.prompts.at(-1)?.catch(() => undefined);
      expect(h.control.calls).toHaveLength(2);
      expect(h.agent("parent").currentExecution).toBe(execution);
      expect(execution.failure).toBeUndefined();
      expect(execution.session!.getSteeringMessages()).toEqual(streaming ? ["late steer"] : []);
    },
  );

  it("stops unexpected started steering before launching another SDK run", async () => {
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
    const outcome = expect(steering).rejects.toMatchObject({ code: "UNEXPECTED_PREFLIGHT" });
    await pause.reached.promise;
    parentCall.finish("preliminary");
    await h.control.prompts[0];
    pause.resume.resolve();
    await outcome;
    await h.waitReport(0);
    expect(h.control.calls).toHaveLength(2);
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "failed",
      error: { code: "UNEXPECTED_PREFLIGHT" },
    });
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
