import { describe, expect, it } from "vitest";
import {
  createDelegationStatusSnapshot,
  formatDelegationStatus,
  formatSubagentReport,
} from "../../src/status.js";

describe("delegation status", () => {
  it("formats active direct subagents and shared live usage", () => {
    expect(
      formatDelegationStatus({
        activeDirectSubagents: [
          { id: "sa_worker", name: "worker" },
          { id: "sa_reviewer", name: "reviewer" },
        ],
        activeDirectSubagentCount: 2,
        directSubagents: [
          { id: "sa_worker", name: "worker", state: "running" },
          { id: "sa_reviewer", name: "reviewer", state: "running" },
        ],
        directSubagentCount: 2,
        interruptedDirectSubagentCount: 0,
        liveAgents: 3,
        maxLiveAgents: 8,
      }),
    ).toBe(
      "**2 running, 0 done; shared usage: 3/8.**\n- worker (`sa_worker`): running\n- reviewer (`sa_reviewer`): running",
    );
  });

  it("reports an empty active list", () => {
    expect(
      formatDelegationStatus({
        activeDirectSubagents: [],
        activeDirectSubagentCount: 0,
        directSubagents: [],
        directSubagentCount: 0,
        interruptedDirectSubagentCount: 0,
        liveAgents: 0,
        maxLiveAgents: 8,
      }),
    ).toBe("**0 running, 0 done; shared usage: 0/8.**\n- None");
  });

  it("prompts the direct parent to reuse the reporting agent for related follow-up work", () => {
    expect(
      formatSubagentReport(
        {
          schemaVersion: 1,
          reportId: "report_1",
          rootSessionId: "root_1",
          agentId: "sa_worker",
          runId: "run_1",
          parentAgentId: null,
          parentRunId: null,
          name: "worker",
          agentType: "general",
          cwd: "/project",
          outcome: "completed",
          result: "Done.",
          completedAt: "2026-01-01T00:00:00Z",
        },
        createDelegationStatusSnapshot([], 0, 8),
      ),
    ).toContain(
      "**Follow-up:** For related work in the same area, use `ask_subagent` with ID `sa_worker` to ask this same subagent again.",
    );
  });

  it("lists running and done direct subagents together", () => {
    const snapshot = createDelegationStatusSnapshot([{ id: "sa_worker", name: "worker" }], 1, 8, [
      { id: "sa_done", name: "completed", state: "done" },
      { id: "sa_worker", name: "worker", state: "running" },
    ]);
    expect(formatDelegationStatus(snapshot)).toBe(
      "**1 running, 1 done; shared usage: 1/8.**\n- worker (`sa_worker`): running\n- completed (`sa_done`): done",
    );
  });

  it("labels an interrupted direct subagent", () => {
    const snapshot = createDelegationStatusSnapshot([], 0, 8, [
      { id: "sa_failed", name: "worker", state: "interrupted" },
    ]);
    expect(formatDelegationStatus(snapshot)).toBe(
      "**0 running, 0 done, 1 interrupted; shared usage: 0/8.**\n- worker (`sa_failed`): interrupted",
    );
  });

  it("keeps interrupted and hidden completed agents in the summary counts", () => {
    const direct = Array.from({ length: 12 }, (_, index) => ({
      id: `sa_${index}`,
      name: `worker-${index}`,
      state: index === 11 ? ("interrupted" as const) : ("done" as const),
    }));
    const snapshot = createDelegationStatusSnapshot([], 0, 8, direct);
    expect(snapshot.directSubagents).toHaveLength(10);
    expect(formatDelegationStatus(snapshot)).toContain(
      "**0 running, 11 done, 1 interrupted; shared usage: 0/8.**",
    );
    expect(formatDelegationStatus(snapshot)).toContain("- …and 2 more");
  });

  it("bounds and single-lines model-visible names", () => {
    const activeDirectSubagents = Array.from({ length: 12 }, (_, index) => ({
      id: `sa_${index}`,
      name: index === 0 ? `worker\n${"x".repeat(100)}` : `worker-${index}`,
    }));
    const snapshot = createDelegationStatusSnapshot(activeDirectSubagents, 12, 20);
    const formatted = formatDelegationStatus(snapshot);

    expect(snapshot.activeDirectSubagentCount).toBe(12);
    expect(snapshot.activeDirectSubagents).toHaveLength(10);
    expect(snapshot.activeDirectSubagents[0]?.name).not.toContain("\n");
    expect(snapshot.activeDirectSubagents[0]?.name.length).toBeLessThanOrEqual(80);
    expect(formatted).not.toContain("worker\n");
    expect(formatted).toContain("worker x");
    expect(formatted).toContain("…and 2 more");
    expect(formatted).not.toContain("worker-10");
    expect(formatted).toContain("shared usage: 12/20.");
  });
});
