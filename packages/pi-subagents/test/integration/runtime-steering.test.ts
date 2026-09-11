import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenedChild } from "../../src/child-session.js";
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
  it("rejects a normal busy ask and steers the current run without creating another run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-runtime-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "project");
    const rootSessionFile = path.join(root, "root.jsonl");
    await mkdir(cwd);
    await writeFile(rootSessionFile, "");
    const agentDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const widgetCalls: Array<string[] | undefined> = [];
    const runtime = new RootRuntime(path.join(root, "extension.js"));
    const config: SubagentsConfig = {
      externalDirectories: [],
      maxDepth: 4,
      maxLiveAgents: 8,
      uiTimeoutMs: 100,
      projectRoot: cwd,
    };
    await runtime.initialize(
      {
        rootSessionId: "root-session",
        rootSessionFile,
        ctx: {
          hasUI: true,
          ui: {
            setWidget: (_key: string, lines: string[] | undefined) => widgetCalls.push(lines),
          },
        } as unknown as ExtensionContext,
        sendReport: () => undefined,
      },
      config,
    );

    const promptOptions: Array<{ streamingBehavior?: string }> = [];
    let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
    let aborted = false;
    const fakeSessionManager = {
      getSessionFile: () => path.join(root, "child.jsonl"),
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
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        sessionListener = listener;
        return () => {
          sessionListener = undefined;
        };
      },
      abort: async () => {
        aborted = true;
      },
      dispose: () => undefined,
    } as unknown as AgentSession;
    const fakeFactory = {
      createSessionManager: async () => fakeSessionManager,
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
    sessionListener?.({ type: "turn_start" });
    sessionListener?.({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    expect(widgetCalls.at(-1)).toEqual(["worker[1]：bash pnpm test"]);

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

    const reopened = new PersistentSubagentStore(agentDir, "root-session", rootSessionFile);
    const agents = await reopened.open();
    expect(agents[0]).toMatchObject({ id: started.id, interrupted: true });
    await expect(reopened.readRun(started.id, started.run_id)).resolves.toMatchObject({
      outcome: "interrupted",
      error: { code: "INTERRUPTED" },
    });
    await reopened.close();
  });
});
