import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionContext,
  ProjectTrustStore,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenedChild } from "../../src/child-session.js";
import { initializeProjectSubagents } from "../../src/project-storage.js";
import { RootRuntime } from "../../src/runtime.js";
import { PersistentSubagentStore } from "../../src/store.js";
import type {
  AgentDefinitionSnapshot,
  CallerBinding,
  StoredSubagent,
  SubagentsConfig,
} from "../../src/types.js";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function generalAgent(): AgentDefinitionSnapshot {
  return {
    id: "general",
    description: "General",
    prompt: "Do the task.",
    source: "/agents/general.md",
    contentHash: "hash",
  };
}

describe("runtime steering", () => {
  it("requires trust for an external project even when only subagent settings exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-runtime-trust-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "project");
    const external = path.join(root, "external");
    const rootSessionFile = path.join(root, "root.jsonl");
    await Promise.all([
      mkdir(cwd),
      mkdir(path.join(external, ".pi", "subagents"), { recursive: true }),
      writeFile(rootSessionFile, ""),
    ]);
    await writeFile(path.join(external, ".pi", "subagents", "setting.json"), "{}\n");
    const agentDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const storage = await initializeProjectSubagents(cwd);
    const runtime = new RootRuntime(path.join(root, "extension.js"));
    await runtime.initialize(
      {
        rootSessionId: "root-session",
        rootSessionFile,
        ctx: {
          cwd,
          ui: {},
          hasUI: false,
          isProjectTrusted: () => true,
        } as unknown as ExtensionContext,
        sendReport: () => undefined,
      },
      {
        externalDirectories: [external],
        maxDepth: 4,
        maxLiveAgents: 8,
        uiTimeoutMs: 100,
        projectRoot: cwd,
        storageDirectory: storage.directory,
      },
    );
    const resolveTrust = Reflect.get(runtime, "resolveTrust") as (
      target: string,
    ) => Promise<boolean>;
    await expect(resolveTrust.call(runtime, external)).resolves.toBe(false);

    const allowedRoot = path.join(root, "allowed-external");
    const deniedChild = path.join(allowedRoot, "denied-child");
    await mkdir(deniedChild, { recursive: true });
    const trustStore = new ProjectTrustStore(agentDir);
    trustStore.set(allowedRoot, true);
    trustStore.set(deniedChild, false);
    await expect(resolveTrust.call(runtime, deniedChild)).resolves.toBe(false);
    await runtime.shutdown();
  });

  it("rejects a normal busy ask and steers the current run without creating another run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-runtime-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "project");
    const rootSessionFile = path.join(root, "root.jsonl");
    await mkdir(cwd);
    await writeFile(rootSessionFile, "");
    const agentDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const runtime = new RootRuntime(path.join(root, "extension.js"));
    const storage = await initializeProjectSubagents(cwd);
    const config: SubagentsConfig = {
      externalDirectories: [],
      maxDepth: 4,
      maxLiveAgents: 8,
      uiTimeoutMs: 100,
      projectRoot: cwd,
      storageDirectory: storage.directory,
    };
    await runtime.initialize(
      {
        rootSessionId: "root-session",
        rootSessionFile,
        ctx: {
          cwd,
          ui: {},
          isProjectTrusted: () => true,
        } as unknown as ExtensionContext,
        sendReport: () => undefined,
      },
      config,
    );

    const promptOptions: Array<{ streamingBehavior?: string }> = [];
    let aborted = false;
    let childSessionFile = "";
    const fakeSessionManager = {
      getSessionFile: () => childSessionFile,
      getSessionId: () => "child-session",
      getLeafId: () => null,
      getBranch: () => [],
    } as unknown as SessionManager;
    const fakeSession = {
      isStreaming: true,
      sessionManager: fakeSessionManager,
      prompt: async (
        _prompt: string,
        options: {
          streamingBehavior?: string;
          preflightResult?: (success: boolean) => void;
        },
      ) => {
        promptOptions.push(options);
        options.preflightResult?.(true);
        await new Promise<void>(() => undefined);
      },
      subscribe: () => () => undefined,
      abort: async () => {
        aborted = true;
      },
      dispose: () => undefined,
    } as unknown as AgentSession;
    const fakeFactory = {
      createSessionManager: async (_cwd: string, sessionsDirectory: string) => {
        childSessionFile = path.join(sessionsDirectory, "child.jsonl");
        await writeFile(childSessionFile, "");
        return fakeSessionManager;
      },
      open: async (options: { stored: StoredSubagent }): Promise<OpenedChild> => ({
        session: fakeSession,
        actualThinking: options.stored.thinking,
        ui: { cleanup: () => undefined } as unknown as OpenedChild["ui"],
        dispose: async () => {
          await fakeSession.abort();
        },
      }),
    };
    Reflect.set(runtime, "childFactory", fakeFactory);
    Reflect.set(runtime, "resolveTrust", async () => true);

    const definition = generalAgent();
    const caller: CallerBinding = {
      agentId: null,
      depth: 0,
      ancestorCwds: [cwd],
      delegation: {
        cwd,
        projectRoot: cwd,
        externalDirectories: [],
        agentTypes: new Map([[definition.id, definition]]),
      },
    };
    const model = {
      provider: "test",
      id: "model",
      name: "Test Model",
    } as Model<Api>;
    const context = { model, thinkingLevel: "off" } as ExtensionContext;

    const started = await runtime.createSubagent(
      caller,
      { name: "worker", prompt: "start" },
      context,
      undefined,
    );
    const runtimeStore = Reflect.get(runtime, "store") as PersistentSubagentStore;
    await expect(runtimeStore.readRun(started.id, started.run_id)).resolves.toMatchObject({
      state: "accepted",
      acceptedAt: expect.any(String),
    });
    await expect(
      runtime.askSubagent(caller, { id: started.id, prompt: "normal" }, context, undefined),
    ).rejects.toMatchObject({ code: "SUBAGENT_BUSY" });

    const steered = await runtime.askSubagent(
      caller,
      { id: started.id, prompt: "focus", isSteer: true },
      context,
      undefined,
    );
    expect(steered).toMatchObject({
      ok: true,
      id: started.id,
      run_id: started.run_id,
      status: "steered",
    });
    expect(promptOptions).toHaveLength(2);
    expect(promptOptions[0]?.streamingBehavior).toBeUndefined();
    expect(promptOptions[1]?.streamingBehavior).toBe("steer");

    await runtime.shutdown();
    expect(aborted).toBe(true);

    const reopened = new PersistentSubagentStore(
      cwd,
      storage.directory,
      "root-session",
      rootSessionFile,
    );
    const agents = await reopened.open();
    expect(agents[0]).toMatchObject({ id: started.id, interrupted: true });
    await expect(reopened.readRun(started.id, started.run_id)).resolves.toMatchObject({
      outcome: "interrupted",
      error: { code: "INTERRUPTED" },
    });
    await reopened.close();
  });
});
