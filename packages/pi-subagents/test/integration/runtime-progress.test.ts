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
import { RootRuntime } from "../../src/runtime.js";
import type {
  AgentDefinitionSnapshot,
  CallerBinding,
  StoredSubagent,
  SubagentReport,
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

interface FakeChild {
  session: AgentSession;
  sessionManager: SessionManager;
  listener?: (event: AgentSessionEvent) => void;
  streaming: boolean;
  branch: unknown[];
}

function agentDefinition(): AgentDefinitionSnapshot {
  return {
    id: "general",
    description: "General",
    prompt: "Do the task.",
    source: "/agents/general.md",
    contentHash: "hash",
  };
}

function complete(child: FakeChild, text: string): void {
  child.branch.push({
    id: `entry-${text}`,
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  child.streaming = false;
  child.listener?.({ type: "agent_settled" });
}

describe("runtime progress widget", () => {
  it("shows one latest line per active subagent and removes lines as runs finish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-progress-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "project");
    const rootSessionFile = path.join(root, "root.jsonl");
    const agentDir = path.join(root, "agent");
    await mkdir(cwd);
    await writeFile(rootSessionFile, "");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const widgetCalls: Array<string[] | undefined> = [];
    const reports: SubagentReport[] = [];
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
        sendReport: (report) => reports.push(report),
      },
      config,
    );

    const children: FakeChild[] = [];
    let failNextOpen = false;
    const fakeFactory = {
      createSessionManager: async (): Promise<SessionManager> => {
        const index = children.length + 1;
        const child = {
          streaming: true,
          branch: [],
        } as unknown as FakeChild;
        const sessionManager = {
          getSessionFile: () => path.join(root, `child-${index}.jsonl`),
          getSessionId: () => `child-session-${index}`,
          getLeafId: () => null,
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
            options.preflightResult?.(true);
          },
          subscribe: (listener: (event: AgentSessionEvent) => void) => {
            child.listener = listener;
            return () => {
              child.listener = undefined;
            };
          },
          abort: async () => undefined,
          dispose: () => undefined,
        } as unknown as AgentSession;
        child.session = session;
        child.sessionManager = sessionManager;
        children.push(child);
        return sessionManager;
      },
      open: async (options: { stored: StoredSubagent }): Promise<OpenedChild> => {
        if (failNextOpen) {
          failNextOpen = false;
          throw new Error("open failed");
        }
        const child = children.find(
          ({ sessionManager }) => sessionManager.getSessionFile() === options.stored.sessionFile,
        );
        if (!child) throw new Error("Missing fake child");
        return {
          session: child.session,
          actualThinking: options.stored.thinking,
          ui: {} as OpenedChild["ui"],
          dispose: async () => undefined,
        };
      },
    };
    Reflect.set(runtime, "childFactory", fakeFactory);
    Reflect.set(runtime, "resolveTrust", async () => true);

    const definition = agentDefinition();
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

    await runtime.createSubagent(caller, { name: "worker", prompt: "work" }, context, undefined);
    await runtime.createSubagent(
      caller,
      { name: "reviewer", prompt: "review" },
      context,
      undefined,
    );
    expect(widgetCalls.at(-1)).toEqual(["worker[0]：starting", "reviewer[0]：starting"]);

    children[0]?.listener?.({ type: "turn_start" });
    children[0]?.listener?.({
      type: "tool_execution_start",
      toolCallId: "tool-worker",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    children[1]?.listener?.({ type: "turn_start" });
    expect(widgetCalls.at(-1)).toEqual(["worker[1]：bash pnpm test", "reviewer[1]：thinking"]);

    complete(children[0]!, "worker done");
    await vi.waitFor(() => {
      expect(widgetCalls.at(-1)).toEqual(["reviewer[1]：thinking"]);
    });
    const staleListener = children[1]!.listener;
    complete(children[1]!, "reviewer done");
    await vi.waitFor(() => {
      expect(widgetCalls.at(-1)).toBeUndefined();
      expect(reports).toHaveLength(2);
    });

    staleListener?.({ type: "turn_start" });
    expect(widgetCalls.at(-1)).toBeUndefined();

    failNextOpen = true;
    await expect(
      runtime.createSubagent(
        caller,
        { name: "failed", prompt: "fail while opening" },
        context,
        undefined,
      ),
    ).rejects.toThrow("open failed");
    expect(widgetCalls.at(-1)).toBeUndefined();

    await runtime.shutdown();
  });
});
