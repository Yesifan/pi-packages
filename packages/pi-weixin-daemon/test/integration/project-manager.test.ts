import { describe, it, expect, vi } from "vitest";
import { ProjectManager } from "../../src/projects/project-manager.js";
import { BUSY_REPLY } from "../../src/sessions/session-state.js";
import { createLogger } from "../../src/util/logger.js";
import type { ProjectConfig } from "../../src/projects/types.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";

const logger = createLogger({ level: "silent" });

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

interface Harness {
  pm: ProjectManager;
  transports: Map<string, FakeWeixinTransport>;
  fakes: Map<string, FakeAgentRuntime>;
  configs: Array<{ name: string; config: ProjectConfig }>;
}

function setup(configs: Array<{ name: string; config: ProjectConfig }>): Harness {
  const transports = new Map<string, FakeWeixinTransport>();
  const fakes = new Map<string, FakeAgentRuntime>();
  const getTransport = (id: string) => {
    if (!transports.has(id)) transports.set(id, new FakeWeixinTransport());
    return transports.get(id)!;
  };
  const factory = async (ctx: { projectId: string; cwd: string }) => {
    const fake = new FakeAgentRuntime(ctx.cwd);
    fakes.set(ctx.projectId, fake);
    return fake;
  };
  const pm = new ProjectManager({ getTransport, factory, logger });
  return { pm, transports, fakes, configs };
}

async function start(h: Harness): Promise<void> {
  await h.pm.sync(h.configs);
}

function textMsg(accountId: string, senderId: string, id: string, text: string) {
  return makeInboundMessage({ accountId, senderId, messageId: id, text });
}

const twoProjects = [
  { name: "foo", config: { cwd: "/fake/foo", accounts: ["A", "B"], enabled: true } },
  { name: "bar", config: { cwd: "/fake/bar", accounts: ["C"], enabled: true } },
] as const;

describe("ProjectManager: account routing + project isolation (fake)", () => {
  it("routes A/B -> foo and C -> bar; unbound account is dropped", async () => {
    const h = setup(twoProjects as never);
    await start(h);

    // C -> bar runs
    const pC = h.pm.dispatch("C", textMsg("C", "u-c", "m1", "hello"));
    await tick();
    h.fakes.get("bar")!.complete("bar reply");
    await pC;
    expect(h.fakes.get("bar")!.prompts).toHaveLength(1);
    expect(h.fakes.get("foo")!.prompts).toHaveLength(0); // foo never saw C's message

    // A -> foo runs
    const pA = h.pm.dispatch("A", textMsg("A", "u-a", "m2", "hi"));
    await tick();
    h.fakes.get("foo")!.complete("foo reply");
    await pA;
    expect(h.fakes.get("foo")!.prompts).toHaveLength(1);

    // unbound account D (no project) is dropped, never reaches any runtime
    await h.pm.dispatch("D", textMsg("D", "u-d", "m3", "orphan"));
    await tick();
    expect(h.fakes.get("foo")!.prompts).toHaveLength(1);
    expect(h.fakes.get("bar")!.prompts).toHaveLength(1);
  });

  it("foo busy (A) refuses B, while bar (C) still runs", async () => {
    const h = setup(twoProjects as never);
    await start(h);

    // A -> foo: starts a long task (prompt suspends -> foo busy)
    const pA = h.pm.dispatch("A", textMsg("A", "u-a", "m1", "long task"));
    await tick();
    expect(h.pm.getRuntime("foo")!.getStatus().state).toBe("busy");

    // B -> foo then gets busy refusal (project foo), bar stays unaffected
    await h.pm.dispatch("B", textMsg("B", "u-b", "m2", "while busy"));
    await tick();
    const bReplies = h.transports.get("B")!.sentTexts.map((t) => t.text);
    expect(bReplies).toContain(BUSY_REPLY);
    expect(h.fakes.get("foo")!.prompts).toHaveLength(1); // B never prompted foo

    // C -> bar still runs normally (not blocked by foo's busy)
    const pC = h.pm.dispatch("C", textMsg("C", "u-c", "m3", "independent"));
    await tick();
    expect(h.fakes.get("bar")!.prompts).toHaveLength(1);
    h.fakes.get("bar")!.complete("bar ok");
    await pC;

    // Finish foo's long task
    h.fakes.get("foo")!.complete("foo done");
    await pA;
    expect(h.pm.getRuntime("foo")!.getStatus().state).toBe("idle");
  });

  it("aborting foo leaves bar running", async () => {
    const h = setup(twoProjects as never);
    await start(h);

    // foo busy
    const pA = h.pm.dispatch("A", textMsg("A", "u-a", "m1", "task"));
    await tick();
    expect(h.pm.getRuntime("foo")!.getStatus().state).toBe("busy");

    // /abort to foo (A) aborts foo only
    await h.pm.dispatch("A", textMsg("A", "u-a", "m2", "/abort"));
    await pA;
    expect(h.pm.getRuntime("foo")!.getStatus().state).toBe("idle");

    // bar still works
    const pC = h.pm.dispatch("C", textMsg("C", "u-c", "m3", "still here"));
    await tick();
    expect(h.fakes.get("bar")!.prompts).toHaveLength(1);
    h.fakes.get("bar")!.complete("ok");
    await pC;
  });

  it("foo start-failure (error) leaves bar unaffected", async () => {
    // foo's runtime fails to start -> foo=error; bar still runs.
    const transports = new Map<string, FakeWeixinTransport>();
    const fakes = new Map<string, FakeAgentRuntime>();
    const getTransport = (id: string) => {
      if (!transports.has(id)) transports.set(id, new FakeWeixinTransport());
      return transports.get(id)!;
    };
    const factory = async (ctx: { projectId: string; cwd: string }) => {
      if (ctx.projectId === "foo") throw new Error("foo start failed");
      const fake = new FakeAgentRuntime(ctx.cwd);
      fakes.set(ctx.projectId, fake);
      return fake;
    };
    const pm = new ProjectManager({ getTransport, factory, logger });
    await pm.sync(twoProjects as never);

    expect(pm.getRuntime("foo")!.getStatus().state).toBe("error");
    expect(pm.getRuntime("bar")!.getStatus().state).toBe("idle");

    // bar still runs
    const pC = pm.dispatch("C", textMsg("C", "u-c", "m2", "ok?"));
    await tick();
    expect(fakes.get("bar")!.prompts).toHaveLength(1);
    fakes.get("bar")!.complete("yes");
    await pC;
    expect(pm.getRuntime("bar")!.getStatus().state).toBe("idle");
  });

  it("disabled project drops inbound without starting a runtime", async () => {
    const h = setup([
      { name: "foo", config: { cwd: "/fake/foo", accounts: ["A"], enabled: false } },
    ] as never);
    await start(h);
    expect(h.pm.getRuntime("foo")).toBeUndefined();
    await h.pm.dispatch("A", textMsg("A", "u-a", "m1", "disabled"));
    await tick();
    expect(h.fakes.get("foo")).toBeUndefined();
  });
});

describe("ProjectManager: desired → diff → restart (W2/W10)", () => {
  it("accounts change → old runtime stopped and a fresh one built", async () => {
    const h = setup(twoProjects as never);
    await start(h);
    const oldFoo = h.fakes.get("foo")!;

    // Remove account B from foo: runtime-key sorted(accounts) changes.
    await h.pm.sync([
      { name: "foo", config: { cwd: "/fake/foo", accounts: ["A"], enabled: true } },
      { name: "bar", config: { cwd: "/fake/bar", accounts: ["C"], enabled: true } },
    ] as never);

    const newFoo = h.fakes.get("foo")!;
    expect(newFoo).not.toBe(oldFoo);
    expect(oldFoo.stopCalls).toBeGreaterThan(0);

    // B is no longer bound: its inbound is dropped (unbound account).
    await h.pm.dispatch("B", textMsg("B", "u-b", "m1", "hi"));
    await tick();
    expect(newFoo.prompts).toHaveLength(0);
  });
});
