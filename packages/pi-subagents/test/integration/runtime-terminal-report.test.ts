import { describe, expect, it, vi } from "vitest";
import { assistant, createHarness } from "../helpers/runtime-harness.js";

describe("terminal reporting", () => {
  it("reports SDK abort without final text once, rather than reusing commentary", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    const child = h.child("worker");
    const progress = assistant("still researching");
    progress.content = [
      {
        type: "text",
        text: "still researching",
        textSignature: JSON.stringify({ v: 1, id: "msg", phase: "commentary" }),
      },
    ];
    child.manager.appendMessage(progress);
    child.streaming = false;
    child.idle = true;
    child.emit({ type: "agent_settled", aborted: true });
    child.completion.resolve();
    await h.flush();
    child.capturedListener?.({ type: "agent_settled", aborted: true });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.report).toMatchObject({ outcome: "aborted", error: { code: "ABORTED" } });
    expect(h.reports[0]?.report.result).not.toContain("still researching");
    expect(h.agent("worker").state).toBe("interrupted");
  });

  it("retains SDK error detail when cancellation is reported without final text", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    const child = h.child("worker");
    child.manager.appendMessage({
      ...assistant("", "aborted"),
      errorMessage: "tool operation cancelled",
    });
    child.streaming = false;
    child.idle = true;
    child.emit({ type: "agent_settled", aborted: true });
    child.completion.resolve();
    await h.flush();
    expect(h.reports[0]?.report.error?.message).toContain("tool operation cancelled");
    expect(h.reports[0]?.report.outcome).toBe("aborted");
  });

  it("does not treat commentary-only success as a completed result", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    const child = h.child("worker");
    const message = assistant("progress only");
    message.content = [
      {
        type: "text",
        text: "progress only",
        textSignature: JSON.stringify({ v: 1, id: "msg", phase: "commentary" }),
      },
    ];
    child.manager.appendMessage(message);
    child.settle();
    await h.flush();
    expect(h.reports[0]?.report).toMatchObject({ outcome: "incomplete" });
    expect(h.reports[0]?.report.result).not.toContain("progress only");
  });

  it("classifies AbortError rejection as cancellation with its known reason", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    h.child("worker").fail(new DOMException("This operation was aborted", "AbortError"));
    await h.flush();
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "aborted",
      error: { message: "This operation was aborted" },
    });
  });

  it("routes a live interruption through the same terminal report path", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    await Reflect.get(h.runtime, "interrupt").call(h.runtime, h.agent("worker").currentExecution);
    await h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "interrupted",
      error: { code: "INTERRUPTED" },
    });
  });

  it("still delivers a failure and releases dependencies when history extraction throws", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    const child = h.child("worker");
    child.streaming = false;
    child.idle = true;
    vi.spyOn(child.manager, "getBranch").mockImplementation(() => {
      throw new Error("history read failed");
    });
    child.completion.resolve();
    await h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "failed",
      error: { code: "SESSION_HISTORY_UNAVAILABLE" },
    });
    expect(h.scope.executions.size).toBe(0);
  });

  it.each(["aborted", "error"] as const)(
    "keeps the nested processing barrier for a child %s",
    async (reason) => {
      const h = await createHarness();
      await h.runtime.createSubagent(
        h.caller,
        { name: "parent", prompt: "coordinate", cwd: h.external },
        h.ctx,
      );
      await h.runtime.createSubagent(
        h.nestedCaller("parent"),
        { name: "worker", prompt: "task" },
        h.ctx,
      );
      const parent = h.child("parent");
      const execution = h.agent("parent").currentExecution!;
      parent.complete("waiting for child");
      const child = h.child("worker", h.agent("parent"));
      child.complete("", reason);
      await h.flush();
      expect(parent.customMessages).toHaveLength(1);
      expect(parent.customMessages[0]?.details).toMatchObject({
        outcome: reason === "aborted" ? "aborted" : "failed",
      });
      expect(execution.pendingReports.size).toBe(1);
      expect(h.reports).toHaveLength(0);
      parent.observeCustom(0);
      parent.settle();
      expect(execution.pendingReports.size).toBe(1); // Not persisted yet.
      parent.persistCustom(0);
      parent.manager.appendMessage(assistant("handled child failure"));
      parent.settle();
      await h.flush();
      expect(h.reports).toHaveLength(1);
      expect(execution.pendingReports.size).toBe(0);
      expect(h.scope.deliveries.size).toBe(0);
    },
  );

  it.each(["sync", "async"] as const)(
    "fails the parent without a stuck report on %s send failure",
    async (kind) => {
      const h = await createHarness();
      await h.runtime.createSubagent(
        h.caller,
        { name: "parent", prompt: "coordinate", cwd: h.external },
        h.ctx,
      );
      await h.runtime.createSubagent(
        h.nestedCaller("parent"),
        { name: "worker", prompt: "task" },
        h.ctx,
      );
      const parent = h.child("parent");
      vi.spyOn(parent.session, "sendCustomMessage").mockImplementation(() => {
        if (kind === "sync") throw new Error("send failed");
        return Promise.reject(new Error("send failed"));
      });
      parent.complete("waiting");
      h.child("worker", h.agent("parent")).complete();
      await h.flush();
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]?.report).toMatchObject({
        name: "parent",
        outcome: "failed",
        error: { message: "send failed" },
      });
      expect(h.scope.deliveries.size).toBe(0);
      expect(h.scope.executions.size).toBe(0);
    },
  );

  it("reports persistence failure and still releases the execution", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    vi.spyOn(h.store, "setChild").mockRejectedValueOnce(new Error("disk full"));
    h.child("worker").complete();
    await h.flush();
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "failed",
      error: { code: "STORE_ERROR", message: "disk full" },
    });
    expect(h.scope.executions.size).toBe(0);
  });

  it("reports cleanup failure without stranding a parent dependency", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    const execution = h.agent("worker").currentExecution!;
    vi.spyOn(execution.opened!, "dispose").mockRejectedValueOnce(new Error("dispose failed"));
    h.child("worker").complete();
    await h.flush();
    expect(h.reports[0]?.report).toMatchObject({
      outcome: "failed",
      error: { code: "SESSION_CLEANUP_FAILED" },
    });
    expect(h.scope.executions.size).toBe(0);
  });

  it("suppresses child notifications when the parent itself fails", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "worker", prompt: "task" },
      h.ctx,
    );
    const parent = h.child("parent");
    parent.fail(new Error("parent failed"));
    await h.flush();
    expect(parent.customMessages).toHaveLength(0);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.report.name).toBe("parent");
    expect(h.scope.executions.size).toBe(0);
  });

  it("logs failed root delivery without pretending it was processed or retrying", async () => {
    const h = await createHarness();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(h.host, "sendReport").mockImplementation(() => {
      throw new Error("send failed");
    });
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    h.child("worker").complete();
    await h.flush();
    expect(h.host.sendReport).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(" ")).toContain("delivery_failed");
    expect(h.scope.deliveries.size).toBe(0);
    log.mockRestore();
  });

  it("logs shutdown suppression and preserves interrupted state without misdelivery", async () => {
    const h = await createHarness();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
    await h.runtime.shutdown();
    expect(h.reports).toHaveLength(0);
    expect(h.agent("worker").state).toBe("interrupted");
    expect(log.mock.calls.flat().join(" ")).toContain("root_closed");
    log.mockRestore();
  });
});
