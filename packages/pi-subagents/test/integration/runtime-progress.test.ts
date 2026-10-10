import { describe, expect, it } from "vitest";
import { createHarness } from "../helpers/runtime-harness.js";

describe("runtime progress widget", () => {
  it("tracks independent active progress and saved-role report snapshots then clears the widget", async () => {
    const h = await createHarness({ hasUI: true });
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx);
    await h.runtime.createSubagent(
      h.caller,
      { name: "reviewer", prompt: "review", agent_type: "explore" },
      h.ctx,
    );
    expect(h.widgets.at(-1)).toEqual(["worker[0]：starting", "reviewer[0]：starting"]);
    const worker = h.child("worker");
    const reviewer = h.child("reviewer");
    worker.emit({ type: "turn_start" });
    worker.emit({
      type: "tool_execution_start",
      toolCallId: "tool-worker",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    reviewer.emit({ type: "turn_start" });
    expect(h.widgets.at(-1)).toEqual(["worker[1]：bash pnpm test", "reviewer[1]：thinking"]);
    worker.complete("worker done");
    await h.flush();
    expect(h.widgets.at(-1)).toEqual(["reviewer[1]：thinking"]);
    expect(h.reports[0]!.status).toMatchObject({
      activeDirectSubagents: [{ name: "reviewer", agentType: "explore" }],
      activeDirectSubagentCount: 1,
      liveAgents: 1,
      directSubagentCount: 2,
    });
    expect(h.reports[0]!.status.directSubagents).toEqual([
      { name: "reviewer", agentType: "explore", state: "running" },
      { name: "worker", agentType: "general", state: "done" },
    ]);
    expect(h.reports[0]!.report.sessionFile).toBe(worker.manager.getSessionFile());
    h.caller.delegation.agentTypes.set("explore", {
      ...h.caller.delegation.agentTypes.get("general")!,
      id: "replacement",
    });
    reviewer.complete("reviewer done");
    await h.flush();
    expect(h.widgets.at(-1)).toBeUndefined();
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]!.status).toMatchObject({
      activeDirectSubagents: [],
      directSubagentCount: 2,
      liveAgents: 0,
    });
    expect(h.reports[1]!.status.directSubagents).toContainEqual({
      name: "reviewer",
      agentType: "explore",
      state: "done",
    });
    reviewer.capturedListener?.({ type: "turn_start" });
    expect(h.widgets.at(-1)).toBeUndefined();
  });

  it("rejects E1's stale callbacks without changing E2's progress or releasing its reservation", async () => {
    const h = await createHarness({ hasUI: true });
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "first" }, h.ctx);
    const first = h.child("worker");
    first.emit({ type: "turn_start" });
    first.complete("first done");
    await h.flush();
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "second" }, h.ctx);
    const second = h.child("worker");
    const execution = h.agent("worker").currentExecution;
    expect(h.widgets.at(-1)).toEqual(["worker[0]：starting"]);
    second.emit({ type: "turn_start" });
    const count = h.widgets.length;
    first.capturedListener?.({ type: "turn_start" });
    first.capturedListener?.({
      type: "tool_execution_start",
      toolCallId: "stale",
      toolName: "bash",
      args: { command: "stale output" },
    });
    first.capturedListener?.({ type: "agent_settled" });
    await h.flush();
    expect(h.widgets).toHaveLength(count);
    expect(h.widgets.at(-1)).toEqual(["worker[1]：thinking"]);
    expect(h.agent("worker").currentExecution).toBe(execution);
    expect(h.scope.executions.size).toBe(1);
    expect(second.disposals).toBe(0);
    expect(h.reports).toHaveLength(1);
    second.complete("second done");
    await h.flush();
    expect(h.widgets.at(-1)).toBeUndefined();
  });

  it("rolls back failed opening progress and shuts down all descendants idempotently", async () => {
    const h = await createHarness({ hasUI: true });
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "nested", prompt: "work" },
      h.ctx,
    );
    const before = h.widgets.at(-1);
    h.failNextOpen();
    await expect(
      h.runtime.createSubagent(h.caller, { name: "failed", prompt: "fail" }, h.ctx),
    ).rejects.toThrow("open failed");
    expect(h.widgets.at(-1)).toEqual(before);
    const callbacks = h.children.map((child) => child.capturedListener);
    const shutdown = h.runtime.shutdown();
    expect(h.runtime.shutdown()).toBe(shutdown);
    await shutdown;
    expect(h.widgets.at(-1)).toBeUndefined();
    expect(h.scope.executions.size).toBe(0);
    expect(h.scope.deliveries.size).toBe(0);
    expect(h.children.every((child) => child.disposals === 1 && child.aborts === 1)).toBe(true);
    for (const callback of callbacks) callback?.({ type: "turn_start" });
    expect(h.widgets.at(-1)).toBeUndefined();
    expect(h.reports).toHaveLength(0);
  });
});
