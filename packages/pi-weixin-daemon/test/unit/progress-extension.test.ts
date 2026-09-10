import { describe, expect, it, vi } from "vitest";
import type { InteractionPort } from "../../src/pi/ports.js";
import {
  createWeixinSendProgressExtension,
  sanitizeProgressUpdate,
} from "../../src/pi/extensions/weixin-send-progress.js";
import { createLogger } from "../../src/util/logger.js";
import { makeTurn } from "../helpers/fake-transport.js";

const logger = createLogger({ level: "silent" });

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};
type Execute = (id: string, params: { update: string }) => Promise<ToolResult>;

function captureExecute(interaction: InteractionPort): Execute {
  let execute: Execute | undefined;
  const pi = {
    registerTool(tool: { execute: Execute }) {
      execute = tool.execute;
    },
  };
  createWeixinSendProgressExtension({ interaction, logger })(pi as never);
  if (!execute) throw new Error("tool was not registered");
  return execute;
}

function interaction(turn: ReturnType<typeof makeTurn> | null = makeTurn()) {
  return {
    getCurrentTurn: vi.fn(() => turn ?? undefined),
    sendText: vi.fn(async () => undefined),
  } as unknown as InteractionPort;
}

describe("weixin_send_progress", () => {
  it("sanitizes whitespace and control characters", () => {
    expect(sanitizeProgressUpdate("  Read\u0001 files.\n  Next: tests.  ")).toBe("Read files. Next: tests.");
    expect(sanitizeProgressUpdate("x".repeat(250))).toHaveLength(200);
  });

  it("sends only through the active turn", async () => {
    const bridge = interaction();
    const result = await captureExecute(bridge)("call-1", { update: "  Files explored.\nTests next. " });

    expect(bridge.sendText).toHaveBeenCalledWith(makeTurn(), "Files explored. Tests next.");
    expect(result.details).toEqual({ sent: true });
  });

  it("rejects calls without an active turn", async () => {
    const bridge = interaction(null);
    const result = await captureExecute(bridge)("call-1", { update: "Still working." });

    expect(bridge.sendText).not.toHaveBeenCalled();
    expect(result.details).toEqual({ sent: false, error: "no active turn" });
  });

  it("rejects an update that becomes empty", async () => {
    const bridge = interaction();
    const result = await captureExecute(bridge)("call-1", { update: "\u0001\n" });

    expect(bridge.sendText).not.toHaveBeenCalled();
    expect(result.details).toEqual({ sent: false, error: "empty update" });
  });

  it("propagates delivery failures", async () => {
    const bridge = interaction();
    vi.mocked(bridge.sendText).mockRejectedValueOnce(new Error("network down"));

    await expect(captureExecute(bridge)("call-1", { update: "Tests running." })).rejects.toThrow("network down");
  });
});
