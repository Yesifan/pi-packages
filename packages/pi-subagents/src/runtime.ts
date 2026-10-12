import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AgentSessionEvent,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveAgentDefinition } from "./agents.js";
import { ChildSessionFactory } from "./child-session.js";
import { loadSubagentsConfig } from "./config.js";
import { buildDelegationContext } from "./delegation.js";
import { asSubagentError, SubagentError } from "./errors.js";
import {
  assertNoDelegationCycle,
  canonicalizeDirectory,
  findProjectRoot,
  resolveToolCwd,
} from "./paths.js";
import {
  applyProgressEvent,
  buildProgressWidgetLines,
  createSubagentProgressState,
} from "./progress.js";
import { createDelegationStatusSnapshot, formatSubagentReport } from "./status.js";
import { PersistentSubagentStore } from "./store.js";
import type { DelegationRuntimeApi } from "./tools.js";
import type {
  AcceptedResult,
  Agent,
  CallerBinding,
  ChildRecord,
  ChildState,
  Execution,
  ReportDelivery,
  RootHostBinding,
  RootScope,
  SessionIdentity,
  SubagentReport,
  SubagentsConfig,
  SubagentThinkingLevel,
  ThinkingLevel,
} from "./types.js";
import { RootUiBroker } from "./ui.js";

function identity(agent: Agent): SessionIdentity {
  if (!agent.identity)
    throw new SubagentError(
      "SESSION_HISTORY_UNAVAILABLE",
      `History is not initialized for ${agent.name}`,
    );
  return agent.identity;
}
function childRecord(agent: Agent): ChildRecord {
  return {
    ...identity(agent),
    roleSnapshot: agent.roleSnapshot,
    state: agent.state,
    ...(agent.hasChildren ? { hasChildren: true } : {}),
  };
}
function validName(name: string): string {
  if (typeof name !== "string" || !name.trim())
    throw new SubagentError("INVALID_ARGUMENT", "name must be non-empty");
  return name.trim();
}
function validPrompt(prompt: string): void {
  if (typeof prompt !== "string" || !prompt.trim())
    throw new SubagentError("INVALID_ARGUMENT", "prompt must be non-empty");
}
function correlation(details: unknown, delivery: ReportDelivery): boolean {
  if (!details || typeof details !== "object") return false;
  const value = details as { sourceSessionId?: string; sourceEntryId?: string };
  return (
    value.sourceSessionId === delivery.source.agent.identity?.sessionId &&
    value.sourceEntryId === delivery.sourceEntryId
  );
}

export class RootRuntime implements DelegationRuntimeApi {
  private readonly agentDir = getAgentDir();
  private scope?: RootScope;
  private host!: RootHostBinding;
  private rootConfig!: SubagentsConfig;
  private store!: PersistentSubagentStore;
  private uiBroker!: RootUiBroker;
  private childFactory!: ChildSessionFactory;
  private readonly trustDecisions = new Map<string, boolean>();
  private shutdownPromise?: Promise<void>;
  private initialization?: Promise<void>;
  private initialized = false;
  private readonly pendingPrompts = new WeakMap<Execution, number>();
  private readonly abortTasks = new WeakMap<Execution, Promise<void>>();
  private readonly branchInitializations = new WeakMap<Agent, Promise<void>>();
  constructor(private readonly ownExtensionPath: string) {}

  initialize(host: RootHostBinding, config: SubagentsConfig): Promise<void> {
    if (this.initialization)
      return Promise.reject(
        new SubagentError("INVALID_CONFIG", "RootRuntime is already initialized"),
      );
    this.initialization = this.initializeScope(host, config);
    return this.initialization;
  }
  private async initializeScope(host: RootHostBinding, config: SubagentsConfig): Promise<void> {
    if (this.scope) throw new SubagentError("INVALID_CONFIG", "RootRuntime is already initialized");
    this.host = host;
    this.rootConfig = config;
    const scope: RootScope = {
      identity: { sessionId: host.rootSessionId, sessionFile: path.resolve(host.rootSessionFile) },
      closing: false,
      children: new Map(),
      agents: new Set(),
      executions: new Set(),
      openingTasks: new Set(),
      deliveries: new Set(),
    };
    this.scope = scope;
    this.uiBroker = new RootUiBroker(host.ctx.ui, host.ctx.hasUI, config.uiTimeoutMs);
    this.childFactory = new ChildSessionFactory(
      this.agentDir,
      this.ownExtensionPath,
      this.uiBroker,
      (target) => this.resolveTrust(target),
    );
    this.store = new PersistentSubagentStore(this.agentDir, scope.identity);
    try {
      const assertScope = () => {
        if (scope.closing || this.scope !== scope)
          throw new SubagentError("ROOT_CLOSING", "Root initialization was interrupted");
      };
      const cwd = await canonicalizeDirectory(host.ctx.cwd, {
        missing: "CWD_NOT_FOUND",
        notDirectory: "CWD_NOT_DIRECTORY",
      });
      assertScope();
      this.trustDecisions.set(cwd, host.ctx.isProjectTrusted());
      this.trustDecisions.set(config.projectRoot, true);
      const root = await this.store.open();
      assertScope();
      const seen = new Set([scope.identity.sessionId]);
      const restore = async (
        owner: Agent | null,
        records: Record<string, ChildRecord>,
        ancestors: string[],
        admission: CallerBinding["delegation"],
      ): Promise<void> => {
        for (const [name, record] of Object.entries(records)) {
          if (seen.has(record.sessionId))
            throw new SubagentError(
              "STORE_ERROR",
              "Duplicate or cyclic Pi session identity in subagent metadata",
            );
          seen.add(record.sessionId);
          const manager = await this.childFactory.openSessionManager(record);
          const childCwd = await canonicalizeDirectory(manager.getCwd(), {
            missing: "CWD_NOT_FOUND",
            notDirectory: "CWD_NOT_DIRECTORY",
          });
          assertScope();
          if (ancestors.length > config.maxDepth)
            throw new SubagentError(
              "DEPTH_LIMIT",
              `Recovered tree exceeds maximum depth ${config.maxDepth}`,
            );
          await resolveToolCwd(childCwd, admission);
          if (childCwd !== ancestors.at(-1)) assertNoDelegationCycle(childCwd, ancestors);
          if (!(await this.resolveTrust(childCwd)))
            throw new SubagentError(
              "PROJECT_NOT_TRUSTED",
              `Recovered child project is not trusted: ${childCwd}`,
            );
          assertScope();
          const state =
            record.state === "running"
              ? "interrupted"
              : record.state === "opening"
                ? "idle"
                : record.state;
          const agent: Agent = {
            name,
            identity: { sessionId: record.sessionId, sessionFile: record.sessionFile },
            roleSnapshot: record.roleSnapshot,
            parent: owner,
            children: new Map(),
            state,
            cwd: childCwd,
            ...(record.hasChildren ? { hasChildren: true } : {}),
          };
          (owner?.children ?? scope.children).set(name, agent);
          scope.agents.add(agent);
          if (state !== record.state) await this.saveAgent(agent);
          const nested = await this.store.readOwner(
            identity(agent),
            owner ? identity(owner) : scope.identity,
            agent.hasChildren,
          );
          assertScope();
          if (nested) {
            if (childCwd === ancestors.at(-1) && Object.keys(nested.children).length)
              throw new SubagentError("STORE_ERROR", "Same-cwd leaf has stored descendants");
            if (Object.keys(nested.children).length) {
              if (
                ancestors.length >= config.maxDepth ||
                (agent.roleSnapshot.tools !== undefined &&
                  !agent.roleSnapshot.tools.includes("subagent")) ||
                agent.roleSnapshot.disallowedTools?.includes("subagent")
              )
                throw new SubagentError(
                  "DELEGATION_DISABLED",
                  `Recovered role/depth does not permit children for ${agent.name}`,
                );
              const projectRoot = await findProjectRoot(childCwd);
              if (!(await this.resolveTrust(projectRoot)))
                throw new SubagentError(
                  "PROJECT_NOT_TRUSTED",
                  `Recovered project root is not trusted: ${projectRoot}`,
                );
              const childConfig = await loadSubagentsConfig(childCwd);
              assertScope();
              await restore(agent, nested.children, [...ancestors, childCwd], {
                cwd: childCwd,
                projectRoot: childConfig.projectRoot,
                externalDirectories: childConfig.externalDirectories,
                agentTypes: new Map(),
              });
            }
          }
        }
      };
      if (root)
        await restore(null, root.children, [cwd], {
          cwd,
          projectRoot: config.projectRoot,
          externalDirectories: config.externalDirectories,
          agentTypes: new Map(),
        });
      assertScope();
      this.initialized = true;
    } catch (error) {
      scope.closing = true;
      await this.store.close();
      this.uiBroker.shutdown();
      throw error;
    }
  }
  getMaxLiveAgents(): number | undefined {
    return this.initialized && this.scope && !this.scope.closing
      ? this.rootConfig.maxLiveAgents
      : undefined;
  }
  private ready(): RootScope {
    if (this.scope?.closing) throw new SubagentError("ROOT_CLOSING", "Root session is closing");
    if (!this.scope || !this.initialized)
      throw new SubagentError("INVALID_CONFIG", "RootRuntime is not initialized");
    return this.scope;
  }
  private current(execution: Execution): boolean {
    return (
      this.scope === execution.scope &&
      !execution.scope.closing &&
      execution.agent.currentExecution === execution &&
      execution.phase !== "closed"
    );
  }
  private assertCurrent(execution: Execution): void {
    if (!this.current(execution))
      throw new SubagentError("ROOT_CLOSING", "The owning execution is no longer active");
  }
  private callerParent(caller: CallerBinding, scope: RootScope): Execution | RootScope {
    if (!caller.agent) return scope;
    const execution = caller.execution;
    if (!execution || execution.agent !== caller.agent || !this.current(execution))
      throw new SubagentError("ROOT_CLOSING", "The caller execution is no longer active");
    return execution;
  }
  private reserve(agent: Agent, parent: Execution | RootScope, scope: RootScope): Execution {
    if (scope.executions.size >= this.rootConfig.maxLiveAgents)
      throw new SubagentError(
        "LIVE_AGENT_LIMIT",
        `Maximum live subagents is ${this.rootConfig.maxLiveAgents}`,
        undefined,
        { delegationStatus: this.statusFor(agent.parent) },
      );
    const execution: Execution = {
      scope,
      agent,
      parent,
      phase: "opening",
      pendingChildren: new Set(),
      pendingReports: new Set(),
      finalizing: false,
      reportSubmitted: false,
      accepted: false,
      sdkSettled: false,
      startLeafId: null,
      progress: createSubagentProgressState(),
    };
    agent.currentExecution = execution;
    scope.executions.add(execution);
    if ("agent" in parent) parent.pendingChildren.add(execution);
    this.refreshProgress();
    return execution;
  }
  async createSubagent(
    caller: CallerBinding,
    input: {
      name: string;
      prompt: string;
      agent_type?: string;
      thinking?: SubagentThinkingLevel;
      cwd?: string;
    },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AcceptedResult> {
    const scope = this.ready();
    return this.trackOpening(scope, this.createTask(caller, input, ctx, signal));
  }
  async askSubagent(
    caller: CallerBinding,
    input: { name: string; prompt: string; isSteer?: boolean },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AcceptedResult> {
    const scope = this.ready();
    return this.trackOpening(scope, this.askTask(caller, input, ctx, signal));
  }
  private async trackOpening<T>(scope: RootScope, task: Promise<T>): Promise<T> {
    const openingTasks = scope.openingTasks ?? new Set();
    scope.openingTasks = openingTasks;
    openingTasks.add(task);
    try {
      return await task;
    } finally {
      openingTasks.delete(task);
    }
  }
  private async createTask(
    caller: CallerBinding,
    input: {
      name: string;
      prompt: string;
      agent_type?: string;
      thinking?: SubagentThinkingLevel;
      cwd?: string;
    },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AcceptedResult> {
    const scope = this.ready();
    const name = validName(input.name);
    validPrompt(input.prompt);
    signal?.throwIfAborted();
    const children = caller.agent?.children ?? scope.children;
    if (children.has(name))
      throw new SubagentError(
        "SUBAGENT_NAME_EXISTS",
        `${name} already exists among your direct subagents; use ask_subagent for follow-up work.`,
      );
    if (caller.depth >= this.rootConfig.maxDepth)
      throw new SubagentError(
        "DEPTH_LIMIT",
        `Maximum subagent depth is ${this.rootConfig.maxDepth}`,
      );
    const roleSnapshot = resolveAgentDefinition(caller.delegation.agentTypes, input.agent_type);
    const parent = this.callerParent(caller, scope);
    const agent: Agent = {
      name,
      roleSnapshot,
      parent: caller.agent,
      children: new Map(),
      state: "opening",
    };
    const execution = this.reserve(agent, parent, scope);
    children.set(name, agent);
    scope.agents.add(agent);
    let createdFile: string | undefined;
    try {
      const target = await resolveToolCwd(input.cwd, caller.delegation);
      this.assertCurrent(execution);
      if (target.kind === "external") assertNoDelegationCycle(target.cwd, caller.ancestorCwds);
      agent.cwd = target.cwd;
      if (!(await this.resolveTrust(target.cwd)))
        throw new SubagentError("PROJECT_NOT_TRUSTED", `Project is not trusted: ${target.cwd}`);
      this.assertCurrent(execution);
      const manager = await this.childFactory.createSessionManager(target.cwd);
      createdFile = manager.getSessionFile();
      this.assertCurrent(execution);
      if (!createdFile)
        throw new SubagentError(
          "SESSION_HISTORY_UNAVAILABLE",
          "SDK did not allocate persistent child history",
        );
      agent.identity = {
        sessionId: manager.getSessionId(),
        sessionFile: await realpath(createdFile),
      };
      this.assertCurrent(execution);
      if (agent.parent) await this.ensureBranch(agent.parent);
      this.assertCurrent(execution);
      await this.saveAgent(agent);
      this.assertCurrent(execution);
      await this.mount(execution, caller, manager, ctx, false, input.thinking);
      return await this.start(execution, input.prompt, signal);
    } catch (error) {
      if (!execution.accepted) await this.rollback(execution, true, "idle", createdFile);
      else void this.failExecution(execution, error);
      throw error;
    }
  }
  private async askTask(
    caller: CallerBinding,
    input: { name: string; prompt: string; isSteer?: boolean },
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AcceptedResult> {
    const scope = this.ready();
    const name = validName(input.name);
    validPrompt(input.prompt);
    signal?.throwIfAborted();
    const parent = this.callerParent(caller, scope);
    const agent = (caller.agent?.children ?? scope.children).get(name);
    if (!agent)
      throw new SubagentError("SUBAGENT_NOT_FOUND", `No directly owned subagent named ${name}`);
    if (input.isSteer) return this.steer(agent, input.prompt, signal);
    if (caller.depth >= this.rootConfig.maxDepth)
      throw new SubagentError(
        "DEPTH_LIMIT",
        `Maximum subagent depth is ${this.rootConfig.maxDepth}`,
      );
    if (agent.currentExecution)
      throw new SubagentError(
        "SUBAGENT_BUSY",
        `${name} is ${agent.currentExecution.phase === "waiting" ? "waiting for children or reports" : "busy"}`,
        undefined,
        { delegationStatus: this.statusFor(caller.agent) },
      );
    const previousState = agent.state;
    const execution = this.reserve(agent, parent, scope);
    agent.state = "opening";
    try {
      await this.saveAgent(agent);
      this.assertCurrent(execution);
      const manager = await this.childFactory.openSessionManager(identity(agent));
      this.assertCurrent(execution);
      agent.cwd = await canonicalizeDirectory(manager.getCwd(), {
        missing: "CWD_NOT_FOUND",
        notDirectory: "CWD_NOT_DIRECTORY",
      });
      const target = await resolveToolCwd(agent.cwd, caller.delegation);
      if (target.kind === "external") assertNoDelegationCycle(target.cwd, caller.ancestorCwds);
      this.assertCurrent(execution);
      await this.mount(execution, caller, manager, ctx, true);
      return await this.start(execution, input.prompt, signal);
    } catch (error) {
      if (!execution.accepted) await this.rollback(execution, false, previousState);
      else void this.failExecution(execution, error);
      throw error;
    }
  }
  private async mount(
    execution: Execution,
    caller: CallerBinding,
    manager: SessionManager,
    ctx: ExtensionContext,
    restoring: boolean,
    thinking?: SubagentThinkingLevel,
  ): Promise<void> {
    const agent = execution.agent;
    const cwd = agent.cwd!;
    const depth = caller.depth + 1;
    const canDelegate =
      cwd !== caller.delegation.cwd &&
      depth < this.rootConfig.maxDepth &&
      (agent.roleSnapshot.tools === undefined || agent.roleSnapshot.tools.includes("subagent")) &&
      !agent.roleSnapshot.disallowedTools?.includes("subagent");
    if (!(await this.resolveTrust(cwd)))
      throw new SubagentError("PROJECT_NOT_TRUSTED", `Project is not trusted: ${cwd}`);
    this.assertCurrent(execution);
    let delegationContext: CallerBinding["delegation"] | undefined;
    if (canDelegate) {
      const projectRoot = await findProjectRoot(cwd);
      if (!(await this.resolveTrust(projectRoot)))
        throw new SubagentError(
          "PROJECT_NOT_TRUSTED",
          `Git project root is not trusted: ${projectRoot}`,
        );
      delegationContext = (await buildDelegationContext(cwd, this.agentDir)).context;
      this.assertCurrent(execution);
    }
    if (!restoring && !ctx.model)
      throw new SubagentError("PARENT_MODEL_UNAVAILABLE", "Caller has no active model");
    const opened = await this.childFactory.open({
      name: agent.name,
      roleSnapshot: agent.roleSnapshot,
      cwd,
      depth,
      ancestorCwds: [...caller.ancestorCwds, cwd],
      runtime: this,
      callerAgent: agent,
      delegationContext,
      canDelegate,
      sessionManager: manager,
      restoring,
      ...(!restoring
        ? {
            model: ctx.model,
            thinking:
              thinking ??
              agent.roleSnapshot.thinking ??
              (ctx.thinkingLevel as ThinkingLevel) ??
              "off",
          }
        : {}),
    });
    if (!this.current(execution)) {
      await opened.dispose();
      throw new SubagentError("ROOT_CLOSING", "The owning execution ended while mounting");
    }
    execution.opened = opened;
    execution.session = opened.session;
    execution.startLeafId = manager.getLeafId();
    execution.unsubscribe = opened.session.subscribe((event) => this.onEvent(execution, event));
  }
  private start(
    execution: Execution,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AcceptedResult> {
    this.assertCurrent(execution);
    return new Promise<AcceptedResult>((resolve, reject) => {
      let finished = false;
      const finish = (result?: AcceptedResult, error?: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => {
        if (execution.accepted) return;
        finish(
          undefined,
          new SubagentError("ABORTED", "Tool call was aborted before Pi accepted the prompt"),
        );
        void execution.session?.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.holdPrompt(execution);
      const completion = execution.session!.prompt(prompt, {
        expandPromptTemplates: false,
        preflightResult: (disposition) => {
          if (!this.current(execution)) {
            const error = new SubagentError(
              "ROOT_CLOSING",
              "Owning execution ended before acceptance",
            );
            finish(undefined, error);
            throw error;
          }
          if (signal?.aborted && !execution.accepted) {
            const error = new SubagentError(
              "ABORTED",
              "Tool call was aborted before Pi accepted the prompt",
            );
            finish(undefined, error);
            throw error;
          }
          if (disposition === "handled") {
            finish(
              undefined,
              new SubagentError(
                "PROMPT_HANDLED",
                "An input extension handled the request; no subagent task was started.",
              ),
            );
            return;
          }
          execution.accepted = true;
          if (disposition !== "started") {
            const error = new SubagentError(
              "UNEXPECTED_PREFLIGHT",
              `Expected started but SDK returned ${disposition}; history and identity are retained.`,
            );
            finish(undefined, error);
            void this.failExecution(execution, error);
            throw error;
          }
          execution.phase = "executing";
          execution.agent.state = "running";
          try {
            this.saveAgentSync(execution.agent);
            finish(this.acceptedResult(execution, "started"));
          } catch (error) {
            finish(undefined, error);
            // Throwing out of SDK preflight prevents the subsequent _runAgentPrompt call.
            // The started disposition still retains identity/history rather than rollback.
            throw error;
          }
        },
      });
      void completion.then(
        () => {
          this.releasePrompt(execution);
          if (!finished)
            finish(
              undefined,
              new SubagentError("PROMPT_NOT_STARTED", "SDK returned without confirming acceptance"),
            );
          if (this.current(execution) && execution.accepted) {
            execution.sdkSettled = execution.session!.isIdle;
            this.maybeFinalize(execution);
          }
        },
        (error) => {
          this.releasePrompt(execution);
          finish(undefined, error);
          if (execution.accepted && this.current(execution))
            void this.failExecution(execution, error);
        },
      );
    });
  }
  private async steer(agent: Agent, prompt: string, signal?: AbortSignal): Promise<AcceptedResult> {
    const execution = agent.currentExecution;
    let reason: string | undefined;
    if (!execution) {
      reason =
        agent.state === "idle" || agent.state === "interrupted"
          ? `is ${agent.state} with no current execution`
          : "has no current execution; its active instance has been released";
    } else if (this.scope !== execution.scope) {
      reason = "has an owning root scope that is no longer active";
    } else if (execution.scope.closing) {
      reason = "belongs to a root session that is closing";
    } else if (execution.phase === "closed") {
      reason = "has a closed execution; its active instance has been released";
    } else if (execution.finalizing || execution.phase === "closing") {
      reason = execution.finalizing ? "is finalizing its execution" : "is closing its execution";
    } else if (execution.phase === "opening") {
      reason = "is opening; its SDK execution has not yet started";
    } else if (execution.phase === "waiting") {
      const dependencies = [
        ...(execution.pendingChildren.size ? ["children"] : []),
        ...(execution.pendingReports.size ? ["reports to be processed"] : []),
      ];
      reason = `is waiting for ${dependencies.length ? dependencies.join(" and ") : "the SDK to become idle"}`;
    } else if (!execution.session) {
      reason = "has no mounted SDK session; its session has been released";
    } else if (!execution.session.isStreaming) {
      reason = execution.sdkSettled
        ? "has an SDK execution that has settled and is not streaming"
        : "has an SDK execution that is currently not streaming";
    }
    if (reason || !execution)
      throw new SubagentError("SUBAGENT_NOT_STEERABLE", `${agent.name} ${reason}.`);
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let answered = false;
      const completion = execution.session!.prompt(prompt, {
        streamingBehavior: "steer",
        expandPromptTemplates: false,
        preflightResult: (disposition) => {
          answered = true;
          if (!this.current(execution)) {
            const error = new SubagentError("ROOT_CLOSING", "The target execution ended");
            reject(error);
            // The hook may outlive E1 and its disposed mount. Stop SDK started processing,
            // never abort the logical agent's new E2; already queued effects cannot be undone.
            throw error;
          }
          if (disposition !== "queued" && signal?.aborted) {
            const error = new SubagentError(
              "ABORTED",
              "Tool call was aborted before Pi accepted steering",
            );
            reject(error);
            throw error;
          }
          // SDK queues before this callback: queued is already accepted even if the tool
          // was canceled during an input hook. Do not claim to undo the accepted queue.
          if (disposition === "queued") resolve(this.acceptedResult(execution, "steered"));
          else if (disposition === "handled")
            reject(
              new SubagentError(
                "PROMPT_HANDLED",
                "An input extension handled the steering input; the original execution is unchanged.",
              ),
            );
          else {
            const error = new SubagentError(
              "UNEXPECTED_PREFLIGHT",
              `Expected queued steering but SDK returned ${disposition}.`,
            );
            reject(error);
            void this.failExecution(execution, error);
            // Started preflight precedes _runAgentPrompt; throwing prevents a second run.
            throw error;
          }
        },
      });
      void completion.then(() => {
        if (!answered)
          reject(new SubagentError("PROMPT_NOT_STARTED", "SDK did not queue steering input"));
      }, reject);
    });
  }
  private onEvent(execution: Execution, event: AgentSessionEvent): void {
    if (!this.current(execution)) return;
    applyProgressEvent(execution.progress, event);
    this.refreshProgress();
    if (event.type === "agent_start") {
      execution.sdkSettled = false;
      execution.phase = "executing";
    }
    if (
      event.type === "message_end" &&
      event.message.role === "custom" &&
      event.message.customType === "subagent-report"
    ) {
      for (const delivery of execution.pendingReports) {
        if (
          delivery.submitted &&
          !delivery.observed &&
          correlation(event.message.details, delivery)
        ) {
          delivery.observed = true;
          break;
        }
      }
    }
    if (event.type === "agent_settled") {
      execution.sdkSettled = true;
      // SDK public message_end precedes persistence. Only a later settled with the entry on
      // the active Pi branch acknowledges processing; a send Promise is never an acknowledgment.
      const branch = execution.session!.sessionManager.getBranch();
      const usedReceipts = execution.reportReceipts ?? new Set<string>();
      execution.reportReceipts = usedReceipts;
      for (const delivery of execution.pendingReports) {
        if (!delivery.observed) continue;
        const boundary = delivery.receiptBoundary
          ? branch.findIndex((entry) => entry.id === delivery.receiptBoundary)
          : -1;
        if (delivery.receiptBoundary && boundary < 0) continue;
        const entry = branch
          .slice(boundary + 1)
          .find(
            (value) =>
              value.type === "custom_message" &&
              value.customType === "subagent-report" &&
              !usedReceipts.has(value.id) &&
              correlation(value.details, delivery),
          );
        if (!entry) continue;
        usedReceipts.add(entry.id);
        delivery.recordedEntryId = entry.id;
        delivery.processed = true;
        execution.pendingReports.delete(delivery);
        execution.scope.deliveries.delete(delivery);
      }
      this.maybeFinalize(execution);
    }
  }
  private holdPrompt(execution: Execution): void {
    this.pendingPrompts.set(execution, (this.pendingPrompts.get(execution) ?? 0) + 1);
  }
  private releasePrompt(execution: Execution): void {
    const remaining = (this.pendingPrompts.get(execution) ?? 1) - 1;
    if (remaining) this.pendingPrompts.set(execution, remaining);
    else this.pendingPrompts.delete(execution);
  }
  private maybeFinalize(execution: Execution): void {
    if (
      !this.current(execution) ||
      !execution.accepted ||
      execution.finalizing ||
      !execution.sdkSettled
    )
      return;
    if (
      execution.pendingChildren.size ||
      execution.pendingReports.size ||
      !execution.session?.isIdle
    ) {
      execution.phase = "waiting";
      return;
    }
    // _runAgentPrompt emits settled from finally, before prompt's rejection is observable.
    // Do not extract a result until the accepted prompt's completion outcome is captured.
    if (this.pendingPrompts.has(execution)) return;
    execution.finalizing = true;
    execution.phase = "closing";
    // Do not dispose inside the SDK's awaited lifecycle callback.
    queueMicrotask(() => {
      void this.finalize(execution).catch((error) => this.notify(error));
    });
  }
  private result(execution: Execution): SubagentReport {
    const agent = execution.agent;
    const report: SubagentReport = {
      name: agent.name,
      agentType: agent.roleSnapshot.id,
      cwd: agent.cwd!,
      outcome: "incomplete",
      result: "No final assistant text was produced for this task.",
    };
    const branch = execution.session!.sessionManager.getBranch();
    const index = execution.startLeafId
      ? branch.findIndex((entry) => entry.id === execution.startLeafId)
      : -1;
    if (execution.startLeafId && index < 0) {
      report.outcome = "failed";
      report.result = "";
      report.error = {
        code: "SESSION_HISTORY_UNAVAILABLE",
        message:
          "The task's history boundary is absent from the current branch; no earlier result was reused.",
      };
      return report;
    }
    const entries = branch.slice(index + 1);
    execution.sourceEntryId =
      entries.find((entry) => entry.type === "message" && entry.message.role === "user")?.id ??
      execution.startLeafId ??
      undefined;
    if (execution.failure) {
      report.outcome = "failed";
      report.error = execution.failure;
      report.result = "";
      return report;
    }
    const last = [...entries]
      .reverse()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (last?.type === "message" && last.message.role === "assistant") {
      const message = last.message;
      report.result = message.content
        .filter((value) => value.type === "text")
        .map((value) => value.text)
        .join("\n");
      report.outcome =
        message.stopReason === "error"
          ? "failed"
          : message.stopReason === "aborted"
            ? "aborted"
            : message.stopReason === "length"
              ? "incomplete"
              : "completed";
      if (message.errorMessage)
        report.error = { code: "MODEL_ERROR", message: message.errorMessage };
      if (!report.result && report.outcome === "completed") {
        report.outcome = "incomplete";
        report.result =
          "The final response contains no text; inspect the complete conversation for non-text content.";
      }
    }
    return report;
  }
  private async finalize(execution: Execution): Promise<void> {
    if (!this.current(execution)) return;
    const report = this.result(execution);
    const mountedManager = execution.session?.sessionManager;
    const mountedHistory = mountedManager
      ? {
          sessionId: mountedManager.getSessionId(),
          sessionFile: mountedManager.getSessionFile(),
          cwd: mountedManager.getCwd(),
        }
      : undefined;
    const target = execution.parent;
    const delivery: ReportDelivery = {
      source: execution,
      target,
      report,
      sourceEntryId: execution.sourceEntryId,
      submitted: false,
      observed: false,
      processed: false,
    };
    execution.scope.deliveries.add(delivery);
    if ("agent" in target) {
      // Transfer the dependency before the first await: never expose an empty barrier window.
      target.pendingReports.add(delivery);
      target.pendingChildren.delete(execution);
    }
    execution.agent.state = "idle";
    try {
      await this.saveAgent(execution.agent);
    } catch (error) {
      const failure = asSubagentError(error, "STORE_ERROR");
      report.outcome = "failed";
      report.error = { code: failure.code, message: failure.message };
      this.notify(error);
    }
    await this.releaseExecution(execution);
    if (!this.deliveryCurrent(delivery)) {
      execution.scope.deliveries.delete(delivery);
      return;
    }
    try {
      const manager = await this.childFactory.openSessionManager(identity(execution.agent));
      const file = manager.getSessionFile();
      if (
        file &&
        mountedHistory?.sessionFile &&
        mountedHistory.sessionId === identity(execution.agent).sessionId &&
        mountedHistory.cwd === execution.agent.cwd &&
        manager.getCwd() === execution.agent.cwd &&
        (await realpath(mountedHistory.sessionFile)) === file
      ) {
        report.sessionFile = file;
      }
    } catch {
      /* Unavailable history is explicitly represented by the report formatter. */
    }
    if (!this.deliveryCurrent(delivery)) {
      execution.scope.deliveries.delete(delivery);
      return;
    }
    execution.reportSubmitted = true;
    delivery.submitted = true;
    const status = this.statusFor(execution.agent.parent);
    if (!("agent" in target)) {
      this.host.sendReport(report, status);
      delivery.processed = true;
      execution.scope.deliveries.delete(delivery);
      return;
    }
    if (!delivery.sourceEntryId) {
      target.pendingReports.delete(delivery);
      execution.scope.deliveries.delete(delivery);
      await this.failExecution(
        target,
        new SubagentError(
          "SESSION_HISTORY_UNAVAILABLE",
          "The child task has no persisted Pi entry identity for report processing.",
        ),
      );
      return;
    }
    delivery.receiptBoundary = target.session!.sessionManager.getLeafId();
    target.sdkSettled = false;
    target.phase = "executing";
    this.holdPrompt(target);
    void target
      .session!.sendCustomMessage(
        {
          customType: "subagent-report",
          content: formatSubagentReport(report, status),
          display: true,
          details: {
            ...report,
            delegation_status: status,
            sourceSessionId: identity(execution.agent).sessionId,
            sourceEntryId: delivery.sourceEntryId,
          },
        },
        { deliverAs: "steer", triggerTurn: true },
      )
      .then(
        () => {
          this.releasePrompt(target);
          this.maybeFinalize(target);
        },
        (error) => {
          this.releasePrompt(target);
          // A receipt may already have removed delivery at settled, but the same owning
          // execution still needs the subsequent SDK completion failure before finalizing.
          if (this.current(target)) void this.failExecution(target, error);
        },
      );
  }
  private deliveryCurrent(delivery: ReportDelivery): boolean {
    const scope = delivery.source.scope;
    return (
      this.scope === scope &&
      !scope.closing &&
      scope.deliveries.has(delivery) &&
      (!("agent" in delivery.target) ||
        (this.current(delivery.target) && !delivery.target.finalizing))
    );
  }
  private async failExecution(execution: Execution, error: unknown): Promise<void> {
    if (!this.current(execution) || execution.finalizing) return;
    const failure = asSubagentError(error);
    execution.failure = { code: failure.code, message: failure.message };
    await Promise.all([...execution.pendingChildren].map((child) => this.interrupt(child)));
    for (const delivery of execution.pendingReports) execution.scope.deliveries.delete(delivery);
    execution.pendingReports.clear();
    await execution.session?.abort().catch((abortError) => this.notify(abortError));
    if (!this.current(execution)) return;
    execution.sdkSettled = true;
    this.maybeFinalize(execution);
  }
  private releaseExecution(execution: Execution): Promise<void> {
    execution.release ??= this.releaseResources(execution);
    return execution.release;
  }
  private async releaseResources(execution: Execution): Promise<void> {
    execution.unsubscribe?.();
    execution.unsubscribe = undefined;
    try {
      await execution.opened?.dispose();
    } catch (error) {
      this.notify(error);
    }
    execution.opened = undefined;
    execution.session = undefined;
    execution.reportReceipts?.clear();
    execution.phase = "closed";
    if (execution.agent.currentExecution === execution)
      execution.agent.currentExecution = undefined;
    execution.scope.executions.delete(execution);
    this.refreshProgress();
  }
  private async rollback(
    execution: Execution,
    newAgent: boolean,
    previousState: ChildState,
    createdFile?: string,
  ): Promise<void> {
    if (execution.accepted) return;
    const agent = execution.agent;
    if ("agent" in execution.parent) execution.parent.pendingChildren.delete(execution);
    agent.state = previousState;
    try {
      if (agent.identity) {
        if (newAgent)
          await this.store.removeChild(this.owner(agent), this.ownerParent(agent), agent.name);
        else await this.saveAgent(agent);
      }
    } catch (error) {
      this.notify(error);
    }
    if (newAgent) {
      (agent.parent?.children ?? execution.scope.children).delete(agent.name);
      execution.scope.agents.delete(agent);
      if (createdFile) await rm(createdFile, { force: true }).catch((error) => this.notify(error));
    }
    await this.releaseExecution(execution);
    if ("agent" in execution.parent) this.maybeFinalize(execution.parent);
  }
  private owner(agent: Agent): SessionIdentity {
    return agent.parent ? identity(agent.parent) : this.scope!.identity;
  }
  private ownerParent(agent: Agent): SessionIdentity | null {
    return agent.parent
      ? agent.parent.parent
        ? identity(agent.parent.parent)
        : this.scope!.identity
      : null;
  }
  private ensureBranch(agent: Agent): Promise<void> {
    const pending = this.branchInitializations.get(agent);
    if (pending) return pending;
    if (agent.hasChildren) return Promise.resolve();
    const initialize = (async () => {
      // Each publication is independently durable: empty owner, marker, then children.
      // Siblings share this promise so no opening record can overtake the marker commit.
      await this.store.ensureOwner(identity(agent), this.owner(agent));
      await this.store.markHasChildren(this.owner(agent), this.ownerParent(agent), agent.name);
      agent.hasChildren = true;
    })();
    this.branchInitializations.set(agent, initialize);
    void initialize.then(
      () => this.branchInitializations.delete(agent),
      () => this.branchInitializations.delete(agent),
    );
    return initialize;
  }
  private saveAgent(agent: Agent): Promise<void> {
    return this.store.setChild(
      this.owner(agent),
      this.ownerParent(agent),
      agent.name,
      childRecord(agent),
    );
  }
  private saveAgentSync(agent: Agent): void {
    this.store.setChildSync(
      this.owner(agent),
      this.ownerParent(agent),
      agent.name,
      childRecord(agent),
    );
  }
  private acceptedResult(execution: Execution, status: "started" | "steered"): AcceptedResult {
    return {
      ok: true,
      name: execution.agent.name,
      agent_type: execution.agent.roleSnapshot.id,
      cwd: execution.agent.cwd!,
      thinking: execution.opened!.actualThinking,
      status,
      delegation_status: this.statusFor(execution.agent.parent),
    };
  }
  private statusFor(parent: Agent | null) {
    const children = [...(parent?.children ?? this.scope!.children).values()];
    const direct = children.map((agent) => ({
      name: agent.name,
      agentType: agent.roleSnapshot.id,
      state: agent.currentExecution
        ? ("running" as const)
        : agent.state === "interrupted"
          ? ("interrupted" as const)
          : ("done" as const),
    }));
    return createDelegationStatusSnapshot(
      direct.filter((agent) => agent.state === "running"),
      this.scope!.executions.size,
      this.rootConfig.maxLiveAgents,
      direct,
    );
  }
  private refreshProgress(): void {
    if (!this.scope || !this.host?.ctx.hasUI) return;
    try {
      const lines =
        this.scope.closing || !this.scope.executions.size
          ? undefined
          : buildProgressWidgetLines(
              [...this.scope.executions].map((execution) => ({
                name: execution.agent.name,
                progress: execution.progress,
              })),
            );
      this.host.ctx.ui.setWidget("pi-subagents:progress", lines);
    } catch (error) {
      this.notify(error);
    }
  }
  private async resolveTrust(cwd: string): Promise<boolean> {
    const known = this.trustDecisions.get(cwd);
    if (known !== undefined) return known;
    const saved = new ProjectTrustStore(this.agentDir).get(cwd);
    if (saved !== null) {
      this.trustDecisions.set(cwd, saved);
      return saved;
    }
    const policy = SettingsManager.create(cwd, this.agentDir, {
      projectTrusted: false,
    }).getDefaultProjectTrust();
    if (policy === "always") {
      this.trustDecisions.set(cwd, true);
      return true;
    }
    if (policy === "never" || !this.host.ctx.hasUI) {
      this.trustDecisions.set(cwd, false);
      return false;
    }
    const trusted = await this.uiBroker.enqueue(`trust:${cwd}`, false, undefined, (options) =>
      this.host.ctx.ui.confirm(
        "Trust external project?",
        `Allow this subagent to load project configuration and resources for ${cwd}?`,
        options,
      ),
    );
    this.trustDecisions.set(cwd, trusted);
    return trusted;
  }
  private notify(error: unknown): void {
    const failure = asSubagentError(error, "STORE_ERROR");
    try {
      this.host?.ctx.ui.notify(`pi-subagents: ${failure.code}: ${failure.message}`, "error");
    } catch {
      /* Diagnostic UI cannot prevent cleanup. */
    }
  }
  private abortExecution(execution: Execution): Promise<void> {
    let abort = this.abortTasks.get(execution);
    if (!abort) {
      abort = execution.session?.abort().catch((error) => this.notify(error)) ?? Promise.resolve();
      this.abortTasks.set(execution, abort);
    }
    return abort;
  }
  private async interrupt(execution: Execution, descendants = true): Promise<void> {
    // Signal this mount and descendants before waiting for any one abort to settle.
    const abort = this.abortExecution(execution);
    await Promise.all([
      abort,
      ...(descendants ? [...execution.pendingChildren].map((child) => this.interrupt(child)) : []),
    ]);
    execution.agent.state = execution.finalizing
      ? "idle"
      : execution.accepted
        ? "interrupted"
        : "idle";
    if (execution.agent.identity)
      await this.saveAgent(execution.agent).catch((error) => this.notify(error));
    if ("agent" in execution.parent) execution.parent.pendingChildren.delete(execution);
    await this.releaseExecution(execution);
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const scope = this.scope;
    if (!scope) return Promise.resolve();
    scope.closing = true;
    this.uiBroker.shutdown();
    this.refreshProgress();
    // A suspended opening must not postpone cancellation of accepted siblings. Mounted
    // openings get an abort signal too, but their task owns rollback/disposal until it returns.
    for (const execution of scope.executions)
      if (execution.session) void this.abortExecution(execution);
    const acceptedCleanup = Promise.all(
      [...scope.executions]
        .filter((execution) => execution.accepted)
        .map((execution) => this.interrupt(execution, false)),
    );
    this.shutdownPromise = (async () => {
      await this.initialization?.catch((error) => this.notify(error));
      await Promise.all([acceptedCleanup, Promise.allSettled([...(scope.openingTasks ?? [])])]);
      await Promise.all(
        [...scope.executions]
          .filter((execution) => execution.agent.currentExecution === execution)
          .map((execution) => this.interrupt(execution, false)),
      );
      scope.deliveries.clear();
      await this.store.close();
    })();
    return this.shutdownPromise;
  }
}
