import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatDelegationStatus } from "./status.js";
import type { DelegationStatusSnapshot, ErrorResult } from "./types.js";

interface SubagentErrorOptions extends ErrorOptions {
  delegationStatus?: DelegationStatusSnapshot;
}

export class SubagentError extends Error {
  readonly delegationStatus?: DelegationStatusSnapshot;

  constructor(
    readonly code: string,
    message: string,
    readonly agentId?: string,
    options?: SubagentErrorOptions,
  ) {
    super(message, options);
    this.name = "SubagentError";
    this.delegationStatus = options?.delegationStatus;
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
    ...(normalized.delegationStatus ? { delegation_status: normalized.delegationStatus } : {}),
  };
  return {
    content: [
      { type: "text", text: `${normalized.code}: ${normalized.message}` },
      ...(normalized.delegationStatus
        ? [{ type: "text" as const, text: formatDelegationStatus(normalized.delegationStatus) }]
        : []),
    ],
    details,
  };
}
