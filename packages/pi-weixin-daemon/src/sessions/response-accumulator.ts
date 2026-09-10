import { isAgentSettled, isTextDelta, type PiHostEvent } from "../pi/events.js";
import type { TurnIssue, TurnOutcome } from "./turn-outcome.js";

/** Collects one fully-settled Pi run, including protocol-encoded failures. */
export class ResponseAccumulator {
  private text = "";
  private lastAssistant: { stopReason: string; errorMessage?: string } | undefined;
  private previousAssistantFailed = false;
  private readonly warnings: TurnIssue[] = [];
  private settledResolve!: () => void;
  readonly settled: Promise<void>;

  constructor() {
    this.settled = new Promise((resolve) => {
      this.settledResolve = resolve;
    });
  }

  handleEvent(event: PiHostEvent): void {
    if (event.type === "assistant_started") {
      // A new assistant response after a failed one is an automatic retry. Do
      // not leak partial output from the failed attempt into the successful one.
      if (this.previousAssistantFailed) this.text = "";
      this.previousAssistantFailed = false;
    } else if (isTextDelta(event)) {
      this.text += event.delta;
    } else if (event.type === "assistant_finished") {
      this.lastAssistant = { stopReason: event.stopReason, errorMessage: event.errorMessage };
      this.previousAssistantFailed = event.stopReason === "error" || event.stopReason === "aborted";
    } else if (event.type === "extension_error") {
      this.warnings.push({ source: "extension", message: event.message });
    }
    if (isAgentSettled(event)) this.settledResolve();
  }

  getOutcome(): TurnOutcome {
    const text = this.text.trim();
    const last = this.lastAssistant;
    if (last?.stopReason === "aborted") {
      return { status: "aborted", text, reason: last.errorMessage, warnings: [...this.warnings] };
    }
    if (last?.stopReason === "error") {
      return {
        status: "error",
        text,
        error: { source: "provider", message: last.errorMessage ?? "Agent 返回了未说明原因的错误" },
        warnings: [...this.warnings],
      };
    }
    return { status: "success", text, warnings: [...this.warnings] };
  }

  get accumulatedText(): string {
    return this.text;
  }
}
