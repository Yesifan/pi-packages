import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionContext,
  type PromptOptions,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach } from "vitest";
import type {
  ChildSessionFactory,
  OpenChildOptions,
  OpenedChild,
} from "../../src/child-session.js";
import { RootRuntime } from "../../src/runtime.js";
import type { PersistentSubagentStore } from "../../src/store.js";
import type {
  Agent,
  AgentDefinitionSnapshot,
  CallerBinding,
  DelegationStatusSnapshot,
  Execution,
  RootScope,
  SubagentReport,
  ThinkingLevel,
} from "../../src/types.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function role(policy: Partial<AgentDefinitionSnapshot> = {}): AgentDefinitionSnapshot {
  return {
    id: "general",
    description: "General",
    prompt: "Do the task.",
    source: "/agents/general.md",
    contentHash: "hash",
    ...policy,
  };
}
export function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "original",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}
type Custom = Parameters<AgentSession["sendCustomMessage"]>[0];
type Disposition = "started" | "queued" | "handled";
export class FakeChild {
  readonly session: AgentSession;
  readonly completion = deferred();
  readonly disposed = deferred();
  readonly customMessages: Custom[] = [];
  readonly promptCalls: Array<{ text: string; options: PromptOptions }> = [];
  private readonly customWaiters = new Map<number, ReturnType<typeof deferred<Custom>>>();
  listener?: (event: AgentSessionEvent) => void;
  capturedListener?: (event: AgentSessionEvent) => void;
  streaming = false;
  idle = true;
  aborts = 0;
  disposals = 0;
  nextDisposition?: Disposition;
  promptError?: Error;
  afterPreflight?: () => void;
  model: Model<Api>;
  thinking: ThinkingLevel;
  constructor(readonly options: OpenChildOptions) {
    const context = options.sessionManager.buildSessionContext();
    this.model =
      options.model ??
      ({ provider: context.model?.provider, id: context.model?.modelId } as Model<Api>);
    this.thinking = options.thinking ?? (context.thinkingLevel as ThinkingLevel);
    if (!options.restoring) {
      options.sessionManager.appendModelChange(this.model.provider, this.model.id);
      options.sessionManager.appendThinkingLevelChange(this.thinking);
    }
    const child = this;
    this.session = {
      sessionManager: options.sessionManager,
      get model() {
        return child.model;
      },
      get thinkingLevel() {
        return child.thinking;
      },
      get isStreaming() {
        return child.streaming;
      },
      get isIdle() {
        return child.idle;
      },
      prompt: (text: string, options: PromptOptions = {}) => {
        child.promptCalls.push({ text, options });
        if (child.promptError) return Promise.reject(child.promptError);
        const disposition =
          child.nextDisposition ?? (options.streamingBehavior === "steer" ? "queued" : "started");
        child.nextDisposition = undefined;
        if (disposition !== "handled") {
          if (!options.streamingBehavior)
            child.manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
          child.streaming = true;
          child.idle = false;
        }
        try {
          options.preflightResult?.(disposition);
          child.afterPreflight?.();
        } catch (error) {
          // SDK prompt is async: a thrown preflight rejects its completion promise.
          return Promise.reject(error);
        }
        if (options.streamingBehavior || disposition === "handled") return Promise.resolve();
        return child.completion.promise;
      },
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        child.listener = listener;
        child.capturedListener = listener;
        return () => {
          child.listener = undefined;
        };
      },
      sendCustomMessage: async (message: Custom) => {
        // Receiving/queueing is deliberately NOT a processing acknowledgment.
        const clone = structuredClone(message);
        const index = child.customMessages.push(clone) - 1;
        child.customWaiters.get(index)?.resolve(clone);
      },
      abort: async () => {
        child.aborts++;
        child.streaming = false;
        child.idle = true;
        child.completion.resolve();
      },
      dispose: () => undefined,
    } as unknown as AgentSession;
  }
  get manager() {
    return this.options.sessionManager;
  }
  emit(event: AgentSessionEvent) {
    this.listener?.(event);
  }
  complete(text = "done", stopReason: AssistantMessage["stopReason"] = "stop") {
    this.manager.appendMessage(assistant(text, stopReason));
    this.streaming = false;
    this.idle = true;
    this.emit({ type: "agent_settled" });
    this.completion.resolve();
  }
  fail(error: Error) {
    this.streaming = false;
    this.idle = true;
    this.completion.reject(error);
  }
  async waitCustom(index = 0): Promise<Custom> {
    if (this.customMessages[index]) return this.customMessages[index]!;
    const waiter = this.customWaiters.get(index) ?? deferred<Custom>();
    this.customWaiters.set(index, waiter);
    return waiter.promise;
  }
  observeCustom(index: number) {
    const message = this.customMessages[index]!;
    this.idle = false;
    this.emit({ type: "agent_start" });
    this.emit({
      type: "message_end",
      message: { role: "custom", ...structuredClone(message), timestamp: Date.now() },
    });
  }
  persistCustom(index: number) {
    const message = this.customMessages[index]!;
    return this.manager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      structuredClone(message.details),
    );
  }
  settle() {
    this.streaming = false;
    this.idle = true;
    this.emit({ type: "agent_settled" });
    // Like SDK _runAgentPrompt's finally, the public event precedes prompt completion.
    this.completion.resolve();
  }
}

const directories: string[] = [];
const runtimes: RootRuntime[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
export async function privateManager(cwd: string) {
  const allocated = SessionManager.create(cwd);
  const file = allocated.getSessionFile()!;
  await writeFile(file, "", { flag: "wx", mode: 0o600 });
  return SessionManager.open(file, path.dirname(file), cwd);
}
export async function createHarness(
  settings: {
    maxLiveAgents?: number;
    maxDepth?: number;
    hasUI?: boolean;
    realTrust?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-runtime-"));
  directories.push(root);
  const cwd = path.join(root, "project");
  const external = path.join(root, "external");
  const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(external), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const rootManager = await privateManager(cwd);
  const widgets: Array<string[] | undefined> = [];
  const notifications: string[] = [];
  const reports: Array<{ report: SubagentReport; status: DelegationStatusSnapshot }> = [];
  const reportWaiters = new Map<number, ReturnType<typeof deferred<void>>>();
  const ctx = {
    cwd,
    hasUI: settings.hasUI ?? false,
    isProjectTrusted: () => true,
    model: { provider: "test", id: "original", name: "Original" } as Model<Api>,
    thinkingLevel: "high",
    ui: {
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;
  const host = {
    rootSessionId: rootManager.getSessionId(),
    rootSessionFile: rootManager.getSessionFile()!,
    ctx,
    sendReport: (report: SubagentReport, status: DelegationStatusSnapshot) => {
      const index = reports.push({ report, status }) - 1;
      reportWaiters.get(index)?.resolve();
    },
  };
  const config = {
    externalDirectories: [external],
    maxDepth: settings.maxDepth ?? 4,
    maxLiveAgents: settings.maxLiveAgents ?? 8,
    uiTimeoutMs: 100,
    projectRoot: cwd,
  };
  const runtime = new RootRuntime(path.join(root, "extension.js"));
  runtimes.push(runtime);
  await runtime.initialize(host, config);
  const actualFactory = Reflect.get(runtime, "childFactory") as ChildSessionFactory;
  const mounts: OpenChildOptions[] = [];
  const children: FakeChild[] = [];
  let failOpen = false;
  let configureNext: ((child: FakeChild) => void) | undefined;
  const factory = {
    createSessionManager: actualFactory.createSessionManager.bind(actualFactory),
    openSessionManager: actualFactory.openSessionManager.bind(actualFactory),
    open: async (options: OpenChildOptions): Promise<OpenedChild> => {
      mounts.push(options);
      if (failOpen) {
        failOpen = false;
        throw new Error("open failed");
      }
      const child = new FakeChild(options);
      children.push(child);
      configureNext?.(child);
      configureNext = undefined;
      return {
        session: child.session,
        actualThinking: child.thinking,
        ui: {} as OpenedChild["ui"],
        dispose: async () => {
          child.disposals++;
          child.streaming = false;
          child.idle = true;
          child.disposed.resolve();
        },
      };
    },
  };
  Reflect.set(runtime, "childFactory", factory);
  if (!settings.realTrust) Reflect.set(runtime, "resolveTrust", async () => true);
  // Track actual background work, not timing/polling: flush awaits event-initiated failures
  // as well as finalization (abort completion can introduce additional promise turns).
  const finalizations = new Set<Promise<void>>();
  for (const method of ["finalize", "failExecution"]) {
    const original = Reflect.get(runtime, method) as (
      execution: Execution,
      error?: unknown,
    ) => Promise<void>;
    Reflect.set(runtime, method, (execution: Execution, error?: unknown) => {
      const promise = original.call(runtime, execution, error);
      finalizations.add(promise);
      void promise.then(
        () => finalizations.delete(promise),
        () => finalizations.delete(promise),
      );
      return promise;
    });
  }
  const caller: CallerBinding = {
    agent: null,
    depth: 0,
    ancestorCwds: [cwd],
    delegation: {
      cwd,
      projectRoot: cwd,
      externalDirectories: [external],
      agentTypes: new Map([
        ["general", role()],
        ["explore", role({ id: "explore" })],
      ]),
    },
  };
  const scope = Reflect.get(runtime, "scope") as RootScope;
  const store = Reflect.get(runtime, "store") as PersistentSubagentStore;
  const h = {
    root,
    cwd,
    external,
    agentDir,
    rootManager,
    runtime,
    host,
    config,
    ctx,
    caller,
    scope,
    store,
    factory,
    mounts,
    children,
    reports,
    widgets,
    notifications,
    agent: (name: string, parent?: Agent) => (parent?.children ?? scope.children).get(name)!,
    child: (name: string, parent?: Agent) => {
      const agent = (parent?.children ?? scope.children).get(name)!;
      return children.findLast((child) => child.options.callerAgent === agent)!;
    },
    nestedCaller: (name: string): CallerBinding => {
      const agent = scope.children.get(name)!;
      return {
        agent,
        execution: agent.currentExecution,
        depth: 1,
        ancestorCwds: [cwd, agent.cwd!],
        delegation: {
          cwd: agent.cwd!,
          projectRoot: agent.cwd!,
          externalDirectories: [cwd],
          agentTypes: new Map([["general", role()]]),
        },
      };
    },
    failNextOpen: () => {
      failOpen = true;
    },
    configureNext: (configure: (child: FakeChild) => void) => {
      configureNext = configure;
    },
    flush: async () => {
      await Promise.resolve();
      await Promise.resolve();
      while (finalizations.size) await Promise.all([...finalizations]);
    },
    waitReport: async (index = 0) => {
      if (reports[index]) return;
      const waiter = reportWaiters.get(index) ?? deferred();
      reportWaiters.set(index, waiter);
      await waiter.promise;
    },
    restart: async () => {
      await runtime.shutdown();
      const replacement = new RootRuntime(path.join(root, "extension.js"));
      runtimes.push(replacement);
      await replacement.initialize(host, config);
      return replacement;
    },
  };
  return h;
}
export type RuntimeHarness = Awaited<ReturnType<typeof createHarness>>;
