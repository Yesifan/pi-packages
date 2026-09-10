import { describe, expect, it } from "vitest";
import { ResponseAccumulator } from "../../src/sessions/response-accumulator.js";

function settle(acc: ResponseAccumulator): void {
  acc.handleEvent({ type: "agent_settled" });
}

describe("ResponseAccumulator", () => {
  it("captures a protocol-encoded provider error with partial output", () => {
    const acc = new ResponseAccumulator();
    acc.handleEvent({ type: "assistant_started" });
    acc.handleEvent({ type: "text_delta", delta: "partial" });
    acc.handleEvent({ type: "assistant_finished", stopReason: "error", errorMessage: "quota exceeded" });
    settle(acc);

    expect(acc.getOutcome()).toEqual({
      status: "error",
      text: "partial",
      error: { source: "provider", message: "quota exceeded" },
      warnings: [],
    });
  });

  it("drops failed-attempt text when an automatic retry succeeds", () => {
    const acc = new ResponseAccumulator();
    acc.handleEvent({ type: "assistant_started" });
    acc.handleEvent({ type: "text_delta", delta: "bad partial" });
    acc.handleEvent({ type: "assistant_finished", stopReason: "error", errorMessage: "temporary" });
    acc.handleEvent({ type: "assistant_started" });
    acc.handleEvent({ type: "text_delta", delta: "good answer" });
    acc.handleEvent({ type: "assistant_finished", stopReason: "stop" });
    settle(acc);

    expect(acc.getOutcome()).toEqual({ status: "success", text: "good answer", warnings: [] });
  });

  it("keeps extension errors as warnings without failing a successful turn", () => {
    const acc = new ResponseAccumulator();
    acc.handleEvent({ type: "extension_error", message: "hook exploded", extensionPath: "bad.ts" });
    acc.handleEvent({ type: "assistant_finished", stopReason: "stop" });
    settle(acc);

    expect(acc.getOutcome()).toEqual({
      status: "success",
      text: "",
      warnings: [{ source: "extension", message: "hook exploded" }],
    });
  });

  it("distinguishes an aborted turn", () => {
    const acc = new ResponseAccumulator();
    acc.handleEvent({ type: "assistant_finished", stopReason: "aborted", errorMessage: "cancelled" });
    settle(acc);
    expect(acc.getOutcome().status).toBe("aborted");
  });
});
