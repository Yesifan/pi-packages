import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { WeixinUIContext } from "../../src/pi/ui-context.js";
import { SessionController } from "../../src/sessions/session-controller.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import { createLogger } from "../../src/util/logger.js";
import { createTmpProject, waitForMarker } from "../helpers/tmp-project.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";
import { MultiAccountTransport } from "../helpers/multi-account-transport.js";

const logger = createLogger({ level: "warn" });
const TIMEOUT = 120_000;

describe("M9 e2e: extension UI dialogs completed over weixin (real SDK)", () => {
  const runtimes: PiSdkHost[] = [];

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => {});
    }
  });

  async function setupProject(name: string) {
    const project = createTmpProject(name, { withUiExtension: true });
    const transport = new FakeWeixinTransport();
    const multi = new MultiAccountTransport();
    multi.register("acct-a", transport);

    const currentTurn = new CurrentTurn();
    const interaction = new WeixinInteractionController({
      getCurrentTurn: () => currentTurn.get(),
      transport: multi,
      logger,
    });
    const runtime = new PiSdkHost({
      cwd: project.dir,
      logger,
      uiContext: new WeixinUIContext({
        interaction,
        logger,
      }),
    });
    runtimes.push(runtime);
    await runtime.start();

    const session = new SessionController({
      projectId: name,
      host: runtime,
      interaction,
      transport: multi,
      currentTurn,
      logger,
    });
    return { project, transport, session };
  }

  async function waitForText(transport: FakeWeixinTransport, needle: string, timeoutMs = TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (transport.sentTexts.some((s) => s.text.includes(needle))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`never received message containing: ${needle}`);
  }

  it(
    "confirm dialog: agent asks, user replies 1, tool completes with confirmed=true",
    async () => {
      const { project, transport, session } = await setupProject("m9-confirm");

      const turnPromise = session.handleUserMessage(
        makeInboundMessage({
          accountId: "acct-a",
          senderId: "user-a",
          messageId: "m1",
          text: "请调用 ask_confirm_tool 工具。",
        }),
      );

      // The dialog is rendered over weixin and the interaction is active.
      await waitForText(transport, "1. 确认");
      expect(session.getState()).toBe("busy");

      // Turn account answers.
      await session.handleUserMessage(
        makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: "m2", text: "1" }),
      );

      await turnPromise;
      const marker = fs.readFileSync(project.uiMarkerFile, "utf-8");
      expect(marker).toContain("confirmed=true");
      expect(session.getState()).toBe("ready");
    },
    TIMEOUT + 30_000,
  );

  it(
    "select dialog: agent asks, user picks option 2, tool receives the choice",
    async () => {
      const { project, transport, session } = await setupProject("m9-select");

      const turnPromise = session.handleUserMessage(
        makeInboundMessage({
          accountId: "acct-a",
          senderId: "user-a",
          messageId: "m1",
          text: "请调用 ask_select_tool 工具。",
        }),
      );

      await waitForText(transport, "选择部署环境");
      expect(session.getState()).toBe("busy");

      await session.handleUserMessage(
        makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: "m2", text: "2" }),
      );

      await turnPromise;
      const marker = fs.readFileSync(project.uiMarkerFile, "utf-8");
      expect(marker).toContain("select=预发");
      expect(session.getState()).toBe("ready");
    },
    TIMEOUT + 30_000,
  );

  it(
    "input dialog: agent asks, user types a version, tool receives it",
    async () => {
      const { project, transport, session } = await setupProject("m9-input");

      const turnPromise = session.handleUserMessage(
        makeInboundMessage({
          accountId: "acct-a",
          senderId: "user-a",
          messageId: "m1",
          text: "请调用 ask_input_tool 工具。",
        }),
      );

      await waitForText(transport, "输入版本号");
      expect(session.getState()).toBe("busy");

      await session.handleUserMessage(
        makeInboundMessage({ accountId: "acct-a", senderId: "user-a", messageId: "m2", text: "v9.9.9" }),
      );

      await turnPromise;
      const marker = fs.readFileSync(project.uiMarkerFile, "utf-8");
      expect(marker).toContain("input=v9.9.9");
      expect(session.getState()).toBe("ready");
    },
    TIMEOUT + 30_000,
  );
});
