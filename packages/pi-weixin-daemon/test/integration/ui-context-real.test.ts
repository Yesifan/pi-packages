import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { WeixinUIContext } from "../../src/pi/ui-context.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { createLogger } from "../../src/util/logger.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import { FakeWeixinTransport } from "../helpers/fake-transport.js";
import { MultiAccountTransport } from "../helpers/multi-account-transport.js";
import { createTmpProject, type TmpProject } from "../helpers/tmp-project.js";

const logger = createLogger({ level: "warn" });

describe("real SDK extension UI context", () => {
  let host: PiSdkHost | undefined;
  let project: TmpProject | undefined;

  afterEach(async () => {
    try {
      await host?.stop();
    } finally {
      host = undefined;
      project?.cleanup();
      project = undefined;
    }
  });

  it("lazily binds daemon extensions, cwd and Weixin UI on every real session", async () => {
    project = createTmpProject("ui-context-spread");
    const starts: Array<{ cwd: string; mode: string; sessionId: string }> = [];
    const generations: number[] = [];

    const transport = new FakeWeixinTransport();
    const multi = new MultiAccountTransport();
    multi.register("acct-a", transport);
    const turn = new CurrentTurn();
    turn.set({ accountId: "acct-a", senderId: "user-a", messageId: "m1" });
    const interaction = new WeixinInteractionController({
      getCurrentTurn: () => turn.get(),
      transport: multi,
      logger,
    });
    const uiContext = new WeixinUIContext({ interaction, logger });
    expect(Object.keys(uiContext)).not.toContain("deps");
    host = new PiSdkHost({
      cwd: project.dir,
      logger,
      uiContext,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", (_event, ctx) => {
            const unsubscribe = ctx.ui.onTerminalInput(() => undefined);
            unsubscribe();
            ctx.ui.setStatus("test", "ready");
            if (ctx.ui.getEditorText() !== "" || !ctx.ui.theme) throw new Error("invalid UI");
            ctx.ui.notify("UI context works", "info");
            starts.push({
              cwd: ctx.cwd,
              mode: ctx.mode,
              sessionId: ctx.sessionManager.getSessionId(),
            });
          });
        },
      ],
    });
    const errors: string[] = [];
    host.onEvent((event) => {
      if (event.type === "extension_error") errors.push(event.message);
      if (event.type === "session_bound") generations.push(event.generation);
    });

    await host.start();
    expect(host.hasSession()).toBe(false);
    expect(starts).toEqual([]);
    await host.ensureSession();
    await host.ensureSession();
    expect(starts).toHaveLength(1);
    expect(await host.newSession()).toEqual({ cancelled: false });
    expect(starts).toHaveLength(2);
    expect(starts[1]?.sessionId).not.toBe(starts[0]?.sessionId);
    expect(starts.map(({ cwd, mode }) => ({ cwd, mode }))).toEqual([
      { cwd: project.dir, mode: "rpc" },
      { cwd: project.dir, mode: "rpc" },
    ]);
    expect(generations).toEqual([1, 2]);
    expect(errors).toEqual([]);
    expect(
      host
        .getStatus()
        .sessionFile?.startsWith(`${path.join(process.env.PI_CODING_AGENT_DIR!, "sessions")}/`),
    ).toBe(true);
    await expect
      .poll(() => transport.sentTexts)
      .toEqual([
        { ctx: turn.get(), text: "ℹ️ UI context works" },
        { ctx: turn.get(), text: "ℹ️ UI context works" },
      ]);
  });
});
