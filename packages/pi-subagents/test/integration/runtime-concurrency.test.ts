import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ChildSessionFactory } from "../../src/child-session.js";
import type { RootScope } from "../../src/types.js";
import { createHarness, role } from "../helpers/runtime-harness.js";

async function idle(h: Awaited<ReturnType<typeof createHarness>>, name: string, cwd?: string) {
  await h.runtime.createSubagent(h.caller, { name, prompt: "initial", cwd }, h.ctx);
  h.child(name).complete(`${name} done`);
  await h.flush();
  return h.agent(name);
}

describe("name reservation and direct ownership", () => {
  it("trims names, matches exact case and reserves duplicates before the first await", async () => {
    const h = await createHarness();
    const first = h.runtime.createSubagent(h.caller, { name: " Worker ", prompt: "work" }, h.ctx);
    expect(h.agent("Worker").currentExecution).toMatchObject({ phase: "opening", accepted: false });
    const duplicate = h.runtime.createSubagent(
      h.caller,
      { name: "Worker", prompt: "duplicate" },
      h.ctx,
    );
    await expect(duplicate).rejects.toMatchObject({
      code: "SUBAGENT_NAME_EXISTS",
      message: expect.stringContaining("ask_subagent"),
    });
    const result = await first;
    expect(result).toMatchObject({ name: "Worker", status: "started", agent_type: "general" });
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("run_id");
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "wrong case" }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "case distinct" }, h.ctx);
    h.child("Worker").complete();
    await h.flush();
    await expect(
      h.runtime.createSubagent(h.caller, { name: "Worker", prompt: "completed duplicate" }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_NAME_EXISTS" });
    await expect(
      h.runtime.askSubagent(h.caller, { name: " Worker ", prompt: "follow-up" }, h.ctx),
    ).resolves.toMatchObject({ name: "Worker", status: "started" });
  });

  it.each(["", "  \n\t"])("rejects empty trimmed name %j", async (name) => {
    const h = await createHarness();
    await expect(
      h.runtime.createSubagent(h.caller, { name, prompt: "work" }, h.ctx),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(h.scope.executions.size).toBe(0);
  });

  it("keeps __proto__ and long full names safe and directly askable", async () => {
    const h = await createHarness();
    const long = `../${"long-name".repeat(40)}\nfull-name`;
    for (const name of ["__proto__", long]) await idle(h, name);
    const record = await h.store.readOwner(h.scope.identity, null);
    expect(Object.keys(record!.children)).toEqual(["__proto__", long]);
    expect(Object.hasOwn(record!.children, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).state).toBeUndefined();
    for (const name of ["__proto__", long]) {
      const result = await h.runtime.askSubagent(h.caller, { name, prompt: "again" }, h.ctx);
      expect(result.name).toBe(name);
      expect(result.delegation_status.directSubagents.map((child) => child.name)).toContain(long);
      expect(h.agent(name).identity!.sessionFile).not.toContain(name);
    }
    await expect(
      h.runtime.askSubagent(h.caller, { name: long.slice(0, 40), prompt: "prefix" }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
  });

  it("allows equal names under distinct parents, never searches across owners", async () => {
    const h = await createHarness();
    for (const name of ["parent", "other"])
      await h.runtime.createSubagent(
        h.caller,
        { name, prompt: "coordinate", cwd: h.external },
        h.ctx,
      );
    for (const name of ["parent", "other"])
      await h.runtime.createSubagent(
        h.nestedCaller(name),
        { name: "worker", prompt: "nested" },
        h.ctx,
      );
    expect(h.agent("parent").children.get("worker")).not.toBe(
      h.agent("other").children.get("worker"),
    );
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "guess" }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
    const rootRecord = await h.store.readOwner(h.scope.identity, null);
    expect(Object.keys(rootRecord!.children)).toEqual(["parent", "other"]);
    const nestedRecord = await h.store.readOwner(
      h.agent("parent").identity!,
      h.scope.identity,
      true,
    );
    expect(Object.keys(nestedRecord!.children)).toEqual(["worker"]);
    expect(nestedRecord!.children.worker).not.toHaveProperty("cwd");
  });

  it("enforces depth and canonical cycles using the caller's own cwd authorization", async () => {
    const h = await createHarness({ maxDepth: 2 });
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "work", cwd: h.external },
      h.ctx,
    );
    const caller = h.nestedCaller("parent");
    await expect(
      h.runtime.createSubagent(caller, { name: "cycle", prompt: "work", cwd: h.cwd }, h.ctx),
    ).rejects.toMatchObject({ code: "DELEGATION_CYCLE" });
    expect(h.agent("parent").children.has("cycle")).toBe(false);
    await expect(
      h.runtime.createSubagent({ ...caller, depth: 2 }, { name: "deep", prompt: "work" }, h.ctx),
    ).rejects.toMatchObject({ code: "DEPTH_LIMIT" });
    const subdirectory = path.join(h.external, "subdir");
    await mkdir(subdirectory);
    await expect(
      h.runtime.createSubagent(
        h.caller,
        { name: "prefix", prompt: "work", cwd: subdirectory },
        h.ctx,
      ),
    ).rejects.toMatchObject({ code: "CWD_NOT_ALLOWED" });
    expect(h.scope.executions.size).toBe(1);
  });
});

describe("role policy snapshots", () => {
  it.each([
    { disallowedTools: ["subagent"], expected: false },
    { disallowedTools: ["ask_subagent"], expected: true },
    { disallowedTools: [], expected: true },
    { tools: ["read"], expected: false },
  ])("retains the saved policy across asks: %j", async ({ expected, ...policy }) => {
    const h = await createHarness();
    h.caller.delegation.agentTypes.set("general", role(policy));
    await idle(h, "worker", h.external);
    expect(h.mounts.at(-1)).toMatchObject({ canDelegate: expected, roleSnapshot: policy });
    h.caller.delegation.agentTypes.set(
      "general",
      role({ prompt: "replacement", disallowedTools: ["subagent"] }),
    );
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "follow-up" }, h.ctx);
    expect(h.mounts.at(-1)).toMatchObject({
      canDelegate: expected,
      roleSnapshot: { ...policy, prompt: "Do the task." },
    });
    await idle(h, "same-cwd-leaf");
    expect(h.mounts.at(-1)?.canDelegate).toBe(false);
  });
});

describe("ordinary ask concurrency and history", () => {
  it("atomically reserves the original agent with a new Execution/mount, retaining history selection", async () => {
    const h = await createHarness();
    const agent = await idle(h, "worker");
    const identity = { ...agent.identity! };
    const old = h.child("worker");
    const before = old.manager.getBranch();
    const changed = {
      ...h.ctx,
      model: { ...h.ctx.model!, id: "changed" },
      thinkingLevel: "low" as const,
    };
    const first = h.runtime.askSubagent(h.caller, { name: "worker", prompt: "follow-up" }, changed);
    const execution = agent.currentExecution!;
    expect(execution).toMatchObject({ phase: "opening", accepted: false });
    const second = h.runtime.askSubagent(
      h.caller,
      { name: "worker", prompt: "must not queue" },
      changed,
    );
    await expect(second).rejects.toMatchObject({
      code: "SUBAGENT_BUSY",
      delegationStatus: {
        activeDirectSubagents: [{ name: "worker", agentType: "general" }],
        liveAgents: 1,
      },
    });
    await expect(first).resolves.toMatchObject({
      name: "worker",
      thinking: "high",
      status: "started",
    });
    expect(agent.currentExecution).toBe(execution);
    expect(agent.identity).toEqual(identity);
    const mounted = h.child("worker");
    expect(mounted).not.toBe(old);
    expect(mounted.session.model?.id).toBe("original");
    expect(mounted.session.thinkingLevel).toBe("high");
    expect(mounted.manager.getBranch().slice(0, before.length)).toEqual(before);
    expect(h.mounts.at(-1)).toMatchObject({ restoring: true });
    expect(h.mounts.at(-1)).not.toHaveProperty("model");
    expect(h.mounts.at(-1)).not.toHaveProperty("thinking");
    expect(mounted.promptCalls).toHaveLength(1);
    const saved = (await h.store.readOwner(h.scope.identity, null))!.children.worker!;
    expect(Object.keys(saved).sort()).toEqual([
      "roleSnapshot",
      "sessionFile",
      "sessionId",
      "state",
    ]);
  });

  it("rechecks the saved header cwd against current caller authorization on every ask", async () => {
    const h = await createHarness();
    const agent = await idle(h, "external", h.external);
    const before = await readFile(agent.identity!.sessionFile, "utf8");
    h.caller.delegation.externalDirectories = [];
    await expect(
      h.runtime.askSubagent(h.caller, { name: "external", prompt: "now unauthorized" }, h.ctx),
    ).rejects.toMatchObject({ code: "CWD_NOT_ALLOWED" });
    expect(agent.currentExecution).toBeUndefined();
    expect(agent.state).toBe("idle");
    expect(await readFile(agent.identity!.sessionFile, "utf8")).toBe(before);
    expect(h.mounts).toHaveLength(1);
  });

  it("atomically reserves the final shared live slot across different agents", async () => {
    const h = await createHarness({ maxLiveAgents: 1 });
    await idle(h, "first");
    await idle(h, "second");
    const first = h.runtime.askSubagent(h.caller, { name: "first", prompt: "work" }, h.ctx);
    expect(h.scope.executions.size).toBe(1);
    await expect(
      h.runtime.askSubagent(h.caller, { name: "second", prompt: "work" }, h.ctx),
    ).rejects.toMatchObject({
      code: "LIVE_AGENT_LIMIT",
      delegationStatus: { liveAgents: 1, maxLiveAgents: 1 },
    });
    await first;
    expect(h.scope.executions.size).toBe(1);
  });

  it("restores a failed ask's prior state and history without deleting siblings", async () => {
    const h = await createHarness();
    const agent = await idle(h, "worker");
    await idle(h, "sibling");
    const file = agent.identity!.sessionFile;
    const before = await readFile(file, "utf8");
    h.failNextOpen();
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "fail" }, h.ctx),
    ).rejects.toThrow("open failed");
    expect(agent.currentExecution).toBeUndefined();
    expect(agent.state).toBe("idle");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(Object.keys((await h.store.readOwner(h.scope.identity, null))!.children)).toEqual([
      "worker",
      "sibling",
    ]);
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "retry" }, h.ctx),
    ).resolves.toMatchObject({ name: "worker", status: "started" });
  });

  it.each(["handled", "reject"] as const)(
    "rolls back a new child on preaccept %s",
    async (kind) => {
      const h = await createHarness();
      await idle(h, "sibling");
      const count = h.reports.length;
      h.configureNext((child) => {
        if (kind === "handled") child.nextDisposition = "handled";
        else child.promptError = new Error("preflight rejected");
      });
      const pending = h.runtime.createSubagent(
        h.caller,
        { name: "prepared", prompt: "work" },
        h.ctx,
      );
      if (kind === "handled")
        await expect(pending).rejects.toMatchObject({ code: "PROMPT_HANDLED" });
      else await expect(pending).rejects.toThrow("preflight rejected");
      expect(h.scope.children.has("prepared")).toBe(false);
      expect(h.scope.executions.size).toBe(0);
      expect(h.reports).toHaveLength(count);
      expect(Object.keys((await h.store.readOwner(h.scope.identity, null))!.children)).toEqual([
        "sibling",
      ]);
      await expect(readFile(h.children.at(-1)!.manager.getSessionFile()!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("handled ask preserves the old identity/history and does not abort extension processing", async () => {
    const h = await createHarness();
    const agent = await idle(h, "worker");
    const before = await readFile(agent.identity!.sessionFile, "utf8");
    h.configureNext((child) => {
      child.nextDisposition = "handled";
    });
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "consume" }, h.ctx),
    ).rejects.toMatchObject({ code: "PROMPT_HANDLED" });
    expect(await readFile(agent.identity!.sessionFile, "utf8")).toBe(before);
    expect(agent.state).toBe("idle");
    expect(h.child("worker").aborts).toBe(0);
    expect(h.reports).toHaveLength(1);
  });

  it("unexpected queued ordinary input fails explicitly but retains accepted history and identity", async () => {
    const h = await createHarness();
    h.configureNext((child) => {
      child.nextDisposition = "queued";
    });
    await expect(
      h.runtime.createSubagent(h.caller, { name: "worker", prompt: "queued unexpectedly" }, h.ctx),
    ).rejects.toMatchObject({ code: "UNEXPECTED_PREFLIGHT" });
    await h.flush();
    expect(h.agent("worker").identity).toBeDefined();
    expect(await readFile(h.agent("worker").identity!.sessionFile, "utf8")).toContain(
      "queued unexpectedly",
    );
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.report).toMatchObject({
      outcome: "failed",
      error: { code: "UNEXPECTED_PREFLIGHT" },
    });
  });
});

describe("exact root restoration", () => {
  it("restores running as interrupted and opening as idle without mounting, replaying or reporting", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "running", prompt: "unfinished" }, h.ctx);
    await idle(h, "prepared");
    await h.store.setChild(h.scope.identity, null, "prepared", {
      ...h.agent("prepared").identity!,
      roleSnapshot: h.agent("prepared").roleSnapshot,
      state: "opening",
    });
    // Simulate crash metadata, not graceful shutdown's terminal state updates.
    const saved = (await h.store.readOwner(h.scope.identity, null))!;
    await h.runtime.shutdown();
    const { PersistentSubagentStore } = await import("../../src/store.js");
    const seed = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    await seed.open();
    for (const [name, record] of Object.entries(saved.children))
      await seed.setChild(h.scope.identity, null, name, record);
    await seed.close();
    const open = vi.spyOn(ChildSessionFactory.prototype, "open");
    try {
      const count = h.reports.length;
      const restored = await h.restart();
      const scope = Reflect.get(restored, "scope") as RootScope;
      expect(scope).not.toBe(h.scope);
      expect(scope.children.get("running")?.state).toBe("interrupted");
      expect(scope.children.get("prepared")?.state).toBe("idle");
      expect(scope.executions.size).toBe(0);
      expect(scope.deliveries.size).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(h.reports).toHaveLength(count);
      expect(scope.children.get("prepared")?.identity).toEqual(h.agent("prepared").identity);
      expect(await readdir(path.join(h.agentDir, "subagents", "sessions"))).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it("recursively restores only linked direct-owner metadata and the saved role without loading mounts", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "parent", prompt: "coordinate", cwd: h.external },
      h.ctx,
    );
    const caller = h.nestedCaller("parent");
    caller.delegation.agentTypes.set(
      "general",
      role({ prompt: "saved nested role", disallowedTools: ["write"] }),
    );
    await h.runtime.createSubagent(caller, { name: "worker", prompt: "nested" }, h.ctx);
    const identity = { ...h.agent("worker", h.agent("parent")).identity! };
    new ProjectTrustStore(h.agentDir).set(h.external, true);
    h.child("worker", h.agent("parent")).complete("nested result not replayed");
    await h.child("parent").waitCustom();
    await h.flush();
    const open = vi.spyOn(ChildSessionFactory.prototype, "open");
    try {
      const restored = await h.restart();
      const scope = Reflect.get(restored, "scope") as RootScope;
      expect(scope.children.size).toBe(1);
      const parent = scope.children.get("parent")!;
      expect(parent.state).toBe("interrupted");
      expect(parent.cwd).toBe(h.external);
      const worker = parent.children.get("worker")!;
      expect(worker.parent).toBe(parent);
      expect(worker.identity).toEqual(identity);
      expect(worker.state).toBe("idle");
      expect(worker.roleSnapshot).toMatchObject({
        prompt: "saved nested role",
        disallowedTools: ["write"],
      });
      expect(scope.agents.size).toBe(2);
      expect(scope.executions.size).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(h.reports).toHaveLength(0);
      expect(await readdir(path.join(h.agentDir, "subagents", "sessions"))).toHaveLength(2);
    } finally {
      open.mockRestore();
    }
  });

  it("does not read, migrate or delete either legacy store", async () => {
    const h = await createHarness();
    const projectLegacy = path.join(h.cwd, ".pi", "subagents", "sessions", "old-root", "root.json");
    const globalLegacy = path.join(h.agentDir, ".bykwp-pi-subagents", "old.json");
    for (const file of [projectLegacy, globalLegacy]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "not valid JSON; must never be read");
    }
    const restored = await h.restart();
    expect((Reflect.get(restored, "scope") as RootScope).children.size).toBe(0);
    await expect(
      restored.askSubagent(h.caller, { name: "sa_old", prompt: "legacy" }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
    Reflect.set(restored, "childFactory", h.factory);
    Reflect.set(restored, "resolveTrust", async () => true);
    await expect(
      restored.createSubagent(
        h.caller,
        { name: "old-worker", prompt: "new independent history" },
        h.ctx,
      ),
    ).resolves.toMatchObject({ name: "old-worker", status: "started" });
    const newAgent = (Reflect.get(restored, "scope") as RootScope).children.get("old-worker")!;
    expect(newAgent.identity!.sessionFile).toContain(path.join(h.agentDir, "sessions"));
    expect(await readFile(newAgent.identity!.sessionFile, "utf8")).toContain(
      "new independent history",
    );
    for (const file of [projectLegacy, globalLegacy])
      expect(await readFile(file, "utf8")).toBe("not valid JSON; must never be read");
  });
});
