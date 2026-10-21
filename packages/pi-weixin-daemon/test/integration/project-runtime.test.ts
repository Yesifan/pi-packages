import { describe, expect, it, vi } from "vitest";
import { PiInitializationError } from "../../src/pi/runtime-factory.js";
import type { ProjectHostFactoryContext } from "../../src/projects/project-controller.js";
import { ProjectManager } from "../../src/projects/project-manager.js";
import type { ProjectConfig } from "../../src/projects/types.js";
import { createLogger } from "../../src/util/logger.js";
import type { ResolveRecipientAccount } from "../../src/weixin/recipient.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "silent" });

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

interface H {
  pm: ProjectManager;
  transports: Map<string, FakeWeixinTransport>;
  fakes: Map<string, FakeAgentRuntime>;
  contexts: Map<string, ProjectHostFactoryContext>;
}

function setup(opts: { sessionIdleMs?: number; resolveAccount?: ResolveRecipientAccount } = {}): H {
  const transports = new Map<string, FakeWeixinTransport>();
  const fakes = new Map<string, FakeAgentRuntime>();
  const contexts = new Map<string, ProjectHostFactoryContext>();
  const getTransport = (id: string) => {
    if (!transports.has(id)) transports.set(id, new FakeWeixinTransport());
    return transports.get(id)!;
  };
  const factory = async (ctx: ProjectHostFactoryContext) => {
    contexts.set(ctx.projectId, ctx);
    const fake = new FakeAgentRuntime(ctx.cwd);
    fakes.set(ctx.projectId, fake);
    return fake;
  };
  const pm = new ProjectManager({
    getTransport,
    resolveBroadcastAccount:
      opts.resolveAccount ??
      ((id) => ({
        userId: `u-${id.toLowerCase()}`,
        contextToken: `cached-${id}`,
      })),
    factory,
    logger,
    resolveSenderName: (id) => `name-${id}`,
    sessionIdleMs: opts.sessionIdleMs,
  });
  return { pm, transports, fakes, contexts };
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
    expect(text).toBe("hello\n\n-- from weixin name-A");

    h.fakes.get("foo")!.complete("ok");
    await p;
  });

  it("notifies bound users without prior inbound and broadcasts final text and typing", async () => {
    const h = setup();
    await h.pm.sync(fooConfig as never);

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

  it.each(["stop", "replace"] as const)(
    "finishes an already-started broadcast after session %s",
    async (change) => {
      const h = setup();
      await h.pm.sync(fooConfig);
      const runtime = h.fakes.get("foo")!;
      const prime = h.pm.dispatch("A", textMsg("A", "u-a", "prime", "hello"));
      await vi.waitFor(() => expect(runtime.prompts).toHaveLength(1));
      runtime.complete("");
      await prime;

      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = h.transports.get("A")!;
      const send = first.sendText.bind(first);
      const sending = vi.spyOn(first, "sendText").mockImplementationOnce(async (ctx, text) => {
        await blocked;
        await send(ctx, text);
      });
      try {
        runtime.startIndependentTurn();
        runtime.completeIndependentTurn("finished reply");
        await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1));
        expect(h.transports.get("B")!.textsTo("B")).not.toContain("finished reply");
        if (change === "stop") await h.pm.stopAll();
        else runtime.emit({ type: "session_bound", generation: 2 });
        release();
        await vi.waitFor(() => {
          expect(first.textsTo("A")).toContain("finished reply");
          expect(h.transports.get("B")!.textsTo("B")).toContain("finished reply");
        });
      } finally {
        release();
        sending.mockRestore();
        await h.pm.stopAll();
      }
    },
  );

  it("keeps the Pi project healthy when one broadcast delivery fails", async () => {
    class FailingTransport extends FakeWeixinTransport {
      override async sendText(): Promise<void> {
        throw new Error("weixin unavailable");
      }
    }
    const transports = new Map<string, FakeWeixinTransport>([
      ["A", new FailingTransport()],
      ["B", new FakeWeixinTransport()],
    ]);
    const runtime = new FakeAgentRuntime("/fake/foo");
    const pm = new ProjectManager({
      getTransport: (id) => transports.get(id),
      resolveBroadcastAccount: (id) => ({
        userId: `u-${id.toLowerCase()}`,
        contextToken: `cached-${id}`,
      }),
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

describe("ProjectRuntime: login user delivery", () => {
  it("keeps file, progress, error and UI directed, preserves origin, and lets the recipient answer", async () => {
    const h = setup();
    await h.pm.sync(fooConfig);
    const pending = h.pm.dispatch("A", {
      ...textMsg("A", "other-sender", "origin", "hello"),
      contextToken: "other-token",
    });
    await tick();
    const { interaction, transport } = h.contexts.get("foo")!;
    const origin = interaction.getCurrentTurn()!;
    expect(origin).toMatchObject({
      senderId: "other-sender",
      contextToken: "other-token",
      messageId: "origin",
    });
    await transport.sendFile(origin, "/fake/report.txt", "file");
    await transport.sendText(origin, "progress");
    await interaction.sendText(origin, "question");
    const response = interaction.waitForResponse(origin);
    await h.pm.dispatch("B", textMsg("B", "u-b", "wrong-account", "wrong"));
    await h.pm.dispatch("A", textMsg("A", "other-sender", "wrong-user", "wrong"));
    expect(interaction.isUiInteractionActive()).toBe(true);
    await h.pm.dispatch("A", textMsg("A", "u-a", "answer", "yes"));
    await expect(response).resolves.toBe("yes");
    h.fakes.get("foo")!.completeWithError("failure", "partial");
    await pending;
    const a = h.transports.get("A")!;
    const b = h.transports.get("B")!;
    expect(a.sentFiles[0]).toMatchObject({ ctx: { senderId: "u-a", contextToken: "cached-A" } });
    for (const text of ["progress", "question"]) {
      expect(a.sentTexts.find((sent) => sent.text === text)?.ctx).toMatchObject({
        senderId: "u-a",
        contextToken: "cached-A",
      });
      expect(b.sentTexts.some((sent) => sent.text === text)).toBe(false);
    }
    expect(a.sentTexts.at(-1)?.ctx.senderId).toBe("u-a");
    expect(a.sentTexts.at(-1)?.text).toContain("failure");
    expect(b.sentTexts.some((sent) => sent.text.includes("failure"))).toBe(false);
    expect(b.sentFiles).toHaveLength(0);
    expect(origin.senderId).toBe("other-sender");
    await h.pm.stopAll();
  });

  it("lets a command selector's login recipient answer despite a different original sender", async () => {
    const h = setup();
    await h.pm.sync(fooConfig);
    await h.pm.dispatch("A", textMsg("A", "other-sender", "command", "/model"));
    await h.pm.dispatch("A", textMsg("A", "u-a", "choice", "a"));
    expect(h.fakes.get("foo")!.selectedModels).toHaveLength(1);
    expect(h.fakes.get("foo")!.prompts).toHaveLength(0);
    await h.pm.stopAll();
  });

  it("skips a login user without its token, never borrowing the sender token, and continues other targets", async () => {
    const h = setup({
      resolveAccount: (id) => ({
        userId: `u-${id.toLowerCase()}`,
        contextToken: id === "B" ? "cached-B" : undefined,
      }),
    });
    await h.pm.sync(fooConfig);
    const pending = h.pm.dispatch("A", {
      ...textMsg("A", "other-sender", "origin", "hello"),
      contextToken: "other-token",
    });
    await tick();
    h.fakes.get("foo")!.complete("answer");
    await pending;
    expect(h.transports.get("A")?.sentTexts ?? []).toHaveLength(0);
    expect(h.transports.get("B")!.textsTo("B")).toContain("answer");
    expect(await h.pm.broadcast("foo", "notice")).toEqual({ succeeded: 1, skipped: 1, failed: 0 });
    // A matching inbound token can still serve its own directed command.
    await h.pm.dispatch("A", {
      ...textMsg("A", "u-a", "command", "/status"),
      contextToken: "current-A",
    });
    expect(h.transports.get("A")!.sentTexts.at(-1)?.ctx.contextToken).toBe("current-A");
    await h.pm.stopAll();
  });

  it("accepts a different sender but directs commands and final text to login users with exact tokens", async () => {
    const h = setup();
    await h.pm.sync(fooConfig);
    const incoming = textMsg("A", "other-sender", "different", "/status");
    incoming.contextToken = "other-token";
    await h.pm.dispatch("A", incoming);
    expect(h.transports.get("A")!.sentTexts.at(-1)?.ctx).toMatchObject({
      senderId: "u-a",
      contextToken: "cached-A",
      messageId: "different",
    });
    const pending = h.pm.dispatch("A", { ...incoming, text: "hello" });
    await tick();
    expect(h.fakes.get("foo")!.prompts).toHaveLength(1);
    h.fakes.get("foo")!.complete("answer");
    await pending;
    for (const id of ["A", "B"]) {
      expect(h.transports.get(id)!.sentTexts.at(-1)).toMatchObject({
        ctx: { senderId: `u-${id.toLowerCase()}`, contextToken: `cached-${id}` },
        text: "answer",
      });
    }
    await h.pm.stopAll();
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
      resolveBroadcastAccount: (id) => ({
        userId: `u-${id.toLowerCase()}`,
        contextToken: `cached-${id}`,
      }),
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
