import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RootRuntime } from "../../src/runtime.js";
import { PersistentSubagentStore, sessionKey } from "../../src/store.js";
import { createHarness, deferred, type RuntimeHarness } from "../helpers/runtime-harness.js";

async function checkLock(h: RuntimeHarness, busy: boolean) {
  const probe = new PersistentSubagentStore(h.agentDir, h.scope.identity);
  try {
    if (busy) await expect(probe.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
    else await probe.open();
  } finally {
    await probe.close();
  }
}

describe("execution-scoped root ownership", () => {
  it("opens two windows, rejects only competing requests, then refreshes on A/B/A handoff", async () => {
    const h = await createHarness();
    const other = new RootRuntime(path.join(h.root, "extension.js"));
    const reports: unknown[] = [];
    await other.initialize(
      {
        ...h.host,
        sendReport: (report) => {
          reports.push(report);
        },
      },
      h.config,
    );
    Reflect.set(other, "childFactory", h.factory);
    Reflect.set(other, "resolveTrust", async () => true);
    try {
      await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "first" }, h.ctx);
      for (const isSteer of [false, true]) {
        await expect(
          other.askSubagent(h.caller, { name: "worker", prompt: "busy", isSteer }, h.ctx),
        ).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
      }
      await expect(
        other.createSubagent(h.caller, { name: "second", prompt: "busy" }, h.ctx),
      ).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
      h.child("worker").complete();
      await h.flush();
      const probe = new PersistentSubagentStore(h.agentDir, h.scope.identity);
      await probe.open();
      await probe.close();
      await other.createSubagent(h.caller, { name: "second", prompt: "now" }, h.ctx);
      expect(reports).toHaveLength(0);
      h.children.at(-1)!.complete();
      await new Promise<void>((resolve) => {
        const original = Reflect.get(other, "releaseIdle") as () => Promise<void>;
        Reflect.set(other, "releaseIdle", async () => {
          await original.call(other);
          resolve();
        });
      });
      await expect(
        h.runtime.createSubagent(h.caller, { name: "second", prompt: "duplicate" }, h.ctx),
      ).rejects.toMatchObject({ code: "SUBAGENT_NAME_EXISTS" });
      await h.runtime.askSubagent(h.caller, { name: "second", prompt: "again" }, h.ctx);
      expect(h.scope.children.size).toBe(2);
      expect(h.reports).toHaveLength(1);
      expect(reports).toHaveLength(1);
    } finally {
      await other.shutdown();
    }
  });

  it.each(["opening", "persistence", "dispose", "report", "prompt", "steer"] as const)(
    "retains ownership through suspended %s and releases after full cleanup",
    async (stage) => {
      const h = await createHarness();
      const reached = deferred();
      const resume = deferred();
      let steering: Promise<unknown> | undefined;
      if (stage === "opening") {
        const open = h.factory.open;
        vi.spyOn(h.factory, "open").mockImplementation(async (options) => {
          reached.resolve();
          await resume.promise;
          return open(options);
        });
      }
      const creating = h.runtime.createSubagent(
        h.caller,
        { name: "worker", prompt: "work" },
        h.ctx,
      );
      if (stage === "opening") {
        await reached.promise;
        try {
          await checkLock(h, true);
        } finally {
          resume.resolve();
        }
      }
      await creating;
      const child = h.child("worker");
      if (stage === "persistence") {
        const save = h.store.setChild.bind(h.store);
        vi.spyOn(h.store, "setChild").mockImplementation(async (...args) => {
          reached.resolve();
          await resume.promise;
          return save(...args);
        });
      } else if (stage === "dispose") {
        const opened = h.agent("worker").currentExecution!.opened!;
        const dispose = opened.dispose;
        vi.spyOn(opened, "dispose").mockImplementation(async () => {
          reached.resolve();
          await resume.promise;
          await dispose();
        });
      } else if (stage === "report") {
        const open = h.factory.openSessionManager;
        vi.spyOn(h.factory, "openSessionManager").mockImplementation(async (identity) => {
          reached.resolve();
          await resume.promise;
          return open(identity);
        });
      } else if (stage === "steer") {
        vi.spyOn(child.session, "steer").mockImplementation(async () => {
          reached.resolve();
          await resume.promise;
          return "queued";
        });
        steering = h.runtime.askSubagent(
          h.caller,
          { name: "worker", prompt: "adjust", isSteer: true },
          h.ctx,
        );
        await reached.promise;
      }
      if (stage === "prompt") {
        child.streaming = false;
        child.idle = true;
        child.emit({ type: "agent_settled", aborted: false });
      } else child.complete();
      if (["persistence", "dispose", "report"].includes(stage)) await reached.promise;
      try {
        if (stage !== "opening") {
          await checkLock(h, true);
          expect(h.reports).toHaveLength(0);
        }
      } finally {
        resume.resolve();
        if (stage === "prompt") child.completion.resolve();
      }
      await steering;
      await h.flush();
      await checkLock(h, false);
      expect(h.reports).toHaveLength(1);
    },
  );

  it("holds the whole tree for nested report processing, not just live streaming", async () => {
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
    const parent = h.child("parent");
    parent.complete("waiting");
    h.child("child", h.agent("parent")).complete();
    await parent.waitCustom();
    await h.flush();
    await checkLock(h, true);
    expect(h.reports).toHaveLength(0);
    parent.observeCustom(0);
    parent.persistCustom(0);
    parent.settle();
    await h.flush();
    await checkLock(h, false);
  });

  it("does not modify another window's running records even when asked about an idle sibling", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "idle", prompt: "work" }, h.ctx);
    h.child("idle").complete();
    await h.flush();
    await h.runtime.createSubagent(h.caller, { name: "active", prompt: "work" }, h.ctx);
    const file = path.join(
      h.agentDir,
      "subagents",
      "sessions",
      `${sessionKey(h.scope.identity)}.json`,
    );
    const before = await readFile(file, "utf8");
    const other = new RootRuntime(path.join(h.root, "extension.js"));
    await other.initialize(h.host, h.config);
    try {
      for (const isSteer of [false, true]) {
        await expect(
          other.askSubagent(h.caller, { name: "idle", prompt: "compete", isSteer }, h.ctx),
        ).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
      }
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      await other.shutdown();
    }
  });

  it("releases recovery failures and retries after damaged metadata is repaired", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx);
    h.child("worker").complete();
    await h.flush();
    const file = path.join(
      h.agentDir,
      "subagents",
      "sessions",
      `${sessionKey(h.scope.identity)}.json`,
    );
    const saved = await readFile(file, "utf8");
    await writeFile(file, "broken");
    await expect(
      h.runtime.askSubagent(h.caller, { name: "worker", prompt: "retry" }, h.ctx),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });
    await writeFile(file, saved);
    await checkLock(h, false);
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "retry" }, h.ctx);
    h.child("worker").complete();
    await h.flush();
    await checkLock(h, false);
  });

  it("releases failed preparation without permanently disabling the same window", async () => {
    const h = await createHarness();
    h.failNextOpen();
    await expect(
      h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx),
    ).rejects.toThrow("open failed");
    await checkLock(h, false);
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "retry" }, h.ctx);
    h.child("worker").complete();
    await h.flush();
    await checkLock(h, false);
  });

  it("releases after a root report submission throws, without a fabricated receipt", async () => {
    const h = await createHarness();
    h.host.sendReport = () => {
      throw new Error("host unavailable");
    };
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx);
    h.child("worker").complete();
    // The harness intentionally surfaces finalizer rejections; the runtime logs it.
    await h.flush().catch(() => undefined);
    await Promise.resolve();
    await Reflect.get(h.runtime, "releasing");
    await checkLock(h, false);
    expect(h.reports).toHaveLength(0);
  });

  it("retries real acquisition after close caches a release rejection without breaking a live lock", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx);
    const store = h.store;
    const release = Reflect.get(store, "releaseLock") as () => Promise<void>;
    const failure = new Error("temporary unlock failure");
    Reflect.set(store, "releaseLock", async () => {
      throw failure;
    });
    const released = deferred<unknown>();
    const releaseIdle = Reflect.get(h.runtime, "releaseIdle") as () => Promise<void>;
    Reflect.set(h.runtime, "releaseIdle", async () => {
      try {
        await releaseIdle.call(h.runtime);
        released.resolve(undefined);
      } catch (error) {
        released.resolve(error);
        throw error;
      }
    });
    h.child("worker").complete();
    expect(await released.promise).toBe(failure);
    // Exercise the real store's cached rejected close promise, not a mocked close().
    const closed = store.close();
    expect(store.close()).toBe(closed);
    await expect(closed).rejects.toBe(failure);
    try {
      await checkLock(h, true);
      await expect(
        h.runtime.askSubagent(h.caller, { name: "worker", prompt: "still locked" }, h.ctx),
      ).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });
    } finally {
      // The original owner releases normally after the simulated fault is repaired.
      // Never unlink or age a live lock to make this test pass.
      await release();
    }
    await h.runtime.askSubagent(h.caller, { name: "worker", prompt: "retry" }, h.ctx);
    h.child("worker").complete();
    await h.flush();
    await checkLock(h, false);
  });

  it.each(["acquisition", "recovery"] as const)(
    "joins suspended %s on shutdown without starting new work",
    async (stage) => {
      const h = await createHarness();
      await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx);
      h.child("worker").complete();
      await h.flush();
      const reached = deferred();
      const resume = deferred();
      if (stage === "acquisition") {
        const open = h.store.open.bind(h.store);
        vi.spyOn(h.store, "open").mockImplementation(async () => {
          const result = await open();
          reached.resolve();
          await resume.promise;
          return result;
        });
      } else {
        const open = h.factory.openSessionManager;
        vi.spyOn(h.factory, "openSessionManager").mockImplementation(async (identity) => {
          reached.resolve();
          await resume.promise;
          return open(identity);
        });
      }
      const asking = h.runtime.askSubagent(h.caller, { name: "worker", prompt: "again" }, h.ctx);
      const outcome = expect(asking).rejects.toMatchObject({ code: "ROOT_CLOSING" });
      await reached.promise;
      let stopped = false;
      const stopping = h.runtime.shutdown().then(() => {
        stopped = true;
      });
      try {
        await checkLock(h, true);
        expect(stopped).toBe(false);
        expect(h.mounts).toHaveLength(1);
      } finally {
        resume.resolve();
      }
      await Promise.all([stopping, outcome]);
      await checkLock(h, false);
      expect(h.mounts).toHaveLength(1);
      expect(h.reports).toHaveLength(1);
    },
  );

  it("waits for this window's pending release before competing for a new cycle", async () => {
    const h = await createHarness();
    await h.runtime.createSubagent(h.caller, { name: "worker", prompt: "work" }, h.ctx);
    const release = Reflect.get(h.store, "releaseLock") as () => Promise<void>;
    const reached = deferred();
    const resume = deferred();
    Reflect.set(h.store, "releaseLock", async () => {
      reached.resolve();
      await resume.promise;
      await release();
    });
    h.child("worker").complete();
    await reached.promise;
    let submitted = false;
    const asking = h.runtime
      .askSubagent(h.caller, { name: "worker", prompt: "again" }, h.ctx)
      .then((result) => {
        submitted = true;
        return result;
      });
    try {
      await checkLock(h, true);
      expect(submitted).toBe(false);
      expect(h.mounts).toHaveLength(1);
    } finally {
      resume.resolve();
    }
    await expect(asking).resolves.toMatchObject({ status: "submitted" });
    expect(h.mounts).toHaveLength(2);
    h.child("worker").complete();
    await h.flush();
    await checkLock(h, false);
  });

  it("idle steering does not recover or start a cycle", async () => {
    const h = await createHarness();
    await expect(
      h.runtime.askSubagent(h.caller, { name: "missing", prompt: "steer", isSteer: true }, h.ctx),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_STEERABLE" });
    expect(h.mounts).toHaveLength(0);
    const probe = new PersistentSubagentStore(h.agentDir, h.scope.identity);
    await probe.open();
    await probe.close();
  });
});
