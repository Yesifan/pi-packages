import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { createWeixinSendFileExtension } from "../../src/pi/extensions/weixin-send-file.js";
import { createWeixinSendProgressExtension } from "../../src/pi/extensions/weixin-send-progress.js";
import { createLogger } from "../../src/util/logger.js";
import { createTmpProject, waitForMarker } from "../helpers/tmp-project.js";
import { FakeWeixinTransport, makeTurn } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "warn" });
const TIMEOUT = 120_000;

describe("M3: daemon runtime weixin extension (real SDK)", () => {
  const runtimes: PiSdkHost[] = [];

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => {});
    }
  });

  async function makeRuntime(projectDir: string, transport: FakeWeixinTransport) {
    const currentTurn = makeTurn();
    const runtime = new PiSdkHost({
      cwd: projectDir,
      logger,
      extensionFactories: [
        createWeixinSendFileExtension({
          fileSender: { sendFile: (turn, p, caption) => transport.sendFile(turn, p, caption) },
          getCurrentTurn: () => currentTurn,
          cwd: projectDir,
          logger,
        }),
        createWeixinSendProgressExtension({
          interaction: {
            getCurrentTurn: () => currentTurn,
            sendText: (turn, text) => transport.sendText(turn, text),
          } as never,
          logger,
        }),
      ],
    });
    runtimes.push(runtime);
    await runtime.start();
    return { runtime, currentTurn };
  }

  it(
    "project extension tool and weixin_send_file coexist; agent sends a real file",
    async () => {
      const project = createTmpProject("m3-coexist");
      fs.writeFileSync(path.join(project.dir, "report.txt"), "report content\n");

      const transport = new FakeWeixinTransport();
      const { runtime } = await makeRuntime(project.dir, transport);

      // 1) Project extension still works alongside the runtime extension.
      await runtime.prompt({
        text: "请调用 mark_test_tool 工具，参数 input 的值为 coex111。只调用这个工具。",
      });
      await waitForMarker(project.markerFile, TIMEOUT);

      // 2) Agent uses weixin_send_file with a cwd-relative path.
      await runtime.prompt({
        text: '请调用 weixin_send_file 工具发送文件 report.txt，caption 为 "hello caption"。只调用这个工具。',
      });

      expect(transport.sentFiles.length).toBeGreaterThan(0);
      const sent = transport.sentFiles.at(-1)!;
      expect(sent.ctx.accountId).toBe("acct-a");
      expect(sent.path).toBe(path.join(project.dir, "report.txt"));
      expect(sent.caption).toBe("hello caption");
    },
    TIMEOUT + 30_000,
  );

  it(
    "weixin_send_file still available after newSession",
    async () => {
      const project = createTmpProject("m3-new-session");
      fs.writeFileSync(path.join(project.dir, "data.csv"), "a,b,c\n");

      const transport = new FakeWeixinTransport();
      const { runtime } = await makeRuntime(project.dir, transport);

      await runtime.newSession();

      await runtime.prompt({
        text: "请调用 weixin_send_file 工具发送文件 data.csv。只调用这个工具。",
      });
      expect(transport.sentFiles.length).toBeGreaterThan(0);
      expect(transport.sentFiles.at(-1)!.path).toBe(path.join(project.dir, "data.csv"));
    },
    TIMEOUT + 30_000,
  );
});
