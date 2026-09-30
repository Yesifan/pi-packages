import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SubagentError } from "../../src/errors.js";
import { createDelegationExtension, type DelegationRuntimeApi } from "../../src/tools.js";
import type { AcceptedResult, CallerBinding, DelegationStatusSnapshot } from "../../src/types.js";

const caller: CallerBinding = {
  agentId: null,
  depth: 0,
  ancestorCwds: ["/workspace/project"],
  delegation: {
    cwd: "/workspace/project",
    projectRoot: "/workspace/project",
    externalDirectories: [],
    agentTypes: new Map(),
  },
};

const delegationStatus: DelegationStatusSnapshot = {
  activeDirectSubagents: [
    { id: "sa_test", name: "worker" },
    { id: "sa_scout", name: "scout" },
  ],
  activeDirectSubagentCount: 2,
  directSubagents: [
    { id: "sa_test", name: "worker", state: "running" },
    { id: "sa_scout", name: "scout", state: "running" },
  ],
  directSubagentCount: 2,
  interruptedDirectSubagentCount: 0,
  liveAgents: 3,
  maxLiveAgents: 8,
};

function accepted(status: "started" | "steered"): AcceptedResult {
  return {
    ok: true,
    id: "sa_test",
    run_id: "run_test",
    name: "worker",
    agent_type: "general",
    cwd: "/workspace/project",
    status,
    thinking: "off",
    delegation_status: delegationStatus,
  };
}

function registerTools(runtime: DelegationRuntimeApi): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI;
  createDelegationExtension(runtime, caller)(pi);
  return tools;
}

function statusText(): string {
  return "**2 running, 0 done; shared usage: 3/8.**\n- worker (`sa_test`): running\n- scout (`sa_scout`): running";
}

describe("delegation tool results", () => {
  it("reports asynchronous startup, completion discipline, and steering guidance", async () => {
    const getMaxLiveAgents = vi.fn(() => 8);
    const runtime: DelegationRuntimeApi = {
      getMaxLiveAgents,
      createSubagent: vi.fn(async () => accepted("started")),
      askSubagent: vi.fn(),
    };
    const tool = registerTools(runtime).find(({ name }) => name === "subagent");
    const registeredDescription = tool?.description;

    const result = await tool?.execute(
      "call",
      { name: "worker", prompt: "Investigate" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(result?.content).toEqual([
      {
        type: "text",
        text: "Started background subagent worker (sa_test).",
      },
      {
        type: "text",
        text: "Its report will arrive automatically. Do not poll, redo, or re-delegate its task. To adjust the direction of an actively streaming run or add new context, use ask_subagent with its id and isSteer: true; this steers the same run and does not create a separate report. Until all relevant reports arrive, give only a brief progress update that identifies the active subagents, then end your turn.",
      },
      { type: "text", text: statusText() },
    ]);
    expect(result?.content).not.toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("run_test") }),
    );
    expect(tool?.description).toBe(registeredDescription);
    expect(getMaxLiveAgents).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: "started" as const,
      firstLine: "Started background subagent worker (sa_test).",
      isSteer: false,
    },
    {
      status: "steered" as const,
      firstLine: "Steered background subagent worker (sa_test).",
      isSteer: true,
    },
  ])("returns status after an ask is $status", async ({ status, firstLine, isSteer }) => {
    const runtime: DelegationRuntimeApi = {
      getMaxLiveAgents: () => 8,
      createSubagent: vi.fn(),
      askSubagent: vi.fn(async () => accepted(status)),
    };
    const tool = registerTools(runtime).find(({ name }) => name === "ask_subagent");

    const result = await tool?.execute(
      "call",
      { id: "sa_test", prompt: "Continue", isSteer },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(runtime.askSubagent).toHaveBeenCalledWith(
      caller,
      { id: "sa_test", prompt: "Continue", isSteer },
      expect.anything(),
      undefined,
    );
    expect(result?.content).toEqual([
      { type: "text", text: firstLine },
      {
        type: "text",
        text: "Its report will arrive automatically. Do not poll, redo, or re-delegate its task. To adjust the direction of an actively streaming run or add new context, use ask_subagent with its id and isSteer: true; this steers the same run and does not create a separate report. Until all relevant reports arrive, give only a brief progress update that identifies the active subagents, then end your turn.",
      },
      { type: "text", text: statusText() },
    ]);
  });

  it.each(["SUBAGENT_BUSY", "LIVE_AGENT_LIMIT"])(
    "includes current status with %s errors",
    async (code) => {
      const runtime: DelegationRuntimeApi = {
        getMaxLiveAgents: () => 8,
        createSubagent: vi.fn(async () => {
          throw new SubagentError(code, "Cannot start", "sa_test", {
            delegationStatus,
          });
        }),
        askSubagent: vi.fn(),
      };
      const tool = registerTools(runtime).find(({ name }) => name === "subagent");

      const result = await tool?.execute(
        "call",
        { name: "worker", prompt: "Investigate" },
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      expect(result?.content).toEqual([
        { type: "text", text: `${code}: Cannot start` },
        { type: "text", text: statusText() },
      ]);
      expect(result?.details).toMatchObject({
        ok: false,
        delegation_status: delegationStatus,
      });
    },
  );
});
