import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/util/logger.js";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../../src/weixin/api/api.js", () => ({ sendMessage }));

import { sendTextMessage } from "../../src/weixin/messaging/send.js";

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("sendTextMessage chunk logging", () => {
  beforeEach(() => sendMessage.mockReset());

  it("logs chunk progress without logging message content", async () => {
    const log = logger();
    const text = `PRIVATE-${"x".repeat(4500)}`;
    sendMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("network down"));

    await expect(sendTextMessage({
      to: "user-a",
      text,
      opts: { baseUrl: "https://example.test", contextToken: "ctx", logger: log },
    })).rejects.toThrow("network down");

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ chunkIndex: 2, chunkCount: 2, succeededChunks: 1 }),
      "weixin text chunk delivery failed",
    );
    expect(JSON.stringify((log.debug as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("PRIVATE-");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
