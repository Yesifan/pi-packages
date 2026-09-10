import { describe, it, expect, vi } from "vitest";
import { BUSY_REPLY } from "../../src/sessions/session-state.js";
import { SessionController } from "../../src/sessions/session-controller.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { WeixinUIContext } from "../../src/pi/ui-context.js";
import type { InteractionPort } from "../../src/pi/ports.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import type { TurnContext } from "../../src/weixin/types.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport, makeInboundMessage, makeTurn } from "../helpers/fake-transport.js";
import { MultiAccountTransport } from "../helpers/multi-account-transport.js";

const logger = createLogger({ level: "silent" });

function setupUiRouting() {
  const runtime = new FakeAgentRuntime();
  const transportA = new FakeWeixinTransport();
  const transportB = new FakeWeixinTransport();
  const multi = new MultiAccountTransport();
  multi.register("acct-a", transportA);
  multi.register("acct-b", transportB);
  const currentTurn = new CurrentTurn();
  const interaction = new WeixinInteractionController({
    getCurrentTurn: () => currentTurn.get(),
    transport: multi,
    logger,
  });
  const session = new SessionController({
    projectId: "foo",
    host: runtime,
    interaction,
    transport: multi,
    currentTurn,
    logger,
  });
  return { runtime, transportA, transportB, interaction, session };
}

const msg = (accountId: string, senderId: string, id: string, text: string) =>
  makeInboundMessage({ accountId, senderId, messageId: id, text });

describe("M9 interaction controller UI response routing", () => {
  it("turn account's next message resolves the UI waiter; other accounts get busy", async () => {
    const { runtime, transportA, transportB, interaction, session } = setupUiRouting();
    // Start a real turn so currentTurn is set (as in production).
    const turnPromise = session.handleUserMessage(msg("acct-a", "user-a", "t0", "开始任务"));
    await vi.waitFor(() => expect(runtime.prompts.length).toBe(1));
    expect(session.getState()).toBe("busy");

    interaction.beginUiInteraction();
    const responsePromise = interaction.waitForResponse(makeTurn("acct-a", "user-a"));
    let resolved = "";
    responsePromise.then((text) => (resolved = text));

    // Other account -> busy
    await session.handleUserMessage(msg("acct-b", "user-b", "b1", "hi"));
    expect(transportB.textsTo("acct-b")).toEqual([BUSY_REPLY]);

    // Turn account -> UI response
    await session.handleUserMessage(msg("acct-a", "user-a", "a1", "1"));
    expect(resolved).toBe("1");

    interaction.endUiInteraction();
    expect(interaction.isUiInteractionActive()).toBe(false);

    runtime.complete("done");
    await turnPromise;
  });

  it("cancelUiWaiters rejects pending dialogs (e.g. /abort)", async () => {
    const { interaction } = setupUiRouting();
    const turn = makeTurn("acct-a", "user-a");

    const responsePromise = interaction.waitForResponse(turn);
    const rejection = vi.fn();
    responsePromise.catch(rejection);

    interaction.cancelUiWaiters("aborted");
    await vi.waitFor(() => expect(rejection).toHaveBeenCalled());
    expect(rejection).toHaveBeenCalledWith(expect.objectContaining({ message: "aborted" }));
  });

  it("waitForResponse supports timeout", async () => {
    const { interaction } = setupUiRouting();
    const turn = makeTurn("acct-a", "user-a");
    const responsePromise = interaction.waitForResponse(turn, { timeoutMs: 20 });
    await expect(responsePromise).rejects.toThrow("timed out");
  });
});

describe("M9 WeixinUIContext dialogs", () => {
  class FakeInteraction implements InteractionPort {
    beginCount = 0;
    endCount = 0;
    private turn: TurnContext | undefined;
    private transport: FakeWeixinTransport;
    private waiters: Array<{ resolve: (t: string) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }> = [];

    constructor(turn: TurnContext | undefined, transport: FakeWeixinTransport) {
      this.turn = turn;
      this.transport = transport;
    }

    getCurrentTurn(): TurnContext | undefined {
      return this.turn;
    }
    beginUiInteraction(): void {
      this.beginCount += 1;
    }
    endUiInteraction(): void {
      this.endCount += 1;
    }
    isUiInteractionActive(): boolean {
      return this.waiters.length > 0;
    }
    tryResolveUi(_turn: TurnContext, text: string): boolean {
      this.resolveWith(text);
      return true;
    }
    sendText(turn: TurnContext, text: string): Promise<void> {
      return this.transport.sendText(turn, text);
    }
    waitForResponse(_turn: TurnContext, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: undefined as NodeJS.Timeout | undefined };
        this.waiters.push(waiter);
        if (opts?.timeoutMs) {
          waiter.timer = setTimeout(() => {
            const idx = this.waiters.indexOf(waiter);
            if (idx >= 0) this.waiters.splice(idx, 1);
            reject(new Error("UI interaction timed out"));
          }, opts.timeoutMs);
        }
      });
    }
    cancelUiWaiters(_reason: string): void {}
    resolveWith(text: string): void {
      const w = this.waiters.shift();
      if (w?.timer) clearTimeout(w.timer);
      w?.resolve(text);
    }
  }

  function setupUi() {
    const transport = new FakeWeixinTransport();
    const turn = makeTurn("acct-a", "user-a");
    const broker = new FakeInteraction(turn, transport);
    const ui = new WeixinUIContext({
      interaction: broker,
      logger,
    });
    return { transport, broker, ui, turn };
  }

  it("confirm renders options and parses 1/取消", async () => {
    const { transport, broker, ui } = setupUi();
    const promise = ui.confirm("部署", "确定部署到生产环境吗？");
    await vi.waitFor(() => expect(broker.beginCount).toBe(1));

    const sent = transport.sentTexts.at(-1)!.text;
    expect(sent).toContain("🔔 部署");
    expect(sent).toContain("确定部署到生产环境吗？");
    expect(sent).toContain("1. 确认");
    expect(sent).toContain("2. 取消");

    broker.resolveWith("1");
    await expect(promise).resolves.toBe(true);

    const promise2 = ui.confirm("x", "y");
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    broker.resolveWith("取消");
    await expect(promise2).resolves.toBe(false);
    expect(broker.endCount).toBe(2);
  });

  it("select parses numbered choices", async () => {
    const { transport, broker, ui } = setupUi();
    const promise = ui.select("选择部署环境", ["生产", "预发", "测试"]);
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    const sent = transport.sentTexts.at(-1)!.text;
    expect(sent).toContain("1. 生产");
    expect(sent).toContain("3. 测试");

    broker.resolveWith("2");
    await expect(promise).resolves.toBe("预发");
  });

  it("input returns the raw reply", async () => {
    const { transport, broker, ui } = setupUi();
    const promise = ui.input("输入版本号", "v1.0.0");
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    expect(transport.sentTexts.at(-1)!.text).toContain("v1.0.0");

    broker.resolveWith("v2.3.4");
    await expect(promise).resolves.toBe("v2.3.4");
  });

  it("confirm/select/input ack the user with the received result", async () => {
    const { transport, broker, ui } = setupUi();

    let promise = ui.confirm("部署", "放行？");
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    broker.resolveWith("1");
    await expect(promise).resolves.toBe(true);
    expect(transport.sentTexts.at(-1)!.text).toContain("已确认");

    promise = ui.confirm("部署", "放行？");
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    broker.resolveWith("取消");
    await expect(promise).resolves.toBe(false);
    expect(transport.sentTexts.at(-1)!.text).toContain("已取消");

    promise = ui.select("Permission Required", ["Yes", "No"]);
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    broker.resolveWith("1");
    await expect(promise).resolves.toBe("Yes");
    expect(transport.sentTexts.at(-1)!.text).toContain("已允许");

    promise = ui.select("Permission Required", ["Yes", "No"]);
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    broker.resolveWith("zzz");
    await expect(promise).resolves.toBeUndefined();
    expect(transport.sentTexts.at(-1)!.text).toContain("无法识别");

    promise = ui.input("版本", "v1");
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    broker.resolveWith("v2.3.4");
    await expect(promise).resolves.toBe("v2.3.4");
    expect(transport.sentTexts.at(-1)!.text).toContain("已收到");
  });

  it("timeout auto-cancels/denies and notifies the user", async () => {
    const { transport, broker, ui } = setupUi();

    const promiseConfirm = ui.confirm("部署", "放行？", { timeout: 40 });
    await expect(promiseConfirm).resolves.toBe(false);
    expect(transport.sentTexts.at(-1)!.text).toContain("自动取消");
    expect(broker.endCount).toBe(1);

    const promiseSelect = ui.select("Permission Required", ["Yes", "No"], { timeout: 40 });
    await expect(promiseSelect).resolves.toBeUndefined();
    expect(transport.sentTexts.at(-1)!.text).toContain("自动拒绝");
    expect(broker.endCount).toBe(2);
  });

  it("notify sends a fire-and-forget message to the current turn", async () => {
    const { transport, ui } = setupUi();
    ui.notify("任务完成", "info");
    await vi.waitFor(() => expect(transport.sentTexts.length).toBe(1));
    expect(transport.sentTexts[0]!.text).toContain("任务完成");
  });

  it("custom()/editor()/theme degrade without throwing (W6)", async () => {
    const { broker, ui } = setupUi();

    await expect(ui.custom(() => undefined as never)).resolves.toBeUndefined();

    const p = ui.editor("编辑内容", "prefill");
    await vi.waitFor(() => expect(broker.waiters.length).toBe(1));
    broker.resolveWith("new text");
    await expect(p).resolves.toBe("new text");

    expect(ui.theme).toBeDefined();
    expect(typeof ui.theme.fg).toBe("function");
  });

  it("notify with no active turn is a no-op", () => {
    const transport = new FakeWeixinTransport();
    const broker = new FakeInteraction(undefined, transport);
    const ui = new WeixinUIContext({ interaction: broker, logger });
    ui.notify("nobody home", "info");
    expect(transport.sentTexts).toHaveLength(0);
  });
});
