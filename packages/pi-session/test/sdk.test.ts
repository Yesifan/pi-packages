import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { SessionTasks, type TaskReport } from "../src/tasks.js";

// Use the locked SDK's own stream helper without adding a production/test dependency.
const aiUrl = new URL(
  "../../pi-ai/dist/index.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { createAssistantMessageEventStream } = (await import(aiUrl.href)) as {
  createAssistantMessageEventStream: () => ReturnType<ModelRuntime["streamSimple"]>;
};

it("runs offline SDK prompts in the original history and reopens it for a subsequent ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const opened: AgentSession[] = [];
  let tasks: SessionTasks | undefined;
  const fetch = vi.fn(() => {
    throw new Error("Network is forbidden in the SDK integration test");
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
  try {
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const contexts: string[] = [];
    modelRuntime.registerProvider("session-offline", {
      api: "session-offline",
      apiKey: "offline-test-only",
      baseUrl: "https://unused.invalid",
      models: [
        {
          id: "local",
          name: "local",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
      ],
      streamSimple: (model, context) => {
        contexts.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        const message: Awaited<ReturnType<typeof stream.result>> = {
          role: "assistant",
          content: [{ type: "text", text: `offline answer ${contexts.length}` }],
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
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });
    const original = SessionManager.create(cwd);
    original.appendModelChange("session-offline", "local");
    original.appendMessage({
      role: "user",
      content: "previous conversation",
      timestamp: Date.now(),
    });
    const originalFile = original.getSessionFile()!;
    const originalId = original.getSessionId();
    const initialEntryIds = original.getEntries().map((entry) => entry.id);
    const sources: string[] = [];
    const disposals: ReturnType<typeof vi.spyOn>[] = [];
    tasks = new SessionTasks({
      load: async (target) => {
        // Same open/target-cwd/bind sequence as the default loader; only resources and model are isolated.
        const manager = SessionManager.open(target.path);
        const settingsManager = SettingsManager.inMemory({
          defaultProvider: "session-offline",
          defaultModel: "local",
          retry: { enabled: false },
          compaction: { enabled: false },
          cacheWarming: "off",
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd: target.cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [
            (pi) => {
              pi.on("input", (event) => {
                sources.push(event.source);
              });
            },
          ],
        });
        await resourceLoader.reload();
        const { session, modelFallbackMessage } = await createAgentSession({
          cwd: target.cwd,
          agentDir,
          sessionManager: manager,
          settingsManager,
          resourceLoader,
          modelRuntime,
          noTools: "all",
        });
        opened.push(session);
        disposals.push(vi.spyOn(session, "dispose"));
        expect(modelFallbackMessage).toBeUndefined();
        expect(session.model?.id).toBe("local");
        expect(session.sessionId).toBe(originalId);
        expect(session.sessionFile).toBe(originalFile);
        await session.bindExtensions({ mode: "print" });
        return session;
      },
    });
    const firstReport = vi.fn<(report: TaskReport) => void>();
    const secondReport = vi.fn<(report: TaskReport) => void>();
    const request = { id: originalId, cwd, prompt: "first question", callerId: "separate-caller" };
    expect(await tasks.ask(request, firstReport)).toEqual({
      status: "accepted",
      id: originalId,
      path: originalFile,
    });
    await vi.waitFor(() =>
      expect(firstReport).toHaveBeenCalledExactlyOnceWith({
        id: originalId,
        cwd,
        path: originalFile,
        status: "completed",
        text: "offline answer 1",
      }),
    );
    expect(disposals[0]).toHaveBeenCalledOnce();
    const afterFirst = SessionManager.open(originalFile);
    const firstMessages = afterFirst.buildSessionContext().messages;
    expect(firstMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "first question" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "offline answer 1" }],
        }),
      ]),
    );
    await tasks.ask({ ...request, prompt: "follow-up question" }, secondReport);
    await vi.waitFor(() =>
      expect(secondReport).toHaveBeenCalledExactlyOnceWith({
        id: originalId,
        cwd,
        path: originalFile,
        status: "completed",
        text: "offline answer 2",
      }),
    );
    expect(firstReport).toHaveBeenCalledOnce();
    expect(opened).toHaveLength(2);
    expect(opened[0]).not.toBe(opened[1]);
    expect(disposals[1]).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toContain("previous conversation");
    expect(contexts[0]).toContain("first question");
    expect(contexts[1]).toContain("offline answer 1");
    expect(contexts[1]).toContain("follow-up question");
    expect(sources).toEqual(["extension", "extension"]);
    const final = SessionManager.open(originalFile);
    expect(
      final
        .getEntries()
        .slice(0, initialEntryIds.length)
        .map((entry) => entry.id),
    ).toEqual(initialEntryIds);
    expect(final.buildSessionContext().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "follow-up question" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "offline answer 2" }],
        }),
      ]),
    );
    expect((await SessionManager.list(cwd)).map((session) => session.id)).toEqual([originalId]);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    tasks?.close();
    for (const session of opened) session.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
