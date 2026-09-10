import { describe, it, expect, vi } from "vitest";
import { ProjectManager } from "../../src/projects/project-manager.js";
import { PiInitializationError } from "../../src/pi/runtime-factory.js";
import { createLogger } from "../../src/util/logger.js";
import type { ProjectConfig } from "../../src/projects/types.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";

const logger = createLogger({ level: "silent" });

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

interface H {
  pm: ProjectManager;
  transports: Map<string, FakeWeixinTransport>;
  fakes: Map<string, FakeAgentRuntime>;
}

function setup(opts: { sessionIdleMs?: number } = {}): H {
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
  const pm = new ProjectManager({
    getTransport,
    factory,
    logger,
    resolveSenderName: (id) => `name-${id}`,
    sessionIdleMs: opts.sessionIdleMs,
  });
  return { pm, transports, fakes };
}

const fooConfig: Array<{ name: string; config: ProjectConfig }> = [
  { name: "foo", config: { cwd: "/fake/foo", accounts: ["A", "B"], enabled: true } },
];

function textMsg(accountId: string, senderId: string, id: string, text: string) {
  return makeInboundMessage({ accountId, senderId, messageId: id, text });
}

describe("ProjectRuntime: sender marker + project-wide notify/broadcast + idle close", () => {
  it("appends -- from weixin <name> to the prompt", async () => {
    const h = setup();
    await h.pm.sync(fooConfig as never);

    const p = h.pm.dispatch("A", textMsg("A", "u-a", "m1", "hello"));
    await tick();
    const text = h.fakes.get("foo")!.prompts[0]!.text;
    expect(text).toContain("hello");
    expect(text).toContain("-- from weixin name-A");

    h.fakes.get("foo")!.complete("ok");
    await p;
  });

  it("notifies other participants when a sender speaks, and broadcasts the reply to all", async () => {
    const h = setup();
    await h.pm.sync(fooConfig as never);

    // B registers first.
    const pB = h.pm.dispatch("B", textMsg("B", "u-b", "m1", "hi from b"));
    await tick();
    h.fakes.get("foo")!.complete("");
    await pB;

    // A speaks -> B gets "[name-A]: hello from a"; A (origin) does not.
    const pA = h.pm.dispatch("A", textMsg("A", "u-a", "m2", "hello from a"));
    await tick();
    expect(h.transports.get("B")!.textsTo("B")).toContain("name-A: hello from a");
    expect(h.transports.get("A")!.textsTo("A")).not.toContain("name-A: hello from a");
    // Typing follows the project broadcast audience, not only the origin.
    expect(h.transports.get("A")!.typingEvents.at(-1)?.typing).toBe(true);
    expect(h.transports.get("B")!.typingEvents.at(-1)?.typing).toBe(true);

    // Agent reply is broadcast to BOTH A and B.
    h.fakes.get("foo")!.complete("final answer");
    await pA;
    expect(h.transports.get("A")!.textsTo("A")).toContain("final answer");
    expect(h.transports.get("B")!.textsTo("B")).toContain("final answer");
    expect(h.transports.get("A")!.typingEvents.at(-1)?.typing).toBe(false);
    expect(h.transports.get("B")!.typingEvents.at(-1)?.typing).toBe(false);
  });

  it("keeps the Pi project healthy when one broadcast delivery fails", async () => {
    class FailingTransport extends FakeWeixinTransport {
      override async sendText(): Promise<void> { throw new Error("weixin unavailable"); }
    }
    const transports = new Map<string, FakeWeixinTransport>([
      ["A", new FailingTransport()],
      ["B", new FakeWeixinTransport()],
    ]);
    const runtime = new FakeAgentRuntime("/fake/foo");
    const pm = new ProjectManager({
      getTransport: (id) => transports.get(id),
      factory: async () => runtime,
      logger,
    });
    await pm.sync(fooConfig as never);

    const pB = pm.dispatch("B", textMsg("B", "u-b", "m1", "register"));
    await tick();
    runtime.complete("");
    await pB;

    const pA = pm.dispatch("A", textMsg("A", "u-a", "m2", "hello"));
    await tick();
    runtime.complete("answer");
    await pA;

    expect(transports.get("B")!.textsTo("B")).toContain("answer");
    expect(pm.getRuntime("foo")!.getStatus().state).toBe("idle");
  });

  it("unknown /bar is refused with a hint (W4), never treated as a message", async () => {
    const h = setup();
    await h.pm.sync(fooConfig as never);

    await h.pm.dispatch("A", textMsg("A", "u-a", "m1", "/bar"));
    await tick();

    expect(h.transports.get("A")!.textsTo("A").at(-1)).toContain("未知命令 /bar");
    expect(h.fakes.get("foo")!.prompts).toHaveLength(0);
  });

  it("auto-closes an idle session: notifies + creates a fresh session on next message", async () => {
    const h = setup({ sessionIdleMs: 40 });
    await h.pm.sync(fooConfig as never);

    // Register A and B.
    const pB = h.pm.dispatch("B", textMsg("B", "u-b", "m1", "b"));
    await tick();
    h.fakes.get("foo")!.complete("");
    await pB;
    const pA = h.pm.dispatch("A", textMsg("A", "u-a", "m2", "a"));
    await tick();
    h.fakes.get("foo")!.complete("");
    await pA;

    // Wait past the idle window: both should get the close notice.
    await vi.waitFor(() => {
      expect(h.transports.get("A")!.textsTo("A")).toContain("本次会话已关闭");
      expect(h.transports.get("B")!.textsTo("B")).toContain("本次会话已关闭");
    });

    // W3: idle close disposes the session (real close), not just a flag.
    expect(h.fakes.get("foo")!.stopCalls).toBeGreaterThan(0);

    const ensureBefore = h.fakes.get("foo")!.ensureSessionCalls;
    const pC = h.pm.dispatch("A", textMsg("A", "u-a", "m3", "after idle"));
    await tick();
    // A fresh session is created before the message is processed.
    expect(h.fakes.get("foo")!.ensureSessionCalls).toBe(ensureBefore + 1);

    h.fakes.get("foo")!.complete("replied");
    await pC;
    expect(h.transports.get("A")!.textsTo("A")).toContain("replied");
  });
});

describe("ProjectRuntime: W1 fail-closed diagnostics", () => {
  it("fatal init error -> project error state + refuses further messages", async () => {
    const transports = new Map<string, FakeWeixinTransport>();
    const getTransport = (id: string) => {
      if (!transports.has(id)) transports.set(id, new FakeWeixinTransport());
      return transports.get(id)!;
    };

    class FatalRuntime extends FakeAgentRuntime {
      override async ensureSession(): Promise<void> {
        throw new PiInitializationError("extension load error (bad.ts): boom");
      }
    }

    const pm = new ProjectManager({
      getTransport,
      factory: async (ctx) => new FatalRuntime(ctx.cwd),
      logger,
    });
    await pm.sync([{ name: "foo", config: { cwd: "/fake/foo", accounts: ["A"], enabled: true } }]);

    // First message triggers lazy runtime build -> fatal init error -> project error.
    await pm.dispatch("A", textMsg("A", "u-a", "m1", "hello"));
    await tick();
    expect(pm.getRuntime("foo")!.getStatus().state).toBe("error");

    // Further messages are refused with the reason.
    await pm.dispatch("A", textMsg("A", "u-a", "m2", "again"));
    await tick();
    const replies = transports.get("A")!.textsTo("A");
    expect(replies.at(-1)).toContain("项目启动失败");
  });
});
