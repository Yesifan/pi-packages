import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BUSY_REPLY } from "../../src/sessions/session-state.js";
import { SessionController } from "../../src/sessions/session-controller.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "silent" });

function setup(opts: {
  broadcastText?: (t: string) => Promise<void>;
  broadcastTyping?: (typing: boolean) => Promise<void>;
  typingKeepaliveMs?: number;
  senderLabel?: (m: { accountId: string }) => string;
  runtime?: FakeAgentRuntime;
  turnTimeoutMs?: number;
  abortGraceMs?: number;
  slashInteractionTimeoutMs?: number;
} = {}) {
  const runtime = opts.runtime ?? new FakeAgentRuntime();
  const transport = new FakeWeixinTransport();
  const currentTurn = new CurrentTurn();
  const interaction = new WeixinInteractionController({
    getCurrentTurn: () => currentTurn.get(),
    transport,
    logger,
  });
  const session = new SessionController({
    projectId: "foo",
    host: runtime,
    interaction,
    transport,
    currentTurn,
    logger,
    broadcastText: opts.broadcastText,
    broadcastTyping: opts.broadcastTyping,
    typingKeepaliveMs: opts.typingKeepaliveMs,
    resolveSenderLabel: opts.senderLabel as never,
    turnTimeoutMs: opts.turnTimeoutMs,
    abortGraceMs: opts.abortGraceMs,
    slashInteractionTimeoutMs: opts.slashInteractionTimeoutMs,
  });
  return { runtime, transport, session };
}

const msgA = (text: string, id = "m1") =>
  makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: id, text });

const msgB = (text: string, id = "m2") =>
  makeInboundMessage({ accountId: "acct-b", senderId: "user-b", messageId: id, text });

describe("M6 session controller (fake transport + fake runtime)", () => {
  it("A starts a turn; B gets busy refusal; completion replies only to A", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("帮我写个计划"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    expect(runtime.prompts[0]?.text).toBe("帮我写个计划");
    expect(session.getState()).toBe("busy");

    await session.handleUserMessage(msgB("你好"));
    expect(transport.textsTo("acct-b")).toEqual([BUSY_REPLY]);
    expect(transport.textsTo("acct-a")).toEqual([]);

    runtime.complete("这是给 A 的回复。");
    await turnPromise;

    expect(transport.textsTo("acct-a")).toEqual(["这是给 A 的回复。"]);
    expect(transport.textsTo("acct-b")).toEqual([BUSY_REPLY]);
    expect(session.getState()).toBe("ready");
  });

  it("sets typing before the run and clears it after", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("hello"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    expect(transport.typingEvents.map((t) => t.typing)).toEqual([true]);

    runtime.complete("done");
    await turnPromise;

    expect(transport.typingEvents.map((t) => t.typing)).toEqual([true, false]);
    expect(session.getState()).toBe("ready");
  });

  it("refreshes typing while a turn is running and stops after cleanup", async () => {
    const typing: boolean[] = [];
    const { runtime, session } = setup({
      broadcastTyping: async (value) => { typing.push(value); },
      typingKeepaliveMs: 10,
    });

    const turnPromise = session.handleUserMessage(msgA("long task"));
    await vi.waitFor(() => expect(typing.filter(Boolean).length).toBeGreaterThanOrEqual(2));

    runtime.complete("done");
    await turnPromise;
    expect(typing.at(-1)).toBe(false);

    const count = typing.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(typing).toHaveLength(count);
  });

  it("two consecutive turns on the same account work", async () => {
    const { runtime, transport, session } = setup();

    const t1 = session.handleUserMessage(msgA("first", "m1"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.complete("reply one");
    await t1;

    const t2 = session.handleUserMessage(msgA("second", "m2"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(2));
    runtime.complete("reply two");
    await t2;

    expect(transport.textsTo("acct-a")).toEqual(["reply one", "reply two"]);
    expect(session.getState()).toBe("ready");
  });

  it("exceptional prompt rejection produces an error reply to the turn origin", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("boom"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.fail(new Error("provider exploded"));
    await turnPromise;

    expect(transport.textsTo("acct-a")[0]).toContain("provider exploded");
    expect(session.getState()).toBe("ready");
  });

  it("Pi protocol error produces an origin-only error reply", async () => {
    const broadcasts: string[] = [];
    const { runtime, transport, session } = setup({
      broadcastText: async (text) => { broadcasts.push(text); },
    });
    const turnPromise = session.handleUserMessage(msgA("boom"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.completeWithError("quota exceeded", "partial answer");
    await turnPromise;

    expect(transport.textsTo("acct-a")[0]).toContain("quota exceeded");
    expect(transport.textsTo("acct-a")[0]).toContain("可能不完整");
    expect(broadcasts).toEqual([]);
    expect(session.getState()).toBe("ready");
  });

  it("does not report a recovered automatic retry as an error", async () => {
    const { runtime, transport, session } = setup();
    const turnPromise = session.handleUserMessage(msgA("retry"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.failThenRetrySuccessfully("recovered");
    await turnPromise;
    expect(transport.textsTo("acct-a")).toEqual(["recovered"]);
  });

  it("watchdog aborts a timed-out turn and returns to ready", async () => {
    const { transport, session } = setup({ turnTimeoutMs: 10, abortGraceMs: 20 });
    await session.handleUserMessage(msgA("hang"));
    expect(transport.textsTo("acct-a").at(-1)).toContain("运行超时");
    expect(session.getState()).toBe("ready");
  });

  it("faults the session when a timed-out Pi run cannot be stopped", async () => {
    class StuckRuntime extends FakeAgentRuntime {
      override async abort(): Promise<void> {}
      override async waitForIdle(): Promise<void> { await new Promise<void>(() => undefined); }
    }
    const runtime = new StuckRuntime();
    const { transport, session } = setup({ runtime, turnTimeoutMs: 5, abortGraceMs: 5 });
    await session.handleUserMessage(msgA("stuck"));
    expect(transport.textsTo("acct-a").at(-1)).toContain("未能正常停止");
    expect(session.getState()).toBe("faulted");
  });

  it("reports an extension failure to the origin without hiding a successful answer", async () => {
    const { runtime, transport, session } = setup();
    const turnPromise = session.handleUserMessage(msgA("extension"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.emit({ type: "extension_error", message: "hook exploded", extensionPath: "bad.ts" });
    runtime.complete("answer");
    await turnPromise;
    expect(transport.textsTo("acct-a")).toEqual([
      "answer",
      expect.stringContaining("hook exploded"),
    ]);
  });
});

describe("M6 commands over weixin", () => {
  it("reports command execution failures", async () => {
    class CompactFailureRuntime extends FakeAgentRuntime {
      override async compact(): Promise<void> { throw new Error("compact exploded"); }
    }
    const { transport, session } = setup({ runtime: new CompactFailureRuntime() });
    await session.handleCommand("compact", msgA("/compact"));
    expect(transport.textsTo("acct-a").at(-1)).toContain("compact exploded");
  });

  it("/status works while running", async () => {
    const { runtime, transport, session } = setup();
    const turnPromise = session.handleUserMessage(msgA("task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await session.handleCommand("status", msgA("/status", "m-status"));
    const statusReply = transport.textsTo("acct-a").at(-1)!;
    expect(statusReply).toContain("Project:");
    expect(statusReply).toContain("Agent state: busy");
    expect(statusReply).toContain("Model:");
    expect(statusReply).toContain("Configured trust:");

    runtime.complete("ok");
    await turnPromise;
    expect(session.getState()).toBe("ready");
  });

  it("/new is refused while running, allowed when idle", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await session.handleCommand("new", msgA("/new", "m-new-busy"));
    expect(transport.textsTo("acct-a").at(-1)).toContain("忙时不能新建会话");
    expect(runtime.newSessionCalls).toBe(0);

    runtime.complete("done");
    await turnPromise;

    await session.handleCommand("new", msgA("/new", "m-new-idle"));
    expect(runtime.newSessionCalls).toBe(1);
  });

  it("/abort terminates the running agent and notifies the turn origin", async () => {
    const { runtime, transport, session } = setup();

    const turnPromise = session.handleUserMessage(msgA("long task"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    await session.handleCommand("abort", msgA("/abort", "m-abort"));
    await turnPromise;

    expect(runtime.prompts.length).toBe(1); // no second prompt
    expect(transport.textsTo("acct-a").at(-1)).toContain("已中止");
    expect(session.getState()).toBe("ready");
  });

});

describe("slash selectors", () => {
  it("selects an inactive model as the project default", async () => {
    const { runtime, transport, session } = setup();
    await session.start();

    await session.handleCommand("model", "", msgA("/model"));
    expect(transport.textsTo("acct-a")[0]).toContain("**当前设置**");
    expect(transport.textsTo("acct-a")[0]).toContain("- 模型：fake/provider");
    expect(transport.textsTo("acct-a")[0]).toContain("- 思考强度：medium");
    expect(transport.textsTo("acct-a")[0]).toContain("- **a.** fake/provider (Fake)");
    expect(transport.textsTo("acct-a")[0]).toContain("选择将切换该项目的默认模型");
    await session.handleUserMessage(msgA("a", "choose-model"));

    expect(runtime.selectedModels).toEqual([{ provider: "fake", id: "provider", projectDefault: true }]);
  });

  it("thinking selector shows the current model and thinking level", async () => {
    const { runtime, transport, session } = setup();
    await session.start();
    await runtime.ensureSession();

    await session.handleCommand("thinking", "", msgA("/thinking"));
    const reply = transport.textsTo("acct-a")[0];
    expect(reply).toContain("**当前设置**");
    expect(reply).toContain("- 模型：fake/provider");
    expect(reply).toContain("- 思考强度：medium");
    expect(reply).toContain("**选择思考强度**");
  });

  it("resume selector blocks another account and restores the selected session", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.sessions = [{
      path: "/fake/old.jsonl",
      id: "old",
      modifiedAt: Date.now(),
      firstMessage: "old prompt",
    }];
    const { transport, session } = setup({ runtime });
    await session.start();

    await session.handleCommand("resume", "", msgA("/resume"));
    await session.handleUserMessage(msgB("hello"));
    expect(transport.textsTo("acct-b")).toEqual(["当前项目正在选择要恢复的会话，请稍后再试。"]);

    await session.handleUserMessage(msgA("a", "choose-resume"));
    expect(runtime.resumeCalls).toEqual(["/fake/old.jsonl"]);
    expect(session.getState()).toBe("ready");
  });

  it("page changes refresh the selector inactivity timeout", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.models = Array.from({ length: 6 }, (_, i) => ({ provider: "fake", id: `m${i}`, name: `M${i}` }));
    const { transport, session } = setup({ runtime, slashInteractionTimeoutMs: 40 });
    await session.start();

    await session.handleCommand("model", "", msgA("/model"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await session.handleUserMessage(msgA("2", "page-model"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(transport.textsTo("acct-a")).not.toContain("⏱️ 选择已超时，请重新输入命令。");

    await vi.waitFor(
      () => expect(transport.textsTo("acct-a")).toContain("⏱️ 选择已超时，请重新输入命令。"),
      { timeout: 100 },
    );
  });

  it("invalid input refreshes the selector inactivity timeout", async () => {
    const { transport, session } = setup({ slashInteractionTimeoutMs: 40 });
    await session.start();

    await session.handleCommand("model", "", msgA("/model"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await session.handleUserMessage(msgA("invalid", "invalid-model"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(transport.textsTo("acct-a")).not.toContain("⏱️ 选择已超时，请重新输入命令。");

    await vi.waitFor(
      () => expect(transport.textsTo("acct-a")).toContain("⏱️ 选择已超时，请重新输入命令。"),
      { timeout: 100 },
    );
  });

  it("/resume latest refuses to replace an active session", async () => {
    const { runtime, transport, session } = setup();
    await session.start();
    await runtime.ensureSession();

    await session.handleCommand("resume", "latest", msgA("/resume latest"));
    expect(transport.textsTo("acct-a")).toEqual(["当前已经在最新的会话中了。"]);
    expect(runtime.resumeCalls).toEqual([]);
  });
});

describe("M8 media routing through the session controller", () => {
  it("image attachments become multimodal domain images in the prompt", async () => {
    const { runtime, session } = setup();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const imgPath = path.join(process.cwd(), "test/.tmp", "m8-test-image.png");
    fs.mkdirSync(path.dirname(imgPath), { recursive: true });
    fs.writeFileSync(imgPath, Buffer.from(pngBase64, "base64"));

    const turnPromise = session.handleUserMessage(
      makeInboundMessage({
        accountId: "acct-a",
        senderId: "user-a",
        messageId: "m-img",
        text: "看看这张图",
        attachments: [{ kind: "image", localPath: imgPath, filename: "image.png", mimeType: "image/png" }],
      }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    expect(runtime.prompts[0]?.text).toBe("看看这张图");
    const images = runtime.prompts[0]?.images;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({ mimeType: "image/png" });
    expect(images?.[0]?.data).toBeTruthy();

    runtime.complete("图片已收到");
    await turnPromise;
  });

  it("file attachments become a Hermes-style context note (read it yourself, don't ask user)", async () => {
    const { runtime, session } = setup();
    const filePath = path.join(process.cwd(), "test/.tmp", "m8-ctx", "42", "data.csv");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "a,b\n1,2\n");

    const turnPromise = session.handleUserMessage(
      makeInboundMessage({
        accountId: "acct-a",
        senderId: "user-a",
        messageId: "m-ctx",
        text: "分析这个文件",
        attachments: [{ kind: "file", localPath: filePath, filename: "data.csv", mimeType: "text/csv" }],
      }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    const promptText = runtime.prompts[0]?.text ?? "";
    expect(promptText).toContain("用户发送了一个文件");
    expect(promptText).toContain("自己用终端或文档工具提取文本");

    runtime.complete("已分析");
    await turnPromise;
  });

  it("media download failures are injected into the prompt as a note", async () => {
    const { runtime, session } = setup();
    const turnPromise = session.handleUserMessage(
      makeInboundMessage({
        accountId: "acct-a",
        senderId: "user-a",
        messageId: "m-fail",
        text: "看这个",
        attachments: [],
        mediaFailures: [{ kind: "file", filename: "broken.pdf" }],
      }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));

    const promptText = runtime.prompts[0]?.text ?? "";
    expect(promptText).toContain("附件下载失败");
    expect(promptText).toContain("broken.pdf");

    runtime.complete("嗯");
    await turnPromise;
  });
});

describe("M9 sender marker + broadcast hook", () => {
  it("appends -- from weixin <name> to the prompt", async () => {
    const { runtime, session } = setup({ senderLabel: (m) => `bot-${m.accountId}` });
    const turnPromise = session.handleUserMessage(
      makeInboundMessage({ accountId: "acct-a", senderId: "user-a", text: "hi" }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    expect(runtime.prompts[0]!.text).toBe("hi\n\n-- from weixin bot-acct-a");

    runtime.complete("ok");
    await turnPromise;
  });

  it("broadcast hook gets the reply and skips the origin-only send", async () => {
    let broadcasted = "";
    const { runtime, transport, session } = setup({
      broadcastText: async (text) => {
        broadcasted = text;
      },
    });

    const turnPromise = session.handleUserMessage(
      makeInboundMessage({ accountId: "acct-a", senderId: "user-a", text: "hi" }),
    );
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    runtime.complete("broadcast me");
    await turnPromise;

    expect(broadcasted).toBe("broadcast me");
    expect(transport.sentTexts).toEqual([]); // origin send skipped when a broadcast hook is present
  });
});
