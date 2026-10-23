import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import systemPrompt from "../extensions/system-prompt.ts";

const { createAssistantMessageEventStream } = await import(
  new URL("../../pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);

test("idle custom reports capture the actual system prompt and provider tools once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "system-prompt-sdk-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Network forbidden");
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
  const tools = [{ name: "offline_tool", input_schema: { type: "object" } }];
  let calls = 0;
  modelRuntime.registerProvider("offline", {
    api: "offline",
    apiKey: "offline",
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
    streamSimple: (model, _context, options) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options.onPayload?.({ tools }, model);
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "report acknowledged" }],
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
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      })();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "offline",
    defaultModel: "local",
    cacheWarming: "off",
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const starts = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => "custom report system prompt",
    extensionFactories: [
      systemPrompt,
      (pi) => {
        pi.on("before_agent_start", (event) => {
          starts.push(event);
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(root),
    noTools: "all",
  });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  await session.sendCustomMessage(
    { customType: "session-report", content: "background answer", display: true },
    { deliverAs: "steer", triggerTurn: true },
  );
  await session.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].messageType, "custom");
  assert.equal("prompt" in starts[0], false);
  const logs = t.mock.method(console, "log", () => {});
  await session.prompt("/system-prompt");
  const dump = logs.mock.calls[0].arguments[0];
  assert.ok(dump.includes(starts[0].systemPrompt));
  assert.ok(dump.includes("custom report system prompt"));
  assert.ok(dump.includes(JSON.stringify(tools, null, 2)));
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
});
