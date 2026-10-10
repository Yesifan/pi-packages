import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SubagentError } from "../../src/errors.js";
import { createDelegationStatusSnapshot, formatDelegationStatus } from "../../src/status.js";
import { createDelegationExtension, type DelegationRuntimeApi } from "../../src/tools.js";
import type { AcceptedResult, CallerBinding } from "../../src/types.js";

const caller: CallerBinding = {
  agent: null,
  depth: 0,
  ancestorCwds: ["/project"],
  delegation: {
    cwd: "/project",
    projectRoot: "/project",
    externalDirectories: [],
    agentTypes: new Map(),
  },
};
const status = createDelegationStatusSnapshot([{ name: "worker", agentType: "general" }], 1, 8);
const accepted = (state: "started" | "steered"): AcceptedResult => ({
  ok: true,
  name: "worker",
  agent_type: "general",
  cwd: "/project",
  status: state,
  thinking: "off",
  delegation_status: status,
});
function tools(runtime: DelegationRuntimeApi): ToolDefinition[] {
  const result: ToolDefinition[] = [];
  createDelegationExtension(
    runtime,
    caller,
  )({ registerTool: (tool: ToolDefinition) => result.push(tool) } as unknown as ExtensionAPI);
  return result;
}
const context = { tools: [], executeTool: vi.fn() } as unknown as ExtensionToolContext;
function runtime(): DelegationRuntimeApi {
  return {
    getMaxLiveAgents: vi.fn(() => 8),
    createSubagent: vi.fn(async () => accepted("started")),
    askSubagent: vi.fn(async (_caller, params) => accepted(params.isSteer ? "steered" : "started")),
  };
}
describe("name delegation tools", () => {
  it("accepts name only for asks and retains thinking/steering schemas", () => {
    const registered = tools(runtime());
    const create = registered.find((tool) => tool.name === "subagent")!;
    const ask = registered.find((tool) => tool.name === "ask_subagent")!;
    const createSchema = create.parameters as {
      properties: Record<string, { enum?: string[]; description?: string }>;
    };
    const askSchema = ask.parameters as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(createSchema.properties.thinking?.enum).toEqual(["off", "low", "medium", "high", "max"]);
    expect(askSchema.required).toEqual(["name", "prompt"]);
    expect(askSchema.properties).not.toHaveProperty("id");
    expect(askSchema.additionalProperties).toBe(false);
    expect(askSchema.properties).toHaveProperty("isSteer");
    expect(createSchema.properties.agent_type?.description).toContain(
      "Must be one of the agent types listed",
    );
    expect(createSchema.properties.cwd?.description).toContain("must exactly match");
    expect(createSchema.properties.cwd?.description).toContain("Relative paths, ~, $HOME");
  });
  it("returns name/role/status without business IDs or dynamic description updates", async () => {
    const implementation = runtime();
    const tool = tools(implementation).find((tool) => tool.name === "subagent")!;
    const description = tool.description;
    const result = await tool.execute(
      "sdk-call",
      { name: "worker", prompt: "work" },
      undefined,
      undefined,
      context,
    );
    expect(result.details).toEqual(accepted("started"));
    expect(result.details).not.toHaveProperty("id");
    expect(result.details).not.toHaveProperty("run_id");
    expect(result.content).toContainEqual({
      type: "text",
      text: "Started background subagent worker (role: general).",
    });
    expect(result.content).toContainEqual({ type: "text", text: formatDelegationStatus(status) });
    expect(JSON.stringify(result.content)).toContain("isSteer: true");
    expect(tool.description).toBe(description);
    expect(implementation.getMaxLiveAgents).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "addresses ordinary/steering asks by full name (isSteer=%s)",
    async (isSteer) => {
      const implementation = runtime();
      const tool = tools(implementation).find((entry) => entry.name === "ask_subagent")!;
      const result = await tool.execute(
        "sdk-call",
        { name: "worker", prompt: "continue", isSteer },
        undefined,
        undefined,
        context,
      );
      expect(implementation.askSubagent).toHaveBeenCalledWith(
        caller,
        { name: "worker", prompt: "continue", isSteer },
        context,
        undefined,
      );
      expect(result.details).toEqual(accepted(isSteer ? "steered" : "started"));
    },
  );
  it.each(["SUBAGENT_BUSY", "LIVE_AGENT_LIMIT"])(
    "includes the same named status for %s without internal IDs",
    async (code) => {
      const implementation = runtime();
      implementation.createSubagent = vi.fn(async () => {
        throw new SubagentError(code, "Cannot start", undefined, { delegationStatus: status });
      });
      const result = await tools(implementation)[0]!.execute(
        "sdk-call",
        { name: "worker", prompt: "work" },
        undefined,
        undefined,
        context,
      );
      expect(result.details).toEqual({
        ok: false,
        error: { code, message: "Cannot start" },
        delegation_status: status,
      });
    },
  );
});
