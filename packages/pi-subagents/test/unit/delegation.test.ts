import { describe, expect, it } from "vitest";
import { formatSubagentToolDescription } from "../../src/delegation.js";
import { assertNoDelegationCycle } from "../../src/paths.js";
import type { AgentDefinitionSnapshot, DelegationContext } from "../../src/types.js";

function agent(id: string, description: string): AgentDefinitionSnapshot {
  return {
    id,
    description,
    prompt: `${id} prompt`,
    source: `/agents/${id}.md`,
    contentHash: id,
  };
}

describe("delegation context", () => {
  it("describes only the current caller's agents and canonical cwd list", () => {
    const context: DelegationContext = {
      cwd: "/workspace/B",
      projectRoot: "/workspace/B",
      externalDirectories: ["/workspace/C"],
      agentTypes: new Map([
        ["general", agent("general", "General work")],
        ["tester", agent("tester", "Run tests")],
      ]),
    };
    const description = formatSubagentToolDescription(context, 6);
    expect(description).toContain("issuing multiple subagent calls");
    expect(description).toContain("configured shared limit is 6 live subagents");
    expect(description).toMatch(/Give the final answer only after all relevant\s+reports arrive/);
    expect(description).toContain("- general: General work");
    expect(description).toContain("- tester: Run tests");
    expect(description).toContain("- /workspace/B");
    expect(description).toContain("- /workspace/C");
    expect(description).not.toContain("general prompt");
  });

  it("detects cycles from the canonical cwd ancestor chain", () => {
    expect(() =>
      assertNoDelegationCycle("/workspace/C", ["/workspace/A", "/workspace/B"]),
    ).not.toThrow();
    expect(() =>
      assertNoDelegationCycle("/workspace/A", ["/workspace/A", "/workspace/B"]),
    ).toThrowError(/DELEGATION_CYCLE|cycle/i);
  });
});
