import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createHarness, deferred } from "../helpers/runtime-harness.js";

describe("runtime steering and acceptance", () => {
  it("requires external project trust before creating history or loading resources", async () => {
    const h = await createHarness({ realTrust: true });
    await mkdir(path.join(h.external, ".pi", "subagents"), { recursive: true });
    await writeFile(path.join(h.external, ".pi", "subagents", "setting.json"), "{}\n");
    await expect(
      h.runtime.createSubagent(
        h.caller,
        { name: "untrusted", prompt: "work", cwd: h.external },
        h.ctx,
      ),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_TRUSTED" });
    expect(h.mounts).toHaveLength(0);
    expect(h.scope.children.size).toBe(0);
    const allowed = path.join(h.root, "allowed");
    const denied = path.join(allowed, "denied");
    await mkdir(denied, { recursive: true });
    const trust = new ProjectTrustStore(h.agentDir);
    trust.set(allowed, true);
    trust.set(denied, false);
    const resolveTrust = Reflect.get(h.runtime, "resolveTrust") as (
      cwd: string,
    ) => Promise<boolean>;
    await expect(resolveTrust.call(h.runtime, denied)).resolves.toBe(false);
  });

  it("accepts queued steering into the same Execution and produces exactly one report", async () => {
    const h = await createHarness({ hasUI: true });
    const startController = new AbortController();
    h.configureNext((child) => {
      child.afterPreflight = () => startController.abort();
    });
    const started = await h.runtime.createSubagent(
      h.caller,
      { name: "worker", prompt: "start" },
      h.ctx,
      startController.signal,
    );
    const agent = h.agent("worker");
    const execution = agent.currentExecution;
    const child = h.child("worker");
    expect(startController.signal.aborted).toBe(true);
    expect(child.aborts).toBe(0);
    expect((await h.store.readOwner(h.scope.identity, null))!.children.worker?.state).toBe(
      "running",
    );
    child.emit({ type: "turn_start" });
    child.emit({
      type: "tool_execution_start",
      toolCallId: "tool",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    expect(h.widgets.at(-1)).toEqual(["worker[1]：bash pnpm test"]);
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "ordinary" }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_BUSY" });
    const steerController = new AbortController();
    child.afterPreflight = () => steerController.abort();
    const steered = await h.runtime.askSubagent(
      h.caller,
      { name: " worker ", prompt: "focus", isSteer: true },
      h.ctx,
      steerController.signal,
    );
    expect(steered).toMatchObject({
      name: started.name,
      status: "steered",
      delegation_status: {
        activeDirectSubagents: [{ name: "worker", agentType: "general" }],
        liveAgents: 1,
      },
    });
    expect(steered).not.toHaveProperty("run_id");
    expect(steered).not.toHaveProperty("id");
    expect(steerController.signal.aborted).toBe(true);
    expect(agent.currentExecution).toBe(execution);
    expect(h.mounts).toHaveLength(1);
    expect(child.aborts).toBe(0);
    expect(child.promptCalls.map((call) => call.options.streamingBehavior)).toEqual([
      undefined,
      "steer",
    ]);
    expect(child.promptCalls.every((call) => call.options.expandPromptTemplates === false)).toBe(
      true,
    );
    child.complete("steered final");
    child.capturedListener?.({ type: "agent_settled" });
    await h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.report).toMatchObject({
      name: "worker",
      result: "steered final",
      outcome: "completed",
    });
    expect(h.scope.executions.size).toBe(0);
    expect(h.widgets.at(-1)).toBeUndefined();
  });

  it("handled and rejected steering leave the original execution, queue and live usage unchanged", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "start" }, h.ctx);
    const execution = h.agent("worker").currentExecution!;
    const child = h.child("worker");
    child.nextDisposition = "handled";
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "consume", isSteer: true }, h.ctx),
    ).rejects.toMatchObject({ code: "PROMPT_HANDLED" });
    expect(h.agent("worker").currentExecution).toBe(execution);
    expect(execution.phase).toBe("executing");
    expect(child.aborts).toBe(0);
    child.promptError = new Error("steering input rejected");
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "reject", isSteer: true }, h.ctx),
    ).rejects.toThrow("steering input rejected");
    expect(h.scope.executions.size).toBe(1);
    expect(h.reports).toHaveLength(0);
    expect(child.aborts).toBe(0);
    child.promptError = undefined;
    child.complete();
    await h.flush();
    expect(h.reports).toHaveLength(1);
  });

  it("fails an unexpected started steering disposition without pretending it was queued", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "start" }, h.ctx);
    const identity = h.agent("worker").identity;
    h.child("worker").nextDisposition = "started";
    await expect(
      h.runtime.askSubagent(
        h.caller,
        { name: "worker", prompt: "not queued", isSteer: true },
        h.ctx,
      ),
    ).rejects.toMatchObject({ code: "UNEXPECTED_PREFLIGHT" });
    await h.flush();
    expect(h.agent("worker").identity).toBe(identity);
    expect(await readFile(identity!.sessionFile, "utf8")).toContain("start");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.report).toMatchObject({
      outcome: "failed",
      error: { code: "UNEXPECTED_PREFLIGHT" },
    });
  });

  it("does not invoke SDK steering against an idle or waiting-for-child agent", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "idle", prompt: "work" }, h.ctx);
    const idle = h.child("idle");
    idle.complete();
    await h.flush();
    await expect(
      h.runtime.askSubagent(h.caller, { name: "idle", prompt: "steer idle", isSteer: true }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_STEERABLE" });
    expect(idle.promptCalls).toHaveLength(1);
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "child", prompt: "work" },
      h.ctx,
    );
    const parent = h.child("parent");
    parent.complete("preliminary");
    expect(h.agent("parent").currentExecution?.phase).toBe("waiting");
    const children = h.agent("parent").currentExecution!.pendingChildren;
    await expect(
      h.runtime.askSubagent(
        h.caller,
        { name: "parent", prompt: "steer waiting", isSteer: true },
        h.ctx,
      ),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_STEERABLE" });
    expect(parent.promptCalls).toHaveLength(1);
    expect(children.size).toBe(1);
    expect(parent.disposals).toBe(0);
    expect(h.scope.executions.size).toBe(2);
  });

  it("cleans a preaccept abort without canceling already accepted background work", async () => {
    const h = await createHarness();
    const reached = deferred();
    const resume = deferred();
    const open = h.factory.open.bind(h.factory);
    vi.spyOn(h.factory, "open").mockImplementation(async (options) => {
      const opened = await open(options);
      reached.resolve();
      await resume.promise;
      return opened;
    });
    const controller = new AbortController();
    const pending = h.runtime.createSubagent(
      h.caller,
      { name: "prepared", prompt: "start" },
      h.ctx,
      controller.signal,
    );
    const outcome = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await reached.promise;
    controller.abort();
    resume.resolve();
    await outcome;
    expect(h.scope.executions.size).toBe(0);
    expect(h.scope.children.has("prepared")).toBe(false);
    expect(h.children[0]?.promptCalls).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });
});
