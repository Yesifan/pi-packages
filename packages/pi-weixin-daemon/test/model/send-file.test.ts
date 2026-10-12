import fs from "node:fs";
import path from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import type { PiHostEvent } from "../../src/pi/events.js";
import { createWeixinSendFileExtension } from "../../src/pi/extensions/weixin-send-file.js";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeWeixinTransport, makeTurn } from "../helpers/fake-transport.js";
import { createTmpProject } from "../helpers/tmp-project.js";

const TURN_TIMEOUT = 60_000;

it(
  "weixin_send_file succeeds and routes to the current turn before and after session replacement",
  async () => {
    const project = createTmpProject("send-file");
    const logger = createLogger({ level: "warn" });
    const transport = new FakeWeixinTransport();
    const results: ToolResultEvent[] = [];
    const events: PiHostEvent[] = [];
    let currentTurn = makeTurn();
    fs.writeFileSync(path.join(project.dir, "report.txt"), "report content\n");
    const host = new PiSdkHost({
      cwd: project.dir,
      logger,
      extensionFactories: [
        createWeixinSendFileExtension({
          fileSender: transport,
          getCurrentTurn: () => currentTurn,
          cwd: project.dir,
          logger,
        }),
        (pi) => {
          pi.on("session_start", () => pi.setActiveTools(["weixin_send_file"]));
          pi.on("tool_result", (event) => {
            if (event.toolName === "weixin_send_file") results.push(event);
          });
        },
      ],
    });
    host.onEvent((event) => events.push(event));

    async function send(caption: string): Promise<void> {
      const start = events.length;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          host.prompt({
            text: `Call weixin_send_file exactly once with path "report.txt" and caption "${caption}". Do not call any other tool.`,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void host.abort();
              reject(new Error(`Model smoke timed out after ${TURN_TIMEOUT}ms (${caption})`));
            }, TURN_TIMEOUT);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const finished = events.slice(start).filter((event) => event.type === "assistant_finished");
      expect(finished.length, "Model produced no completed assistant response").toBeGreaterThan(0);
      for (const event of finished) {
        expect(event.stopReason, event.errorMessage).not.toBe("error");
        expect(event.stopReason, event.errorMessage).not.toBe("aborted");
        expect(event.errorMessage).toBeUndefined();
      }
      expect(events.slice(start).filter((event) => event.type === "extension_error")).toEqual([]);
    }

    try {
      await host.start();
      const available = await host.listModels();
      const provider = process.env.PI_WEIXIN_TEST_PROVIDER;
      const modelId = process.env.PI_WEIXIN_TEST_MODEL;
      const model =
        provider || modelId
          ? available.find((model) => model.provider === provider && model.id === modelId)
          : available[0];
      if (!model) {
        throw new Error(
          "Model smoke requires usable provider credentials in the environment. Optionally set both PI_WEIXIN_TEST_PROVIDER and PI_WEIXIN_TEST_MODEL. User auth.json is intentionally not loaded.",
        );
      }
      await host.ensureSession();
      await host.setModel(model.provider, model.id, false);
      const firstSessionId = host.getStatus().sessionId;
      expect(firstSessionId).toBeTruthy();

      await send("before replacement");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        isError: false,
        details: { basename: "report.txt" },
        content: [{ type: "text", text: 'Sent file "report.txt" to the Weixin conversation.' }],
      });
      expect(transport.sentFiles).toEqual([
        {
          ctx: currentTurn,
          path: path.join(project.dir, "report.txt"),
          caption: "before replacement",
        },
      ]);

      expect(await host.newSession()).toEqual({ cancelled: false });
      expect(host.getStatus().sessionId).not.toBe(firstSessionId);
      await host.setModel(model.provider, model.id, false);
      currentTurn = { ...makeTurn("acct-b", "user-b"), messageId: "m-2", contextToken: "tok-2" };
      await send("after replacement");
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({
        isError: false,
        details: { basename: "report.txt" },
        content: [{ type: "text", text: 'Sent file "report.txt" to the Weixin conversation.' }],
      });
      expect(transport.sentFiles).toEqual([
        {
          ctx: makeTurn(),
          path: path.join(project.dir, "report.txt"),
          caption: "before replacement",
        },
        {
          ctx: currentTurn,
          path: path.join(project.dir, "report.txt"),
          caption: "after replacement",
        },
      ]);
    } finally {
      try {
        await host.stop();
      } finally {
        project.cleanup();
      }
    }
  },
  2 * TURN_TIMEOUT + 30_000,
);
