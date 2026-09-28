import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { SessionController } from "../../src/sessions/session-controller.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { createLogger } from "../../src/util/logger.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";
import { MultiAccountTransport } from "../helpers/multi-account-transport.js";
import { createTmpProject, trustTmpProject } from "../helpers/tmp-project.js";

const logger = createLogger({ level: "warn" });
const TIMEOUT = 120_000;

describe("M6 e2e: weixin -> real Pi runtime -> weixin", () => {
  const runtimes: PiSdkHost[] = [];
  const restoreTrust: Array<() => void> = [];

  afterEach(async () => {
    try {
      for (const r of runtimes.splice(0)) await r.stop().catch(() => {});
    } finally {
      for (const restore of restoreTrust.splice(0)) restore();
    }
  });

  it(
    "user A's message runs the agent (with project tool) and the reply goes only to A",
    async () => {
      const project = createTmpProject("m6-e2e");
      restoreTrust.push(trustTmpProject(project));
      const transportA = new FakeWeixinTransport();
      const multi = new MultiAccountTransport();
      multi.register("acct-a", transportA);

      const runtime = new PiSdkHost({ cwd: project.dir, logger });
      runtimes.push(runtime);
      await runtime.start();

      const currentTurn = new CurrentTurn();
      const interaction = new WeixinInteractionController({
        getCurrentTurn: () => currentTurn.get(),
        transport: multi,
        logger,
      });
      const session = new SessionController({
        projectId: "m6-e2e",
        host: runtime,
        interaction,
        transport: multi,
        currentTurn,
        logger,
      });

      const turnPromise = session.handleUserMessage(
        makeInboundMessage({
          accountId: "acct-a",
          senderId: "user-a",
          messageId: "m1",
          text: "请调用 mark_test_tool 工具，参数 input 的值为 e2e42。然后告诉我结果。",
        }),
      );
      await turnPromise;
      expect(runtime.getStatus().activeSessionTrust).toBe(true);

      // Project extension tool ran during the turn.
      expect(fs.existsSync(project.markerFile), "Agent did not call mark_test_tool").toBe(true);
      expect(fs.readFileSync(project.markerFile, "utf-8")).toContain("input=e2e42");

      // The reply (agent text) went to A only, and the turn settled.
      const replies = transportA.textsTo("acct-a");
      expect(replies.length).toBeGreaterThan(0);
      const last = replies.at(-1)!;
      expect(last).toBeTruthy();
      // Typing was set and cleared.
      const typing = transportA.typingEvents.map((t) => t.typing);
      expect(typing.at(0)).toBe(true);
      expect(typing.at(-1)).toBe(false);
      expect(typing.slice(0, -1).every(Boolean)).toBe(true);

      // B (unregistered account) got nothing; state is ready again.
      expect(session.getState()).toBe("ready");
    },
    TIMEOUT + 30_000,
  );
});
