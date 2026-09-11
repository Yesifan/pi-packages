import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRuntime as ModelRuntimeType,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveAgentDefinition } from "./agents.js";
import { ChildSessionFactory, type OpenedChild } from "./child-session.js";
import { buildDelegationContext } from "./delegation.js";
import { asSubagentError, SubagentError } from "./errors.js";
import { assertNoDelegationCycle, resolveToolCwd } from "./paths.js";
import { PersistentSubagentStore } from "./store.js";
import type { DelegationRuntimeApi } from "./tools.js";
import type {
  AcceptedResult,
  CallerBinding,
  LiveAgent,
  RootHostBinding,
  StoredRun,
  StoredSubagent,
  SubagentReport,
  SubagentsConfig,
  ThinkingLevel,
} from "./types.js";
import { RootUiBroker } from "./ui.js";

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

async function awaitPreflight(
  accepted: Promise<void>,
  signal: AbortSignal | undefined,
  onAbort?: () => void | Promise<void>,
): Promise<void> {
  if (!signal) return accepted;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      finish(() => {
        void onAbort?.();
        reject(new SubagentError("ABORTED", "Tool call was aborted before Pi accepted the prompt"));
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    void accepted.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}

function roleAllowsDelegation(stored: StoredSubagent): boolean {
  const tools = stored.agentDefinitionSnapshot.tools;
  return tools === undefined || tools.includes("subagent");
}

function formatReport(report: SubagentReport): string {
  const heading = `[Subagent ${report.name} (${report.agentId}) ${report.outcome}]`;
  const error = report.error ? `\n${report.error.code}: ${report.error.message}` : "";
  return `${heading}\nrun: ${report.runId}\ncwd: ${report.cwd}${error}\n\n${report.result}`;
}

export class RootRuntime implements DelegationRuntimeApi {
  private readonly agentDir = getAgentDir();
  private host!: RootHostBinding;
  private rootConfig!: SubagentsConfig;
  private store!: PersistentSubagentStore;
  private uiBroker!: RootUiBroker;
  private childFactory!: ChildSessionFactory;
  private modelRuntime!: ModelRuntimeType;
  private initialized = false;
  private readonly agents = new Map<string, StoredSubagent>();
  private readonly live = new Map<string, LiveAgent>();
  private readonly opened = new Map<string, OpenedChild>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly trustDecisions = new Map<string, boolean>();
  private closing = false;
  private epoch = randomUUID();

  constructor(private readonly ownExtensionPath: string) {}

  async initialize(host: RootHostBinding, config: SubagentsConfig): Promise<void> {
    if (this.initialized)
      throw new SubagentError("INVALID_CONFIG", "RootRuntime is already initialized");
    this.host = host;
    this.rootConfig = config;
    this.uiBroker = new RootUiBroker(host.ctx.ui, host.ctx.hasUI, config.uiTimeoutMs);
    this.modelRuntime = await ModelRuntime.create({
      authPath: path.join(this.agentDir, "auth.json"),
      modelsPath: path.join(this.agentDir, "models.json"),
    });
    this.store = new PersistentSubagentStore(
      this.agentDir,
      host.rootSessionId,
      host.rootSessionFile,
    );
    for (const agent of await this.store.open()) this.agents.set(agent.id, agent);
    this.childFactory = new ChildSessionFactory(
      this.agentDir,
      this.ownExtensionPath,
      this.uiBroker,
      (cwd) => this.resolveTrust(cwd),
    );
    this.initialized = true;
  }

  async createSubagent(
    caller: CallerBinding,
    input: {
      name: string;
      prompt: string;
      agent_type?: string;
      thinking?: ThinkingLevel;
      cwd?: string;
    },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<AcceptedResult> {
    this.assertReady();
    if (!isNonEmpty(input.name) || !isNonEmpty(input.prompt)) {
      throw new SubagentError("INVALID_ARGUMENT", "name and prompt must be non-empty");
    }
    signal?.throwIfAborted();
    const depth = caller.depth + 1;
    if (depth > this.rootConfig.maxDepth) {
      throw new SubagentError(
        "DEPTH_LIMIT",
        `Maximum subagent depth is ${this.rootConfig.maxDepth}`,
      );
    }
    const definition = resolveAgentDefinition(caller.delegation.agentTypes, input.agent_type);
    const target = await resolveToolCwd(input.cwd, caller.delegation);
    if (target.kind === "external") assertNoDelegationCycle(target.cwd, caller.ancestorCwds);
    const parentRunId = this.captureParentRun(caller);
    if (this.live.size >= this.rootConfig.maxLiveAgents) {
      throw new SubagentError(
        "LIVE_AGENT_LIMIT",
        `Maximum live subagents is ${this.rootConfig.maxLiveAgents}`,
      );
    }

    const agentId = id("sa");
    const runId = id("run");
    const placeholder = this.reserveLive(agentId, runId);
    this.reserveParentDependency(caller.agentId, runId);
    try {
      signal?.throwIfAborted();
      if (!(await this.resolveTrust(target.cwd))) {
        throw new SubagentError("PROJECT_NOT_TRUSTED", `Project is not trusted: ${target.cwd}`);
      }
      const canDelegate =
        target.kind === "external" &&
        depth < this.rootConfig.maxDepth &&
        definition.tools !== undefined
          ? definition.tools.includes("subagent")
          : target.kind === "external" && depth < this.rootConfig.maxDepth;
      const delegation = canDelegate
        ? (await buildDelegationContext(target.cwd, this.agentDir)).context
        : undefined;
      const model = ctx.model;
      if (!model) throw new SubagentError("PARENT_MODEL_UNAVAILABLE", "Caller has no active model");
      const requestedThinking =
        input.thinking ??
        definition.thinking ??
        (ctx.thinkingLevel as ThinkingLevel | undefined) ??
        "off";
      const sessionManager = await this.childFactory.createSessionManager(
        target.cwd,
        this.store.sessionsDirectory(agentId),
      );
      const sessionFile = sessionManager.getSessionFile();
      if (!sessionFile) {
        throw new SubagentError(
          "STORE_ERROR",
          "Child SessionManager did not create a session file",
        );
      }
      const timestamp = now();
      const stored: StoredSubagent = {
        schemaVersion: 1,
        id: agentId,
        rootSessionId: this.host.rootSessionId,
        parentAgentId: caller.agentId,
        name: input.name.trim(),
        cwd: target.cwd,
        ancestorCwds: [...caller.ancestorCwds, target.cwd],
        agentType: definition.id,
        agentDefinitionSnapshot: definition,
        depth,
        model: { provider: model.provider, id: model.id },
        thinking: requestedThinking,
        sessionId: sessionManager.getSessionId(),
        sessionFile,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.agents.set(agentId, stored);
      await this.store.saveAgent(stored);
      const opened = await this.childFactory.open({
        stored,
        runId,
        runtime: this,
        delegationContext: delegation,
        canDelegate,
        sessionManager,
        model,
        thinking: requestedThinking,
      });
      stored.thinking = opened.actualThinking;
      placeholder.session = opened.session;
      placeholder.delegationContext = delegation;
      this.opened.set(agentId, opened);
      this.subscribe(placeholder);
      return await this.startRun(stored, placeholder, input.prompt, parentRunId, signal);
    } catch (error) {
      await this.rollbackOpening(agentId, caller.agentId, runId, true);
      throw error;
    }
  }

  async askSubagent(
    caller: CallerBinding,
    input: { id: string; prompt: string; isSteer?: boolean },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<AcceptedResult> {
    this.assertReady();
    if (!isNonEmpty(input.id) || !isNonEmpty(input.prompt)) {
      throw new SubagentError("INVALID_ARGUMENT", "id and prompt must be non-empty");
    }
    const stored = this.getOwnedAgent(caller, input.id);
    if (input.isSteer === true) return this.steer(stored, input.prompt, signal);
    if (this.live.has(stored.id)) {
      throw new SubagentError(
        "SUBAGENT_BUSY",
        `${stored.name} still has an active delegation`,
        stored.id,
      );
    }
    signal?.throwIfAborted();
    if (this.live.size >= this.rootConfig.maxLiveAgents) {
      throw new SubagentError(
        "LIVE_AGENT_LIMIT",
        `Maximum live subagents is ${this.rootConfig.maxLiveAgents}`,
      );
    }
    const target = await resolveToolCwd(stored.cwd, caller.delegation);
    const parentRunId = this.captureParentRun(caller);
    const runId = id("run");
    const live = this.reserveLive(stored.id, runId);
    this.reserveParentDependency(caller.agentId, runId);
    try {
      signal?.throwIfAborted();
      if (!(await this.resolveTrust(stored.cwd))) {
        throw new SubagentError("PROJECT_NOT_TRUSTED", `Project is not trusted: ${stored.cwd}`);
      }
      const canDelegate =
        target.kind === "external" &&
        stored.depth < this.rootConfig.maxDepth &&
        roleAllowsDelegation(stored);
      const delegation = canDelegate
        ? (await buildDelegationContext(stored.cwd, this.agentDir)).context
        : undefined;
      const model = this.resolveStoredModel(stored, ctx);
      const sessionManager = this.childFactory.openSessionManager(stored);
      const opened = await this.childFactory.open({
        stored,
        runId,
        runtime: this,
        delegationContext: delegation,
        canDelegate,
        sessionManager,
        model,
        thinking: stored.thinking,
      });
      live.session = opened.session;
      live.delegationContext = delegation;
      this.opened.set(stored.id, opened);
      this.subscribe(live);
      return await this.startRun(stored, live, input.prompt, parentRunId, signal);
    } catch (error) {
      await this.rollbackOpening(stored.id, caller.agentId, runId, false);
      throw error;
    }
  }

  private async steer(
    stored: StoredSubagent,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<AcceptedResult> {
    signal?.throwIfAborted();
    const live = this.live.get(stored.id);
    if (
      !live?.accepted ||
      live.phase !== "executing" ||
      !live.session ||
      !live.session.isStreaming ||
      live.finalizing
    ) {
      throw new SubagentError(
        "SUBAGENT_NOT_STEERABLE",
        `${stored.name} does not have an actively streaming run`,
        stored.id,
      );
    }
    let acceptedResolve!: () => void;
    let acceptedReject!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      acceptedResolve = resolve;
      acceptedReject = reject;
    });
    // Warning Cache Broke: steering text must remain ordinary conversation input; never
    // splice it into system prompt/history or enable template expansion during resume.
    const task = live.session.prompt(prompt, {
      streamingBehavior: "steer",
      expandPromptTemplates: false,
      preflightResult: (success) => {
        if (success) acceptedResolve();
        else acceptedReject(new SubagentError("SUBAGENT_NOT_STEERABLE", "Pi rejected steering"));
      },
    });
    void task.catch((error) => {
      acceptedReject(error);
    });
    await awaitPreflight(accepted, signal);
    return this.acceptedResult(stored, live.runId, "steered");
  }

  private async startRun(
    stored: StoredSubagent,
    live: LiveAgent,
    prompt: string,
    parentRunId: string | null,
    signal: AbortSignal | undefined,
  ): Promise<AcceptedResult> {
    signal?.throwIfAborted();
    const session = live.session;
    if (!session) throw new SubagentError("STORE_ERROR", "Child session was not opened");
    live.phase = "executing";
    live.sdkSettled = false;
    live.runStartLeafId = session.sessionManager.getLeafId();
    const run: StoredRun = {
      id: live.runId,
      agentId: stored.id,
      parentRunId,
      acceptedAt: now(),
    };
    let acceptedResolve!: () => void;
    let acceptedReject!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      acceptedResolve = resolve;
      acceptedReject = reject;
    });
    const epoch = this.epoch;
    const mountId = live.mountId;
    let promptFailed = false;
    let promptFailure: unknown;
    const task = session.prompt(prompt, {
      expandPromptTemplates: false,
      preflightResult: (success) => {
        if (success) acceptedResolve();
        else acceptedReject(new SubagentError("INVALID_ARGUMENT", "Pi rejected the task prompt"));
      },
    });
    void task.catch((error) => {
      promptFailed = true;
      promptFailure = error;
      acceptedReject(error);
      if (live.accepted && this.isCurrent(epoch, live, mountId)) void this.failRun(live, error);
    });
    await awaitPreflight(accepted, signal, () => session.abort());
    this.runs.set(run.id, run);
    stored.activeRunId = run.id;
    stored.lastRunId = run.id;
    stored.interrupted = false;
    stored.updatedAt = now();
    await this.store.saveRun(run);
    await this.store.saveAgent(stored);
    live.accepted = true;
    if (promptFailed) void this.failRun(live, promptFailure);
    else void this.maybeFinalize(live);
    return this.acceptedResult(stored, run.id, "started");
  }

  private subscribe(live: LiveAgent): void {
    live.unsubscribe = live.session?.subscribe((event) => {
      if (event.type !== "agent_settled") return;
      const current = this.live.get(live.id);
      if (current !== live || current.mountId !== live.mountId) return;
      live.sdkSettled = true;
      live.phase = "idle";
      void this.maybeFinalize(live);
    });
  }

  private async maybeFinalize(live: LiveAgent): Promise<void> {
    if (
      !live.accepted ||
      live.finalizing ||
      !live.sdkSettled ||
      live.session?.isStreaming ||
      live.pendingChildRuns.size > 0 ||
      live.pendingReportIds.size > 0
    ) {
      return;
    }
    live.finalizing = true;
    await this.finalizeRun(live);
  }

  private async failRun(live: LiveAgent, error: unknown): Promise<void> {
    if (!live.accepted || live.finalizing) return;
    live.finalizing = true;
    await this.finalizeRun(live, asSubagentError(error, "SUBAGENT_RUN_FAILED"));
  }

  private extractResult(live: LiveAgent): {
    outcome: StoredRun["outcome"];
    result: string;
    error?: { code: string; message: string };
  } {
    const branch = live.session?.sessionManager.getBranch() ?? [];
    const marker = live.runStartLeafId;
    const markerIndex = marker ? branch.findIndex((entry) => entry.id === marker) : -1;
    const entries = branch.slice(markerIndex + 1);
    const assistants = entries.filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    const last = assistants.at(-1);
    if (!last || last.type !== "message" || last.message.role !== "assistant") {
      return {
        outcome: "failed",
        result: "",
        error: { code: "EMPTY_OUTPUT", message: "No assistant output" },
      };
    }
    const text = last.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (last.message.stopReason === "error") {
      return {
        outcome: "failed",
        result: text,
        error: { code: "MODEL_ERROR", message: last.message.errorMessage ?? "Model error" },
      };
    }
    if (last.message.stopReason === "aborted") {
      return {
        outcome: "aborted",
        result: text,
        error: { code: "ABORTED", message: last.message.errorMessage ?? "Run aborted" },
      };
    }
    if (last.message.stopReason === "length") return { outcome: "incomplete", result: text };
    if (!text) {
      return {
        outcome: "incomplete",
        result: "The final response contained no text content.",
      };
    }
    return { outcome: "completed", result: text };
  }

  private async finalizeRun(live: LiveAgent, failure?: SubagentError): Promise<void> {
    const stored = this.agents.get(live.id);
    const run = this.runs.get(live.runId);
    if (!stored || !run) return;
    live.phase = "closing";
    const extracted = failure
      ? {
          outcome: "failed" as const,
          result: "",
          error: { code: failure.code, message: failure.message },
        }
      : this.extractResult(live);
    const completedAt = now();
    const report: SubagentReport = {
      schemaVersion: 1,
      reportId: id("report"),
      rootSessionId: stored.rootSessionId,
      agentId: stored.id,
      runId: run.id,
      parentAgentId: stored.parentAgentId,
      parentRunId: run.parentRunId,
      name: stored.name,
      agentType: stored.agentType,
      cwd: stored.cwd,
      outcome: extracted.outcome ?? "failed",
      result: extracted.result,
      ...(extracted.error ? { error: extracted.error } : {}),
      completedAt,
    };
    run.completedAt = completedAt;
    run.outcome = report.outcome;
    run.result = report.result;
    run.error = report.error;
    run.reportId = report.reportId;
    run.delivery = "pending";
    stored.activeRunId = undefined;
    stored.updatedAt = completedAt;
    await this.store.saveRun(run);
    await this.store.saveAgent(stored);
    await this.disposeMount(live.id);
    this.live.delete(live.id);
    this.runs.delete(run.id);
    if (!this.closing) await this.routeReport(stored, run, report);
  }

  private async routeReport(
    stored: StoredSubagent,
    run: StoredRun,
    report: SubagentReport,
  ): Promise<void> {
    if (stored.parentAgentId === null) {
      this.host?.sendReport(report);
      run.delivery = "submitted";
      await this.store?.saveRun(run);
      return;
    }
    const parent = this.live.get(stored.parentAgentId);
    if (!parent || parent.runId !== run.parentRunId || !parent.session) return;
    parent.pendingReportIds.add(report.reportId);
    parent.pendingChildRuns.delete(run.id);
    parent.sdkSettled = false;
    parent.phase = "executing";
    const epoch = this.epoch;
    const mountId = parent.mountId;
    const delivery = parent.session.sendCustomMessage(
      {
        customType: "bykwp-subagent-report",
        content: formatReport(report),
        display: true,
        details: report,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    run.delivery = "submitted";
    await this.store.saveRun(run);
    void delivery.then(
      async () => {
        if (!this.isCurrent(epoch, parent, mountId)) return;
        parent.pendingReportIds.delete(report.reportId);
        run.delivery = "recorded";
        await this.store?.saveRun(run);
        void this.maybeFinalize(parent);
      },
      (error) => {
        if (this.isCurrent(epoch, parent, mountId)) void this.failRun(parent, error);
      },
    );
  }

  private reserveLive(agentId: string, runId: string): LiveAgent {
    const live: LiveAgent = {
      id: agentId,
      runId,
      mountId: id("mount"),
      phase: "opening",
      pendingChildRuns: new Set(),
      pendingReportIds: new Set(),
      runStartLeafId: null,
      sdkSettled: false,
      accepted: false,
      finalizing: false,
    };
    this.live.set(agentId, live);
    return live;
  }

  private captureParentRun(caller: CallerBinding): string | null {
    if (caller.agentId === null) return null;
    const parent = this.live.get(caller.agentId);
    if (!parent?.accepted || parent.finalizing) {
      throw new SubagentError("DELEGATION_DISABLED", "Caller does not have an active run");
    }
    return parent.runId;
  }

  private reserveParentDependency(parentAgentId: string | null, childRunId: string): void {
    if (parentAgentId === null) return;
    const parent = this.live.get(parentAgentId);
    if (!parent) throw new SubagentError("DELEGATION_DISABLED", "Caller session is unavailable");
    parent.pendingChildRuns.add(childRunId);
  }

  private async rollbackOpening(
    agentId: string,
    parentAgentId: string | null,
    runId: string,
    deleteIdentity: boolean,
  ): Promise<void> {
    const parent = parentAgentId ? this.live.get(parentAgentId) : undefined;
    parent?.pendingChildRuns.delete(runId);
    await this.disposeMount(agentId);
    this.live.delete(agentId);
    this.runs.delete(runId);
    if (deleteIdentity) {
      this.agents.delete(agentId);
      await this.store?.deleteAgent(agentId);
    }
  }

  private async disposeMount(agentId: string): Promise<void> {
    const live = this.live.get(agentId);
    live?.unsubscribe?.();
    if (live?.unsubscribe) live.unsubscribe = undefined;
    const opened = this.opened.get(agentId);
    this.opened.delete(agentId);
    if (opened) await opened.dispose();
  }

  private getOwnedAgent(caller: CallerBinding, agentId: string): StoredSubagent {
    const stored = this.agents.get(agentId);
    if (!stored)
      throw new SubagentError("SUBAGENT_NOT_FOUND", `Unknown subagent: ${agentId}`, agentId);
    if (stored.parentAgentId !== caller.agentId) {
      throw new SubagentError(
        "SUBAGENT_NOT_OWNED",
        `Subagent is not directly owned by caller`,
        agentId,
      );
    }
    return stored;
  }

  private resolveStoredModel(
    stored: StoredSubagent,
    ctx: ExtensionContext,
  ): Model<Api> | undefined {
    const model = this.modelRuntime?.getModel(stored.model.provider, stored.model.id);
    if (model) return model;
    if (ctx.model?.provider === stored.model.provider && ctx.model.id === stored.model.id) {
      return ctx.model;
    }
    // A target-cwd extension may register this exact provider/model while the child opens.
    // ChildSessionFactory performs the final identity and authentication check.
    return undefined;
  }

  private acceptedResult(
    stored: StoredSubagent,
    runId: string,
    status: "started" | "steered",
  ): AcceptedResult {
    return {
      ok: true,
      id: stored.id,
      run_id: runId,
      name: stored.name,
      agent_type: stored.agentType,
      cwd: stored.cwd,
      status,
      thinking: stored.thinking,
    };
  }

  private async resolveTrust(cwd: string): Promise<boolean> {
    const known = this.trustDecisions.get(cwd);
    if (known !== undefined) return known;
    if (!hasTrustRequiringProjectResources(cwd)) {
      this.trustDecisions.set(cwd, true);
      return true;
    }
    if (cwd === this.host?.ctx.cwd && this.host.ctx.isProjectTrusted()) {
      this.trustDecisions.set(cwd, true);
      return true;
    }
    const saved = new ProjectTrustStore(this.agentDir).get(cwd);
    if (saved !== null) {
      this.trustDecisions.set(cwd, saved);
      return saved;
    }
    const policy = SettingsManager.create(cwd, this.agentDir).getDefaultProjectTrust();
    if (policy === "always") {
      this.trustDecisions.set(cwd, true);
      return true;
    }
    if (policy === "never" || !this.host?.ctx.hasUI || !this.uiBroker) {
      this.trustDecisions.set(cwd, false);
      return false;
    }
    const trusted = await this.uiBroker.enqueue(
      `trust:${cwd}`,
      false,
      undefined,
      (options) =>
        this.host?.ctx.ui.confirm(
          "Trust external project?",
          `Allow this subagent session to load project resources from ${cwd}?`,
          options,
        ) ?? Promise.resolve(false),
    );
    this.trustDecisions.set(cwd, trusted);
    return trusted;
  }

  private isCurrent(epoch: string, live: LiveAgent, mountId: string): boolean {
    return (
      !this.closing &&
      this.epoch === epoch &&
      this.live.get(live.id) === live &&
      live.mountId === mountId
    );
  }

  private assertReady(): void {
    if (this.closing) throw new SubagentError("ROOT_CLOSING", "Root session is closing");
    if (!this.initialized) {
      throw new SubagentError("INVALID_CONFIG", "RootRuntime is not initialized");
    }
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.epoch = randomUUID();
    if (!this.initialized) return;
    this.uiBroker.shutdown();
    const entries = [...this.live.values()];
    await Promise.allSettled(entries.map((live) => live.session?.abort()));
    for (const live of entries) {
      const stored = this.agents.get(live.id);
      const interruptedAt = now();
      const run = this.runs.get(live.runId);
      if (run && !run.completedAt) {
        run.completedAt = interruptedAt;
        run.outcome = "interrupted";
        run.result = run.result ?? "";
        run.error = {
          code: "INTERRUPTED",
          message: "The root session ended before this run completed; it was not replayed.",
        };
        await this.store.saveRun(run);
      }
      if (stored?.activeRunId) {
        stored.activeRunId = undefined;
        stored.interrupted = true;
        stored.updatedAt = interruptedAt;
        await this.store.saveAgent(stored);
      }
      await this.disposeMount(live.id);
    }
    this.live.clear();
    this.runs.clear();
    await this.store.close();
  }
}
