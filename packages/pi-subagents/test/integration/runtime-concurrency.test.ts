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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedChild } from "../../src/child-session.js";
import { initializeProjectSubagents } from "../../src/project-storage.js";
import { RootRuntime } from "../../src/runtime.js";
import type {
  AgentDefinitionSnapshot,
  CallerBinding,
  LiveAgent,
  StoredSubagent,
  SubagentsConfig,
} from "../../src/types.js";

const temporaryDirectories: string[] = [];
const runtimes: RootRuntime[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

interface FakeChild {
  branch: Array<{ id: string; type: "message"; message: unknown }>;
  listener?: (event: AgentSessionEvent) => void;
  session: AgentSession;
  sessionManager: SessionManager;
  streaming: boolean;
}

interface Harness {
  caller: CallerBinding;
  children: Map<string, FakeChild>;
  context: ExtensionContext;
  failNextOpen(): void;
  runtime: RootRuntime;
}

function generalAgent(): AgentDefinitionSnapshot {
  return {
    id: "general",
    description: "General",
    prompt: "Do the task.",
    source: "/agents/general.md",
    contentHash: "hash",
  };
}

async function createHarness(maxLiveAgents: number): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-concurrency-"));
  temporaryDirectories.push(root);
  const cwd = path.join(root, "project");
  const rootSessionFile = path.join(root, "root.jsonl");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd);
  await writeFile(rootSessionFile, "");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtime = new RootRuntime(path.join(root, "extension.js"));
  runtimes.push(runtime);
  const storage = await initializeProjectSubagents(cwd);
  const config: SubagentsConfig = {
    externalDirectories: [],
    maxDepth: 4,
    maxLiveAgents,
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
        hasUI: false,
        ui: {},
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext,
      sendReport: () => undefined,
    },
    config,
  );

  const children = new Map<string, FakeChild>();
  let childIndex = 0;
  let shouldFailNextOpen = false;
  const fakeFactory = {
    createSessionManager: async (
      _cwd: string,
      sessionsDirectory: string,
    ): Promise<SessionManager> => {
      childIndex += 1;
      const sessionId = `child-session-${childIndex}`;
      const sessionFile = path.join(sessionsDirectory, `${sessionId}.jsonl`);
      await writeFile(sessionFile, "{}\n");
      const child = {
        branch: [],
        streaming: false,
      } as unknown as FakeChild;
      const sessionManager = {
        getSessionFile: () => sessionFile,
        getSessionId: () => sessionId,
        getLeafId: () => child.branch.at(-1)?.id ?? null,
        getBranch: () => child.branch,
      } as unknown as SessionManager;
      const session = {
        get isStreaming() {
          return child.streaming;
        },
        sessionManager,
        prompt: async (
          _prompt: string,
          options: { preflightResult?: (success: boolean) => void },
        ) => {
          child.streaming = true;
          options.preflightResult?.(true);
        },
        subscribe: (listener: (event: AgentSessionEvent) => void) => {
          child.listener = listener;
          return () => {
            child.listener = undefined;
          };
        },
        abort: async () => {
          child.streaming = false;
        },
        dispose: () => undefined,
      } as unknown as AgentSession;
      child.session = session;
      child.sessionManager = sessionManager;
      children.set(sessionId, child);
      return sessionManager;
    },
    openSessionManager: (stored: StoredSubagent): SessionManager => {
      const child = children.get(stored.sessionId);
      if (!child) throw new Error(`Missing fake child ${stored.sessionId}`);
      return child.sessionManager;
    },
    open: async (options: { stored: StoredSubagent }): Promise<OpenedChild> => {
      if (shouldFailNextOpen) {
        shouldFailNextOpen = false;
        throw new Error("open failed");
      }
      const child = children.get(options.stored.sessionId);
      if (!child) throw new Error(`Missing fake child ${options.stored.sessionId}`);
      return {
        session: child.session,
        actualThinking: options.stored.thinking,
        ui: {} as OpenedChild["ui"],
        dispose: async () => {
          child.streaming = false;
        },
      };
    },
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
  const model = { provider: "test", id: "model", name: "Test Model" } as Model<Api>;
  const context = { model, thinkingLevel: "off" } as ExtensionContext;

  return {
    caller,
    children,
    context,
    failNextOpen: () => {
      shouldFailNextOpen = true;
    },
    runtime,
  };
}

async function createIdleSubagent(harness: Harness, name: string): Promise<string> {
  const started = await harness.runtime.createSubagent(
    harness.caller,
    { name, prompt: "initial task" },
    harness.context,
    undefined,
  );
  const stored = (Reflect.get(harness.runtime, "agents") as Map<string, StoredSubagent>).get(
    started.id,
  );
  const child = stored ? harness.children.get(stored.sessionId) : undefined;
  if (!child) throw new Error(`Missing child for ${started.id}`);
  child.branch.push({
    id: `entry-${started.run_id}`,
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `${name} completed` }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  child.streaming = false;
  child.listener?.({ type: "agent_settled" });
  await vi.waitFor(() => {
    expect((Reflect.get(harness.runtime, "live") as Map<string, LiveAgent>).has(started.id)).toBe(
      false,
    );
  });
  return started.id;
}

describe("normal ask concurrency", () => {
  it("reserves an idle subagent before the first asynchronous wait", async () => {
    const harness = await createHarness(8);
    const agentId = await createIdleSubagent(harness, "worker");

    const first = harness.runtime.askSubagent(
      harness.caller,
      { id: agentId, prompt: "first follow-up" },
      harness.context,
      undefined,
    );
    const live = Reflect.get(harness.runtime, "live") as Map<string, LiveAgent>;
    const reserved = live.get(agentId);
    const immediateReservation = reserved
      ? { phase: reserved.phase, accepted: reserved.accepted }
      : undefined;
    const second = harness.runtime.askSubagent(
      harness.caller,
      { id: agentId, prompt: "second follow-up" },
      harness.context,
      undefined,
    );
    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

    expect(immediateReservation).toMatchObject({ phase: "opening", accepted: false });
    expect(firstOutcome).toMatchObject({
      status: "fulfilled",
      value: { id: agentId, status: "started" },
    });
    expect(secondOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "SUBAGENT_BUSY", agentId },
    });
  });

  it("atomically reserves the final shared live-agent slot", async () => {
    const harness = await createHarness(1);
    const firstAgentId = await createIdleSubagent(harness, "first");
    const secondAgentId = await createIdleSubagent(harness, "second");

    const first = harness.runtime.askSubagent(
      harness.caller,
      { id: firstAgentId, prompt: "first follow-up" },
      harness.context,
      undefined,
    );
    const live = Reflect.get(harness.runtime, "live") as Map<string, LiveAgent>;
    const immediateLiveCount = live.size;
    const second = harness.runtime.askSubagent(
      harness.caller,
      { id: secondAgentId, prompt: "second follow-up" },
      harness.context,
      undefined,
    );
    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

    expect(immediateLiveCount).toBe(1);
    expect(firstOutcome).toMatchObject({
      status: "fulfilled",
      value: { id: firstAgentId, status: "started" },
    });
    expect(secondOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "LIVE_AGENT_LIMIT" },
    });
    expect(live.size).toBe(1);
  });

  it("releases the reservation when asynchronous initialization fails", async () => {
    const harness = await createHarness(1);
    const agentId = await createIdleSubagent(harness, "worker");
    harness.failNextOpen();

    await expect(
      harness.runtime.askSubagent(
        harness.caller,
        { id: agentId, prompt: "failing follow-up" },
        harness.context,
        undefined,
      ),
    ).rejects.toThrow("open failed");
    const live = Reflect.get(harness.runtime, "live") as Map<string, LiveAgent>;
    expect(live.has(agentId)).toBe(false);
    expect(live.size).toBe(0);

    await expect(
      harness.runtime.askSubagent(
        harness.caller,
        { id: agentId, prompt: "retry" },
        harness.context,
        undefined,
      ),
    ).resolves.toMatchObject({ id: agentId, status: "started" });
  });
});
