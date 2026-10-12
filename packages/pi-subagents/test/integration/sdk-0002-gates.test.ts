import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const sessions: AgentSession[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-sdk-0002-"));
  directories.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const calls: Array<{ release: () => void; done: Promise<void> }> = [];
  const requests: Array<ReturnType<typeof barrier>> = [];
  runtime.registerProvider("spec-gate", {
    api: "spec-gate",
    apiKey: "local-test",
    baseUrl: "https://unused.invalid",
    models: ["a", "b"].map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 1000,
    })),
    streamSimple: (model) => {
      const stream = createAssistantMessageEventStream();
      const gate = barrier();
      const done = barrier();
      const index = calls.length;
      calls.push({ release: gate.release, done: done.promise });
      requests[index]?.release();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `reply-${index}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      void gate.promise.then(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        done.release();
      });
      return stream;
    },
  });
  const waitRequest = async (index: number) => {
    if (calls[index]) return;
    requests[index] ??= barrier();
    await requests[index]!.promise;
  };
  const make = async (manager: SessionManager, initial = false, factory?: ExtensionFactory) => {
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "spec-gate",
      defaultModel: "b",
      defaultThinkingLevel: "low",
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: !factory,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      ...(factory ? { extensionFactories: [{ name: "gate-input", factory }] } : {}),
    });
    await loader.reload();
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
      noTools: "all",
      ...(initial
        ? { model: runtime.getModel("spec-gate", "a")!, thinkingLevel: "high" as const }
        : {}),
    });
    sessions.push(result.session);
    await result.session.bindExtensions({ mode: "print" });
    return result;
  };
  return { root, cwd, agentDir, runtime, calls, waitRequest, make };
}

describe("SDK 1.0.0 Spec 0002 implementation gates", () => {
  it("uses SDK allocated default cwd directory and preopens private valid history", async () => {
    const h = await harness();
    const allocated = SessionManager.create(h.cwd);
    const file = allocated.getSessionFile()!;
    expect(file.startsWith(path.join(h.agentDir, "sessions") + path.sep)).toBe(true);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "", { flag: "wx", mode: 0o600 });
    const opened = SessionManager.open(file, path.dirname(file), h.cwd);
    expect(opened.getHeader()?.type).toBe("session");
    expect(opened.getCwd()).toBe(h.cwd);
    expect((await stat(file)).size).toBeGreaterThan(0);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("returns started/queued/handled dispositions, and queued report promises are not processing acknowledgments", async () => {
    const h = await harness();
    const manager = SessionManager.create(h.cwd);
    const { session } = await h.make(manager, true, (pi) => {
      pi.on("input", (event) =>
        event.text === "consume" ? { action: "handled" } : { action: "continue" },
      );
    });
    const dispositions: string[] = [];
    await session.prompt("consume", {
      expandPromptTemplates: false,
      preflightResult: (value) => dispositions.push(value),
    });
    expect(dispositions).toEqual(["handled"]);
    expect(h.calls).toHaveLength(0);
    const run = session.prompt("task", {
      expandPromptTemplates: false,
      preflightResult: (value) => dispositions.push(value),
    });
    await h.waitRequest(0);
    expect(dispositions).toEqual(["handled", "started"]);
    await session.prompt("steering", {
      streamingBehavior: "steer",
      expandPromptTemplates: false,
      preflightResult: (value) => dispositions.push(value),
    });
    expect(dispositions).toEqual(["handled", "started", "queued"]);
    await session.prompt("consume", {
      streamingBehavior: "steer",
      expandPromptTemplates: false,
      preflightResult: (value) => dispositions.push(value),
    });
    expect(dispositions).toEqual(["handled", "started", "queued", "handled"]);
    expect(session.isStreaming).toBe(true);
    expect(h.calls).toHaveLength(1);
    const sourceEntryId = manager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
    let observed = false;
    let recordedEntryId: string | undefined;
    let processed = false;
    const subscription = session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "gate-report"
      ) {
        observed =
          (event.message.details as { sourceEntryId?: string })?.sourceEntryId === sourceEntryId;
        // Public listeners run before this message is appended; persistence is checked at settled.
      }
      if (event.type === "agent_settled" && observed) {
        const entry = manager
          .getBranch()
          .find(
            (entry) =>
              entry.type === "custom_message" &&
              (entry.details as { sourceEntryId?: string })?.sourceEntryId === sourceEntryId,
          );
        recordedEntryId = entry?.id;
        processed = recordedEntryId !== undefined;
      }
    });
    await session.sendCustomMessage(
      {
        customType: "gate-report",
        content: "worker result",
        display: true,
        details: JSON.parse(JSON.stringify({ sourceEntryId })),
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(recordedEntryId).toBeUndefined();
    expect(processed).toBe(false);
    h.calls[0]!.release();
    await h.waitRequest(1);
    // Default one-at-a-time steering consumes the earlier steering prompt first.
    expect(observed).toBe(false);
    expect(processed).toBe(false);
    h.calls[1]!.release();
    await h.waitRequest(2);
    expect(observed).toBe(true);
    expect(
      manager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            (entry.details as { sourceEntryId?: string })?.sourceEntryId === sourceEntryId,
        ),
    ).toBe(true);
    expect(recordedEntryId).toBeUndefined();
    expect(processed).toBe(false);
    h.calls[2]!.release();
    await run;
    expect(processed).toBe(true);
    subscription();
  });

  it("defers a report submitted inside settled: send resolves before the next processing chain settles", async () => {
    const h = await harness();
    const manager = SessionManager.create(h.cwd);
    const { session } = await h.make(manager, true);
    let firstSettled = true;
    let sent = false;
    let recorded = false;
    let processed = false;
    const sourceEntryId = manager.appendCustomEntry("gate-source", {});
    session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "gate-report"
      ) {
        recorded =
          (event.message.details as { sourceEntryId?: string })?.sourceEntryId === sourceEntryId;
      }
      if (event.type === "agent_settled") {
        if (firstSettled) {
          firstSettled = false;
          void session
            .sendCustomMessage(
              {
                customType: "gate-report",
                content: "worker result",
                display: true,
                details: { sourceEntryId },
              },
              { deliverAs: "steer", triggerTurn: true },
            )
            .then(() => {
              sent = true;
            });
        } else if (recorded)
          processed = manager
            .getBranch()
            .some(
              (entry) =>
                entry.type === "custom_message" &&
                (entry.details as { sourceEntryId?: string })?.sourceEntryId === sourceEntryId,
            );
      }
    });
    const run = session.prompt("task", { expandPromptTemplates: false });
    await h.waitRequest(0);
    h.calls[0]!.release();
    await h.waitRequest(1);
    expect(sent).toBe(true);
    expect(recorded).toBe(true);
    expect(processed).toBe(false);
    h.calls[1]!.release();
    await run;
    expect(processed).toBe(true);
  });

  it("retains model/thinking history when aborted before the first reply", async () => {
    const h = await harness();
    const manager = SessionManager.create(h.cwd);
    const { session } = await h.make(manager, true);
    const run = session.prompt("task", { expandPromptTemplates: false });
    await h.waitRequest(0);
    const aborted = session.abort();
    h.calls[0]!.release();
    await Promise.all([run, aborted]);
    expect(
      manager
        .getBranch()
        .some((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toBe(true);
    const restored = await h.make(SessionManager.open(manager.getSessionFile()!));
    expect(restored.session.model?.id).toBe("a");
    expect(restored.session.thinkingLevel).toBe("high");
    expect(restored.modelFallbackMessage).toBeUndefined();
  });

  it("uses the SDK's virtual branch selection rather than the latest physical response", async () => {
    const h = await harness();
    h.runtime.registerProvider("gate-virtual", {
      api: "pi-virtual",
      apiKey: "local-test",
      baseUrl: "https://unused.invalid",
      models: [
        {
          id: "router",
          name: "router",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
      ],
    });
    const manager = SessionManager.inMemory(h.cwd);
    manager.appendModelChange("gate-virtual", "router");
    manager.appendThinkingLevelChange("high");
    manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "physical reply" }],
      api: "spec-gate",
      provider: "spec-gate",
      model: "a",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    expect(manager.buildSessionContext().model?.modelId).toBe("a");
    const restored = await h.make(manager);
    expect(restored.session.model?.provider).toBe("gate-virtual");
    expect(restored.session.model?.id).toBe("router");
    expect(restored.session.thinkingLevel).toBe("high");
  });

  it("exposes unavailable historical model/auth fallback instead of claiming restoration", async () => {
    const h = await harness();
    h.runtime.registerProvider("gate-no-auth", {
      api: "spec-gate",
      baseUrl: "https://unused.invalid",
      models: [
        {
          id: "a",
          name: "a",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
      ],
    });
    expect(h.runtime.hasConfiguredAuth("gate-no-auth")).toBe(false);
    for (const provider of ["gate-missing-model", "gate-no-auth"]) {
      const manager = SessionManager.inMemory(h.cwd);
      manager.appendModelChange(provider, "a");
      manager.appendThinkingLevelChange("high");
      manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
      const restored = await h.make(manager);
      expect(restored.session.model?.provider).toBe("spec-gate");
      expect(restored.session.model?.id).toBe("b");
      expect(restored.modelFallbackMessage).toContain(`Could not restore model ${provider}/a`);
    }
  });

  it("restores model/thinking without overrides and demonstrates header-only and missing-history fallback", async () => {
    const h = await harness();
    const manager = SessionManager.create(h.cwd);
    const { session } = await h.make(manager, true);
    const run = session.prompt("task", { expandPromptTemplates: false });
    await h.waitRequest(0);
    h.calls[0]!.release();
    await run;
    const file = manager.getSessionFile()!;
    session.dispose();
    const restored = await h.make(SessionManager.open(file));
    expect(restored.session.model?.id).toBe("a");
    expect(restored.session.thinkingLevel).toBe("high");
    expect(restored.modelFallbackMessage).toBeUndefined();
    const headerOnly = await h.make(
      SessionManager.inMemory(h.cwd, undefined, [manager.getHeader()!]),
    );
    expect(headerOnly.session.model?.id).toBe("b");
    expect(headerOnly.session.thinkingLevel).toBe("low");
    const missingThinking = await h.make(
      SessionManager.inMemory(h.cwd, undefined, [
        manager.getHeader()!,
        ...manager.getBranch().filter((entry) => entry.type !== "thinking_level_change"),
      ]),
    );
    expect(missingThinking.session.thinkingLevel).toBe("low");
    const missingModel = await h.make(
      SessionManager.inMemory(h.cwd, undefined, [
        manager.getHeader()!,
        ...manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type !== "model_change" &&
              !(entry.type === "message" && entry.message.role === "assistant"),
          ),
      ]),
    );
    expect(missingModel.session.model?.id).toBe("b");
  });
});
