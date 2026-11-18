import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SubagentReport } from "./types.js";

function isCommentary(signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const parsed = JSON.parse(signature);
    return parsed?.v === 1 && parsed?.phase === "commentary";
  } catch {
    return false; // Legacy opaque signatures have no phase.
  }
}

export function describeSubagentResult(
  message: AssistantMessage | undefined,
): Pick<SubagentReport, "outcome" | "result" | "error"> {
  if (!message) {
    return { outcome: "incomplete", result: "No final assistant text was produced for this task." };
  }
  const result = message.content
    .filter((value) => value.type === "text")
    .filter((value) => !isCommentary(value.textSignature))
    .map((value) => value.text)
    .join("\n");
  const outcome =
    message.stopReason === "error"
      ? "failed"
      : message.stopReason === "aborted"
        ? "aborted"
        : message.stopReason === "length"
          ? "incomplete"
          : "completed";
  if (message.errorMessage || outcome === "failed" || outcome === "aborted") {
    return {
      outcome,
      result,
      error: {
        code: outcome === "aborted" ? "ABORTED" : "MODEL_ERROR",
        message:
          message.errorMessage ?? "The SDK stopped this execution without a more specific reason.",
      },
    };
  }
  if (!result && outcome === "completed") {
    return {
      outcome: "incomplete",
      result:
        "The final response contains no text; inspect the complete conversation for non-text content.",
    };
  }
  return { outcome, result };
}
