import { describe, expect, it, vi } from "vitest";
import { SubagentError } from "../../src/errors.js";
import { PersistentSubagentStore } from "../../src/store.js";
import { createHarness, deferred } from "../helpers/runtime-harness.js";

describe("runtime final review regressions", () => {
  it("waits for accepted prompt outcome after settled, then reports its rejection once", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "first" }, h.ctx);
    h.child("worker").complete("old success");
    await h.flush();
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "second" }, h.ctx);
    const execution = h.agent("worker").currentExecution!;
    const child = h.child("worker");
    child.streaming = false;
    child.idle = true;
    child.emit({ type: "agent_settled" });
    await h.flush();
    expect(execution.finalizing).toBe(false);
    expect(h.reports).toHaveLength(1);
    child.fail(new Error("accepted prompt rejected after finally"));
    await h.flush();
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]?.report).toMatchObject({
      outcome: "failed",
      result: "",
      error: { message: "accepted prompt rejected after finally" },
    });
    expect(h.agent("worker").currentExecution).toBeUndefined();
  });

  it("signals every mounted descendant before awaiting a suspended abort", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    for (const name of ["first", "second"])
      await h.runtime.createSubagent(h.nestedCaller("parent"), { name, prompt: "work" }, h.ctx);
    await h.runtime.createSubagent(h.caller, { name: "sibling", prompt: "work" }, h.ctx);
    const resume = deferred();
    const first = h.child("first", h.agent("parent"));
    const abort = first.session.abort.bind(first.session);
    vi.spyOn(first.session, "abort").mockImplementation(async () => {
      await resume.promise;
      await abort();
    });
    const parentAbort = vi.spyOn(h.child("parent").session, "abort");
    const secondAbort = vi.spyOn(h.child("second", h.agent("parent")).session, "abort");
    const siblingAbort = vi.spyOn(h.child("sibling").session, "abort");
    let stopped = false;
    const shutdown = h.runtime.shutdown().then(() => {
      stopped = true;
    });
    try {
      expect(parentAbort).toHaveBeenCalledOnce();
      expect(secondAbort).toHaveBeenCalledOnce();
      expect(siblingAbort).toHaveBeenCalledOnce();
      await h.child("sibling").disposed.promise;
      expect(stopped).toBe(false);
      const contender = new PersistentSubagentStore(h.agentDir, h.scope.identity);
      await expect(contender.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
      await contender.close();
    } finally {
      resume.resolve();
    }
    await shutdown;
    expect(h.scope.executions.size).toBe(0);
    expect(h.reports).toHaveLength(0);
  });

  it("publishes an empty owner and durable marker before any nested opening record", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parent = h.agent("parent");
    const snapshots: Array<{ children: unknown; marker: unknown }> = [];
    const setChild = h.store.setChild.bind(h.store);
    vi.spyOn(h.store, "setChild").mockImplementation(async (owner, ownerParent, name, child) => {
      if (owner.sessionId === parent.identity!.sessionId && child.state === "opening") {
        const nested = await h.store.readOwner(parent.identity!, h.scope.identity);
        const root = await h.store.readOwner(h.scope.identity, null);
        snapshots.push({ children: nested?.children, marker: root?.children.parent?.hasChildren });
      }
      return setChild(owner, ownerParent, name, child);
    });
    await h.runtime.createSubagent(
      h.nestedCaller("parent"),
      { name: "child", prompt: "work" },
      h.ctx,
    );
    expect(snapshots).toEqual([{ children: {}, marker: true }]);
  });

  it("failed empty-owner initialization cannot publish a marker or nested child", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parent = h.agent("parent");
    vi.spyOn(h.store, "ensureOwner").mockRejectedValue(
      new SubagentError("STORE_ERROR", "owner initialization failed"),
    );
    await expect(
      h.runtime.createSubagent(h.nestedCaller("parent"), { name: "child", prompt: "work" }, h.ctx),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });
    expect(parent.children.size).toBe(0);
    expect(parent.hasChildren).toBeUndefined();
    expect(await h.store.readOwner(parent.identity!, h.scope.identity)).toBeUndefined();
    expect(
      (await h.store.readOwner(h.scope.identity, null))?.children.parent?.hasChildren,
    ).toBeUndefined();
    expect(h.mounts).toHaveLength(1);
  });

  it("keeps the published branch marker and empty owner when the first child rolls back", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parent = h.agent("parent");
    h.failNextOpen();
    await expect(
      h.runtime.createSubagent(h.nestedCaller("parent"), { name: "child", prompt: "work" }, h.ctx),
    ).rejects.toThrow("open failed");
    expect(parent.children.size).toBe(0);
    expect(parent.hasChildren).toBe(true);
    expect((await h.store.readOwner(parent.identity!, h.scope.identity, true))?.children).toEqual(
      {},
    );
    expect((await h.store.readOwner(h.scope.identity, null))?.children.parent?.hasChildren).toBe(
      true,
    );
  });

  it("failed marker publication leaves an empty owner and prevents concurrent nested child writes", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const parent = h.agent("parent");
    const reached = deferred();
    const resume = deferred();
    const mark = vi.spyOn(h.store, "markHasChildren").mockImplementation(async () => {
      reached.resolve();
      await resume.promise;
      throw new SubagentError("STORE_ERROR", "marker publication failed");
    });
    const joined = deferred();
    const initialize = Reflect.get(h.runtime, "ensureBranch") as (
      agent: typeof parent,
    ) => Promise<void>;
    let joins = 0;
    Reflect.set(h.runtime, "ensureBranch", (agent: typeof parent) => {
      const result = initialize.call(h.runtime, agent);
      if (++joins === 2) joined.resolve();
      return result;
    });
    const caller = h.nestedCaller("parent");
    const first = h.runtime.createSubagent(caller, { name: "first", prompt: "work" }, h.ctx);
    const firstOutcome = expect(first).rejects.toMatchObject({ code: "STORE_ERROR" });
    await reached.promise;
    const second = h.runtime.createSubagent(caller, { name: "second", prompt: "work" }, h.ctx);
    const secondOutcome = expect(second).rejects.toMatchObject({ code: "STORE_ERROR" });
    // Both tasks have reserved their names, but neither may publish before the shared marker.
    expect(parent.children.size).toBe(2);
    await joined.promise;
    resume.resolve();
    await Promise.all([firstOutcome, secondOutcome]);
    expect(mark).toHaveBeenCalledOnce();
    expect(parent.hasChildren).toBeUndefined();
    expect(parent.children.size).toBe(0);
    expect((await h.store.readOwner(parent.identity!, h.scope.identity, true))?.children).toEqual(
      {},
    );
    expect(
      (await h.store.readOwner(h.scope.identity, null))?.children.parent?.hasChildren,
    ).toBeUndefined();
  });
});
