import { describe, expect, it } from "vitest";
import { createDelegationStatusSnapshot, formatDelegationStatus } from "../../src/status.js";

describe("delegation status", () => {
  it("formats active direct subagents and shared live usage", () => {
    expect(
      formatDelegationStatus({
        activeDirectSubagents: [
          { id: "sa_worker", name: "worker" },
          { id: "sa_reviewer", name: "reviewer" },
        ],
        activeDirectSubagentCount: 2,
        liveAgents: 3,
        maxLiveAgents: 8,
      }),
    ).toBe(
      "Active direct subagents (2): worker (sa_worker), reviewer (sa_reviewer).\nShared live usage: 3/8.",
    );
  });

  it("reports an empty active list", () => {
    expect(
      formatDelegationStatus({
        activeDirectSubagents: [],
        activeDirectSubagentCount: 0,
        liveAgents: 0,
        maxLiveAgents: 8,
      }),
    ).toBe("Active direct subagents: none.\nShared live usage: 0/8.");
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
    expect(formatted).toContain("+2 more");
    expect(formatted).not.toContain("worker-10");
    expect(formatted).toContain("Shared live usage: 12/20.");
  });
});
