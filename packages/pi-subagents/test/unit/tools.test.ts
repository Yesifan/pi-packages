import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDelegationExtension, type DelegationRuntimeApi } from "../../src/tools.js";
import type { AcceptedResult, CallerBinding } from "../../src/types.js";

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

describe("delegation tool results", () => {
  it("reminds the caller not to poll a newly created subagent", async () => {
    const runtime: DelegationRuntimeApi = {
      createSubagent: vi.fn(async () => accepted("started")),
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
      {
        type: "text",
        text: "Started subagent worker (sa_test), run run_test. Its final report will arrive automatically; do not poll with ask_subagent or shell wait commands. Continue only with independent work, or end your turn.",
      },
    ]);
  });

  it.each([
    {
      status: "started" as const,
      expected:
        "Started subagent worker (sa_test), run run_test. Its final report will arrive automatically; do not poll with ask_subagent or shell wait commands. Continue only with independent work, or end your turn.",
    },
    {
      status: "steered" as const,
      expected:
        "Steered subagent worker (sa_test), current run run_test. Its final report will arrive automatically; only steer again to provide a substantive correction, not to poll or request completion.",
    },
  ])("explains automatic reporting after an ask returns $status", async ({ status, expected }) => {
    const runtime: DelegationRuntimeApi = {
      createSubagent: vi.fn(),
      askSubagent: vi.fn(async () => accepted(status)),
    };
    const tool = registerTools(runtime).find(({ name }) => name === "ask_subagent");

    const result = await tool?.execute(
      "call",
      { id: "sa_test", prompt: "Continue" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(result?.content).toEqual([{ type: "text", text: expected }]);
  });
});
