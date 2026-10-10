import { readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDelegationStatusSnapshot, formatSubagentReport } from "../../src/status.js";
import { assistant, createHarness, deferred } from "../helpers/runtime-harness.js";

async function startedWorker() {
  const h = await createHarness();
  await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "task" }, h.ctx);
  const child = h.child("worker");
  child.manager.appendMessage(assistant("Done."));
  return { h, child, file: child.manager.getSessionFile()! };
}

describe("report history validation", () => {
  it("advertises the actual valid private SDK history, without expanding its body or storing results", async () => {
    const { h, child, file } = await startedWorker();
    const history = await readFile(file, "utf8");
    expect(history).toContain('"type":"session"');
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    child.settle();
    await h.flush();
    expect(h.reports).toHaveLength(1);
    const { report, status } = h.reports[0]!;
    expect(report).toMatchObject({
      name: "worker",
      agentType: "general",
      outcome: "completed",
      result: "Done.",
      sessionFile: file,
    });
    const content = formatSubagentReport(report, status);
    expect(content).toContain(
      `Complete conversation: \`${file}\`. Read it if more context is needed.`,
    );
    expect(content).not.toContain("Full session");
    expect(content.indexOf("Complete conversation:")).toBeLessThan(content.indexOf("Done."));
    expect(content).not.toContain(history);
    expect(content).not.toContain("run_id");
    expect(content).not.toContain("agentId");
    const record = (await h.store.readOwner(h.scope.identity, null))!;
    expect(record.children.worker!.state).toBe("idle");
    expect(JSON.stringify(record)).not.toContain("Done.");
    expect(JSON.stringify(record)).not.toContain("delivery");
    expect(h.scope.deliveries.size).toBe(0);
  });

  it.each([
    "malformed",
    "empty",
    "wrong-type",
    "wrong-id",
    "wrong-cwd",
    "missing",
    "symlink",
  ] as const)("marks %s history unavailable but still delivers the online result", async (kind) => {
    const { h, child, file } = await startedWorker();
    const header = child.manager.getHeader()!;
    let replacement: string | undefined;
    if (kind === "missing") await rm(file);
    else if (kind === "symlink") {
      const target = path.join(h.root, "elsewhere.jsonl");
      await writeFile(target, await readFile(file));
      await rm(file);
      await symlink(target, file);
    } else {
      replacement =
        kind === "malformed"
          ? "not-json\n"
          : kind === "empty"
            ? ""
            : `${JSON.stringify({ ...header, ...(kind === "wrong-type" ? { type: "message" } : kind === "wrong-id" ? { id: "unrelated-session" } : { cwd: h.root }) })}\n`;
      await writeFile(file, replacement);
    }
    child.settle();
    await h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.report).toMatchObject({ result: "Done.", outcome: "completed" });
    expect(h.reports[0]!.report.sessionFile).toBeUndefined();
    expect(formatSubagentReport(h.reports[0]!.report, h.reports[0]!.status)).toContain(
      "Complete conversation unavailable:",
    );
    if (replacement !== undefined) expect(await readFile(file, "utf8")).toBe(replacement);
  });

  it.each(["id", "cwd", "file"] as const)(
    "does not advertise history when the captured mount has a different %s",
    async (field) => {
      const { h, child, file } = await startedWorker();
      const other = path.join(h.root, "other.jsonl");
      await writeFile(other, await readFile(file));
      if (field === "id") vi.spyOn(child.manager, "getSessionId").mockReturnValue("other-session");
      else if (field === "cwd") vi.spyOn(child.manager, "getCwd").mockReturnValue(h.root);
      else vi.spyOn(child.manager, "getSessionFile").mockReturnValue(other);
      child.settle();
      await h.flush();
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]!.report.sessionFile).toBeUndefined();
      expect(h.reports[0]!.report.result).toBe("Done.");
    },
  );

  it("does not advertise a malformed JSONL body even when its header is valid", async () => {
    const { h, child, file } = await startedWorker();
    const content = `${JSON.stringify(child.manager.getHeader())}\nnot-valid-json\n`;
    await writeFile(file, content);
    child.settle();
    await h.flush();
    expect(h.reports[0]!.report.sessionFile).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(content);
  });
});

describe("scope-bound report delivery", () => {
  it.each(["shutdown", "replacement"] as const)(
    "does not deliver after %s while history validation is suspended",
    async (action) => {
      const { h, child } = await startedWorker();
      const reached = deferred();
      const resume = deferred();
      const open = h.factory.openSessionManager.bind(h.factory);
      vi.spyOn(h.factory, "openSessionManager").mockImplementation(async (identity) => {
        reached.resolve();
        await resume.promise;
        return open(identity);
      });
      child.settle();
      await reached.promise;
      expect(h.agent("worker").currentExecution).toBeUndefined();
      expect(h.scope.deliveries.size).toBe(1);
      if (action === "shutdown") await h.runtime.shutdown();
      else {
        const replacement = await h.restart();
        expect(Reflect.get(replacement, "scope")).not.toBe(h.scope);
      }
      resume.resolve();
      await h.flush();
      expect(h.reports).toHaveLength(0);
      expect(h.scope.deliveries.size).toBe(0);
    },
  );

  it("does not substitute old successful text when the next execution fails or produces no text", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "first" }, h.ctx);
    h.child("worker").complete("OLD SUCCESS MUST NOT LEAK");
    await h.flush();
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "second" }, h.ctx);
    h.child("worker").fail(new Error("model failed this execution"));
    await h.flush();
    expect(h.reports).toHaveLength(2);
    const failed = h.reports[1]!.report;
    expect(failed).toMatchObject({
      outcome: "failed",
      result: "",
      error: { message: "model failed this execution" },
    });
    expect(formatSubagentReport(failed, createDelegationStatusSnapshot([], 0, 8))).not.toContain(
      "OLD SUCCESS",
    );
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "third" }, h.ctx);
    h.child("worker").settle();
    await h.flush();
    expect(h.reports[2]!.report).toMatchObject({
      outcome: "incomplete",
      result: "No final assistant text was produced for this task.",
    });
  });
});

describe("nested report processing barriers", () => {
  it("transfers children to reports atomically and waits for cloned message_end, persisted entry and subsequent settled", async () => {
    const h = await createHarness({ hasUI: true });
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    await h.runtime.createSubagent(
      h.caller,
      { name: "root-sibling", prompt: "independent" },
      h.ctx,
    );
    const caller = h.nestedCaller("parent");
    for (const name of ["nested-worker", "nested-reviewer"])
      await h.runtime.createSubagent(caller, { name, prompt: "work" }, h.ctx);
    const parent = h.child("parent");
    const execution = h.agent("parent").currentExecution!;
    parent.complete("not the final result");
    expect(execution.phase).toBe("waiting");
    expect(parent.disposals).toBe(0);
    expect(execution.pendingChildren.size).toBe(2);
    const worker = h.child("nested-worker", h.agent("parent"));
    worker.complete("worker done");
    await worker.completion.promise; // Capture prompt outcome after the SDK settled event.
    await Promise.resolve(); // Runs the finalize microtask up to its first (store) await.
    expect(execution.pendingChildren.size).toBe(1);
    expect(execution.pendingReports.size).toBe(1);
    expect(execution.finalizing).toBe(false);
    const first = await parent.waitCustom(0);
    expect(first.content).toContain(
      `Complete conversation: \`${worker.manager.getSessionFile()}\``,
    );
    expect(first.content).not.toContain("root-sibling");
    expect(first.content).not.toContain("Full session");
    expect(first.details).toMatchObject({
      delegation_status: {
        directSubagents: [
          { name: "nested-reviewer", agentType: "general", state: "running" },
          { name: "nested-worker", agentType: "general", state: "done" },
        ],
        directSubagentCount: 2,
      },
    });
    expect(first.content).toContain(
      "use `ask_subagent` with the full name of any idle subagent listed above",
    );
    const reviewer = h.child("nested-reviewer", h.agent("parent"));
    reviewer.complete("reviewer done");
    await parent.waitCustom(1);
    await h.flush();
    expect(execution.pendingChildren.size).toBe(0);
    expect(execution.pendingReports.size).toBe(2);
    expect(h.reports).toHaveLength(0); // Both send promises resolved, neither was processed.
    expect(parent.disposals).toBe(0);
    // The public event happens before SDK persistence. A premature settled is insufficient.
    parent.observeCustom(1);
    parent.settle();
    expect(execution.pendingReports.size).toBe(2);
    expect(execution.finalizing).toBe(false);
    expect(parent.disposals).toBe(0);
    parent.persistCustom(1);
    expect(execution.pendingReports.size).toBe(2);
    parent.settle();
    expect(execution.pendingReports.size).toBe(1);
    expect(execution.phase).toBe("waiting");
    parent.observeCustom(0);
    parent.persistCustom(0);
    expect(execution.pendingReports.size).toBe(1);
    parent.manager.appendMessage(assistant("parent final after both reports"));
    parent.settle();
    parent.capturedListener?.({ type: "agent_settled" });
    await h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.report).toMatchObject({
      name: "parent",
      result: "parent final after both reports",
      outcome: "completed",
    });
    expect(parent.disposals).toBe(1);
    expect(h.scope.deliveries.size).toBe(0);
    expect(h.scope.executions.size).toBe(1); // Only the independent root sibling is still active.
  });

  it("keeps E1's submitted delivery valid when the sender has already started E2", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const caller = h.nestedCaller("parent");
    await h.runtime.createSubagent(caller, { name: "worker", prompt: "first" }, h.ctx);
    const agent = h.agent("worker", h.agent("parent"));
    const firstExecution = agent.currentExecution!;
    const first = h.child("worker", h.agent("parent"));
    const parent = h.child("parent");
    parent.complete("waiting");
    first.complete("E1 result");
    await parent.waitCustom(0);
    await h.flush();
    const delivery = [...h.scope.deliveries][0]!;
    expect(delivery.source).toBe(firstExecution);
    expect(delivery.submitted).toBe(true);
    expect(agent.currentExecution).toBeUndefined();
    await h.runtime.askSubagent(caller, { name: "worker", prompt: "second" }, h.ctx);
    const secondExecution = agent.currentExecution!;
    const second = h.child("worker", h.agent("parent"));
    expect(secondExecution).not.toBe(firstExecution);
    parent.observeCustom(0);
    parent.persistCustom(0);
    parent.settle();
    expect(delivery.processed).toBe(true);
    expect(h.scope.deliveries.has(delivery)).toBe(false);
    expect(agent.currentExecution).toBe(secondExecution);
    expect(second.disposals).toBe(0);
    expect(h.agent("parent").currentExecution!.pendingChildren.has(secondExecution)).toBe(true);
    expect(parent.disposals).toBe(0);
    first.capturedListener?.({ type: "agent_settled" });
    expect(parent.customMessages).toHaveLength(1);
    second.complete("E2 result");
    await parent.waitCustom(1);
    parent.observeCustom(1);
    parent.persistCustom(1);
    parent.manager.appendMessage(assistant("parent final"));
    parent.settle();
    await h.flush();
    expect(parent.customMessages).toHaveLength(2);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.report.name).toBe("parent");
  });

  it("allows E2 to start before E1's path validation finishes without dropping E1's report", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const caller = h.nestedCaller("parent");
    await h.runtime.createSubagent(caller, { name: "worker", prompt: "first" }, h.ctx);
    const agent = h.agent("worker", h.agent("parent"));
    const firstExecution = agent.currentExecution!;
    const reached = deferred();
    const resume = deferred();
    const open = h.factory.openSessionManager.bind(h.factory);
    let gated = false;
    vi.spyOn(h.factory, "openSessionManager").mockImplementation(async (identity) => {
      if (!gated && identity.sessionId === agent.identity!.sessionId) {
        gated = true;
        reached.resolve();
        await resume.promise;
      }
      return open(identity);
    });
    h.child("worker", h.agent("parent")).complete("E1 ready");
    await reached.promise;
    expect(agent.currentExecution).toBeUndefined();
    const delivery = [...h.scope.deliveries][0]!;
    expect(delivery.submitted).toBe(false);
    await h.runtime.askSubagent(caller, { name: "worker", prompt: "E2" }, h.ctx);
    const secondExecution = agent.currentExecution;
    resume.resolve();
    const message = await h.child("parent").waitCustom();
    await h.flush();
    expect(message.content).toContain("E1 ready");
    expect(delivery.source).toBe(firstExecution);
    expect(agent.currentExecution).toBe(secondExecution);
    expect(h.child("worker", h.agent("parent")).disposals).toBe(0);
    expect(h.child("parent").disposals).toBe(0);
  });
});
