export interface TurnIssue {
  source: "provider" | "pi" | "extension" | "timeout" | "daemon";
  message: string;
}

export type TurnOutcome =
  | { status: "success"; text: string; warnings: TurnIssue[] }
  | { status: "error"; text: string; error: TurnIssue; warnings: TurnIssue[] }
  | { status: "aborted"; text: string; reason?: string; warnings: TurnIssue[] };

/** Delivery summary for project-wide broadcasts. */
export interface DeliveryReport {
  attempted: number;
  succeeded: number;
  failed: number;
  failedAccounts: string[];
}
