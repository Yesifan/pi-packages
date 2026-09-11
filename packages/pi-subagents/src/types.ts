import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentDefinitionSnapshot {
  id: string;
  description?: string;
  tools?: string[];
  thinking?: ThinkingLevel;
  prompt: string;
  source: string;
  contentHash: string;
}

export type AgentTypeRegistry = Map<string, AgentDefinitionSnapshot>;

export interface SubagentsConfig {
  externalDirectories: string[];
  maxDepth: number;
  maxLiveAgents: number;
  uiTimeoutMs: number;
  projectRoot: string;
}

export interface DelegationContext {
  cwd: string;
  agentTypes: AgentTypeRegistry;
  externalDirectories: string[];
  projectRoot: string;
}

export interface ModelIdentity {
  provider: string;
  id: string;
}

export type RunOutcome = "completed" | "failed" | "aborted" | "interrupted" | "incomplete";
export type DeliveryState = "pending" | "submitted" | "recorded";

export interface StoredRun {
  id: string;
  agentId: string;
  parentRunId: string | null;
  acceptedAt: string;
  completedAt?: string;
  outcome?: RunOutcome;
  result?: string;
  error?: { code: string; message: string };
  reportId?: string;
  delivery?: DeliveryState;
}

export interface StoredSubagent {
  schemaVersion: 1;
  id: string;
  rootSessionId: string;
  parentAgentId: string | null;
  name: string;
  cwd: string;
  ancestorCwds: string[];
  agentType: string;
  agentDefinitionSnapshot: AgentDefinitionSnapshot;
  depth: number;
  model: ModelIdentity;
  thinking: ThinkingLevel;
  sessionId: string;
  sessionFile: string;
  lastRunId?: string;
  activeRunId?: string;
  interrupted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentReport {
  schemaVersion: 1;
  reportId: string;
  rootSessionId: string;
  agentId: string;
  runId: string;
  parentAgentId: string | null;
  parentRunId: string | null;
  name: string;
  agentType: string;
  cwd: string;
  outcome: RunOutcome;
  result: string;
  error?: { code: string; message: string };
  completedAt: string;
}

export interface AcceptedResult {
  ok: true;
  id: string;
  run_id: string;
  name: string;
  agent_type: string;
  cwd: string;
  status: "started" | "steered";
  thinking: ThinkingLevel;
}

export interface ErrorResult {
  ok: false;
  error: {
    code: string;
    message: string;
    id?: string;
  };
}

export interface CallerBinding {
  agentId: string | null;
  depth: number;
  ancestorCwds: string[];
  delegation: DelegationContext;
}

export interface RootHostBinding {
  rootSessionId: string;
  rootSessionFile: string;
  ctx: ExtensionContext;
  sendReport(report: SubagentReport): void;
}

export interface LiveAgent {
  id: string;
  runId: string;
  mountId: string;
  phase: "opening" | "executing" | "idle" | "closing";
  session?: AgentSession;
  delegationContext?: DelegationContext;
  pendingChildRuns: Set<string>;
  pendingReportIds: Set<string>;
  runStartLeafId: string | null;
  sdkSettled: boolean;
  accepted: boolean;
  finalizing: boolean;
  unsubscribe?: () => void;
}
