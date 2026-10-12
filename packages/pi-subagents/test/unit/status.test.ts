import { describe, expect, it } from "vitest";
import {
  createDelegationStatusSnapshot,
  formatDelegationStatus,
  formatSubagentReport,
} from "../../src/status.js";
import type { SubagentReport } from "../../src/types.js";

const worker = { name: "worker", agentType: "explore" };
const reviewer = { name: "reviewer", agentType: "general" };
const report: SubagentReport = {
  name: "worker",
  agentType: "explore",
  cwd: "/project",
  outcome: "completed",
  result: "Done.",
};
describe("name/role status snapshots", () => {
  it("orders running before done and includes initialization in shared usage", () => {
    const snapshot = createDelegationStatusSnapshot([worker], 3, 8, [
      { ...reviewer, state: "done" },
      { ...worker, state: "running" },
    ]);
    expect(snapshot.directSubagents).toEqual([
      { ...worker, state: "running" },
      { ...reviewer, state: "done" },
    ]);
    expect(formatDelegationStatus(snapshot)).toBe(
      "**1 running, 1 done; shared usage: 3/8 (includes initialization).**\n- worker (role: explore): running\n- reviewer (role: general): done",
    );
  });
  it("shows none for an empty list", () => {
    expect(formatDelegationStatus(createDelegationStatusSnapshot([], 0, 8))).toContain("\n- None");
  });
  it("counts interrupted entries and never omits direct children", () => {
    const children = Array.from({ length: 12 }, (_, index) => ({
      name: `worker-${index}`,
      agentType: "explore",
      state: index === 11 ? ("interrupted" as const) : ("done" as const),
    }));
    const snapshot = createDelegationStatusSnapshot([], 0, 8, children);
    expect(snapshot.directSubagentCount).toBe(12);
    expect(snapshot.interruptedDirectSubagentCount).toBe(1);
    const content = formatDelegationStatus(snapshot);
    expect(content).toContain("0 running, 11 done, 1 interrupted");
    for (const child of children)
      expect(content).toContain(`- ${child.name} (role: explore): ${child.state}`);
  });
  it("compacts display labels only, preserving the full name for precise asks", () => {
    const name = `worker\n${"x".repeat(100)}`;
    const snapshot = createDelegationStatusSnapshot([{ name, agentType: "explore" }], 1, 8);
    expect(snapshot.activeDirectSubagents[0]?.name).toBe(name);
    expect(snapshot.directSubagents[0]?.name).toBe(name);
    const formatted = formatDelegationStatus(snapshot);
    expect(formatted).not.toContain(name);
    expect(formatted).toContain("… (role: explore)");
  });
});
describe("automatic reports", () => {
  const status = createDelegationStatusSnapshot([], 0, 8, [{ ...worker, state: "done" }]);
  it.each(["completed", "failed"] as const)(
    "puts the %s history path before results without a separate title or business IDs",
    (outcome) => {
      const formatted = formatSubagentReport(
        { ...report, outcome, sessionFile: "/history/session.jsonl" },
        status,
      );
      const line =
        "Complete conversation: `/history/session.jsonl`. Read it if more context is needed.";
      expect(formatted).toContain(line);
      expect(formatted.indexOf(line)).toBeGreaterThan(formatted.indexOf("> role:"));
      expect(formatted.indexOf(line)).toBeLessThan(formatted.indexOf("## Result"));
      expect(formatted).not.toContain("Full session");
      expect(formatted).not.toMatch(/agentId|runId|reportId/);
      expect(formatted).toContain("full name of any idle subagent");
    },
  );
  it("marks unavailable histories instead of guessing", () => {
    expect(formatSubagentReport(report, status)).toContain("Complete conversation unavailable:");
    expect(formatSubagentReport(report, status)).not.toContain("Complete conversation: `");
  });
});
