import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ErrorResult } from "./types.js";

export class SubagentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly agentId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SubagentError";
  }
}

export function asSubagentError(error: unknown, fallbackCode = "INTERNAL_ERROR"): SubagentError {
  if (error instanceof SubagentError) return error;
  return new SubagentError(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
    undefined,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function errorToolResult(error: unknown): AgentToolResult<ErrorResult> {
  const normalized = asSubagentError(error);
  const details: ErrorResult = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.agentId ? { id: normalized.agentId } : {}),
    },
  };
  return {
    content: [{ type: "text", text: `${normalized.code}: ${normalized.message}` }],
    details,
  };
}
