import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { RootRuntime } from "../../src/runtime.js";
import { PersistentSubagentStore } from "../../src/store.js";
import { createHarness } from "../helpers/runtime-harness.js";

describe("runtime initialization and recovery admission", () => {
  it("cannot acquire a writer lock after shutdown overtakes initial cwd resolution", async () => {
    const h = await createHarness();
    await h.runtime.shutdown();
    const replacement = new RootRuntime(path.join(h.root, "extension.js"));
    const initializing = replacement.initialize(h.host, h.config);
    const outcome = expect(initializing).rejects.toMatchObject({ code: "ROOT_CLOSING" });
    await Promise.all([replacement.shutdown(), outcome]);
    expect(replacement.getMaxLiveAgents()).toBeUndefined();
    const store = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    await expect(store.open()).resolves.toBeUndefined();
    await store.close();
  });

  it("rejects recovery after direct cwd admission is revoked without deleting history", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "external", prompt: "work", cwd: h.external },
      h.ctx,
    );
    const file = h.agent("external").identity!.sessionFile;
    const before = await readFile(file, "utf8");
    h.config.externalDirectories = [];
    await expect(h.restart()).rejects.toMatchObject({ code: "CWD_NOT_ALLOWED" });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects recovery after target project trust is explicitly revoked", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(
      h.caller,
      { name: "external", prompt: "work", cwd: h.external },
      h.ctx,
    );
    new ProjectTrustStore(h.agentDir).set(h.external, false);
    await expect(h.restart()).rejects.toMatchObject({ code: "PROJECT_NOT_TRUSTED" });
  });

  it.each(["depth", "role"] as const)(
    "rejects recovered descendants that violate the current %s boundary",
    async (kind) => {
      const h = await createHarness();
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
      new ProjectTrustStore(h.agentDir).set(h.external, true);
      if (kind === "depth") h.config.maxDepth = 1;
      else {
        await h.runtime.shutdown();
        const seed = new PersistentSubagentStore(h.agentDir, h.scope.identity);
        await seed.open();
        const record = (await seed.readOwner(h.scope.identity, null))!.children.parent!;
        await seed.setChild(h.scope.identity, null, "parent", {
          ...record,
          roleSnapshot: { ...record.roleSnapshot, disallowedTools: ["subagent"] },
        });
        await seed.close();
      }
      await expect(h.restart()).rejects.toMatchObject({ code: "DELEGATION_DISABLED" });
    },
  );

  it("ordinary asks recheck the current depth limit without mounting another execution", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx);
    h.child("worker").complete();
    await h.flush();
    await expect(
      h.runtime.askSubagent(
        { ...h.caller, depth: h.config.maxDepth },
        { name: "worker", prompt: "again" },
        h.ctx,
      ),
    ).rejects.toMatchObject({ code: "DEPTH_LIMIT" });
    expect(h.mounts).toHaveLength(1);
  });

  it("diagnoses a missing captured history boundary instead of reusing an old result", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "first" }, h.ctx);
    const first = h.child("worker");
    const oldUser = first.manager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
    first.complete("old successful result");
    await h.flush();
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "second" }, h.ctx);
    h.child("worker").manager.branch(oldUser);
    h.child("worker").settle();
    await h.flush();
    expect(h.reports[1]?.report).toMatchObject({
      outcome: "failed",
      result: "",
      error: { code: "SESSION_HISTORY_UNAVAILABLE" },
    });
  });
});
