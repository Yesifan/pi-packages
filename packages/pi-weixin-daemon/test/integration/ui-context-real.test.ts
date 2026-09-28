import { afterEach, describe, expect, it } from "vitest";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { WeixinUIContext } from "../../src/pi/ui-context.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { createLogger } from "../../src/util/logger.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import { FakeWeixinTransport } from "../helpers/fake-transport.js";
import { MultiAccountTransport } from "../helpers/multi-account-transport.js";
import { createTmpProject } from "../helpers/tmp-project.js";

const logger = createLogger({ level: "warn" });

describe("real SDK extension UI context", () => {
  let host: PiSdkHost | undefined;

  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  it("retains non-dialog UI methods through the SDK's context wrapper", async () => {
    const project = createTmpProject("ui-context-spread");
    let started = false;

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
            const unsubscribe = ctx.ui.onTerminalInput(() => {});
            unsubscribe();
            ctx.ui.setStatus("test", "ready");
            if (ctx.ui.getEditorText() !== "" || !ctx.ui.theme) throw new Error("invalid UI");
            ctx.ui.notify("UI context works", "info");
            started = true;
          });
        },
      ],
    });
    const errors: string[] = [];
    host.onEvent((event) => {
      if (event.type === "extension_error") errors.push(event.message);
    });

    await host.ensureSession();
    expect(errors).toEqual([]);
    expect(started).toBe(true);
    await expect.poll(() => transport.sentTexts.map((s) => s.text)).toContain("ℹ️ UI context works");
  });
});
