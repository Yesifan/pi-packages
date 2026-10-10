import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OpenedChild } from "./child-session.js";
import type { SubagentProgressState } from "./progress.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const SUBAGENT_THINKING_LEVELS = ["off", "low", "medium", "high", "max"] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];
export interface AgentDefinitionSnapshot {
  id: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
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
export interface SessionIdentity {
  sessionId: string;
  sessionFile: string;
}
export type ChildState = "opening" | "running" | "idle" | "interrupted";
export interface ChildRecord extends SessionIdentity {
  roleSnapshot: AgentDefinitionSnapshot;
  state: ChildState;
  hasChildren?: true;
}
export interface ParentSessionRecord {
  schemaVersion: 1;
  root: SessionIdentity;
  owner: SessionIdentity;
  parent: SessionIdentity | null;
  children: Record<string, ChildRecord>;
}
export type RunOutcome = "completed" | "failed" | "aborted" | "interrupted" | "incomplete";
export interface SubagentReport {
  name: string;
  agentType: string;
  cwd: string;
  outcome: RunOutcome;
  result: string;
  error?: { code: string; message: string };
  sessionFile?: string;
}
export interface ActiveSubagentSummary {
  name: string;
  agentType: string;
}
export interface DelegationStatusSnapshot {
  activeDirectSubagents: ActiveSubagentSummary[];
  activeDirectSubagentCount: number;
  directSubagents: Array<ActiveSubagentSummary & { state: "running" | "done" | "interrupted" }>;
  directSubagentCount: number;
  interruptedDirectSubagentCount: number;
  liveAgents: number;
  maxLiveAgents: number;
}
export interface AcceptedResult {
  ok: true;
  name: string;
  agent_type: string;
  cwd: string;
  status: "started" | "steered";
  thinking: ThinkingLevel;
  delegation_status: DelegationStatusSnapshot;
}
export interface ErrorResult {
  ok: false;
  error: { code: string; message: string };
  delegation_status?: DelegationStatusSnapshot;
}
export interface CallerBinding {
  agent: Agent | null;
  execution?: Execution;
  depth: number;
  ancestorCwds: string[];
  delegation: DelegationContext;
}
export interface DeliveredSubagentReport extends SubagentReport {
  delegation_status: DelegationStatusSnapshot;
}
export interface RootHostBinding {
  rootSessionId: string;
  rootSessionFile: string;
  ctx: ExtensionContext;
  sendReport(report: SubagentReport, status: DelegationStatusSnapshot): void;
}
export interface RootScope {
  identity: SessionIdentity;
  closing: boolean;
  children: Map<string, Agent>;
  agents: Set<Agent>;
  executions: Set<Execution>;
  openingTasks?: Set<Promise<unknown>>;
  deliveries: Set<ReportDelivery>;
}
export interface Agent {
  name: string;
  identity?: SessionIdentity;
  roleSnapshot: AgentDefinitionSnapshot;
  parent: Agent | null;
  children: Map<string, Agent>;
  state: ChildState;
  hasChildren?: true;
  cwd?: string;
  currentExecution?: Execution;
}
export interface Execution {
  scope: RootScope;
  agent: Agent;
  parent: Execution | RootScope;
  phase: "opening" | "executing" | "waiting" | "closing" | "closed";
  session?: AgentSession;
  opened?: OpenedChild;
  unsubscribe?: () => void;
  release?: Promise<void>;
  pendingChildren: Set<Execution>;
  pendingReports: Set<ReportDelivery>;
  reportReceipts?: Set<string>;
  finalizing: boolean;
  reportSubmitted: boolean;
  accepted: boolean;
  sdkSettled: boolean;
  startLeafId: string | null;
  sourceEntryId?: string;
  failure?: { code: string; message: string };
  progress: SubagentProgressState;
}
export interface ReportDelivery {
  source: Execution;
  target: Execution | RootScope;
  report: SubagentReport;
  sourceEntryId?: string;
  submitted: boolean;
  observed: boolean;
  processed: boolean;
  recordedEntryId?: string;
  receiptBoundary?: string | null;
}
