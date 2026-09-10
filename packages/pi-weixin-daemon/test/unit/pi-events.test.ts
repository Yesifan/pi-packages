import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toPiHostEvent } from "../../src/pi/events.js";

function event(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

describe("toPiHostEvent", () => {
  it("preserves assistant terminal errors", () => {
    expect(toPiHostEvent(event({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
    }))).toEqual({ type: "assistant_finished", stopReason: "error", errorMessage: "provider failed" });
  });

  it("marks assistant starts and ignores non-assistant message ends", () => {
    expect(toPiHostEvent(event({ type: "message_start", message: { role: "assistant" } }))).toEqual({
      type: "assistant_started",
    });
    expect(toPiHostEvent(event({ type: "message_end", message: { role: "user" } }))).toEqual({ type: "other" });
  });
});
