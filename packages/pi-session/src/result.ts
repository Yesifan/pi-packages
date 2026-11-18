import type { SessionManager } from "@earendil-works/pi-coding-agent";

type SessionBranch = ReturnType<SessionManager["getBranch"]>;

function isCommentary(signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const parsed = JSON.parse(signature);
    return parsed?.v === 1 && parsed?.phase === "commentary";
  } catch {
    return false; // Legacy opaque signatures have no phase.
  }
}

export function describeSessionResult(
  startLeafId: string | null,
  branch: SessionBranch,
): { status: "completed" | "failed"; text: string } {
  const boundary = startLeafId ? branch.findIndex((entry) => entry.id === startLeafId) : -1;
  if (startLeafId && boundary < 0) {
    return {
      status: "failed",
      text: "The task's history boundary is absent from the current branch.",
    };
  }
  const entry = branch
    .slice(boundary + 1)
    .findLast((item) => item.type === "message" && item.message.role === "assistant");
  const last = entry?.type === "message" ? entry.message : undefined;
  if (last?.role !== "assistant") {
    return {
      status: "completed",
      text: "Incomplete: the session produced no final assistant text.",
    };
  }
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    return { status: "failed", text: last.errorMessage || `Session ${last.stopReason}` };
  }
  const text = last.content
    .filter((part) => part.type === "text")
    .filter((part) => !isCommentary(part.textSignature))
    .map((part) => part.text)
    .join("")
    .trim();
  if (last.stopReason === "length") {
    return {
      status: "completed",
      text: text
        ? `Incomplete: the model reached its output limit.\n\n${text}`
        : "Incomplete: the model reached its output limit without final text.",
    };
  }
  return {
    status: "completed",
    text: text || "Incomplete: the session produced no final assistant text.",
  };
}
