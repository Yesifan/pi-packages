import { realpathSync } from "node:fs";
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describeSessionResult } from "./result.js";
import { findSession, type SessionTarget } from "./sessions.js";

export type TaskSession = Pick<
  AgentSession,
  "abort" | "prompt" | "steer" | "subscribe" | "sessionManager" | "isStreaming"
> & { dispose: () => void | Promise<void> };
export interface TaskReport extends SessionTarget {
  status: "completed" | "failed";
  text: string;
}
export interface AskRequest {
  id: string;
  cwd: string;
  prompt: string;
  steer?: boolean;
  callerId?: string;
}
export interface TaskDependencies {
  find: typeof findSession;
  load: (target: SessionTarget) => Promise<TaskSession>;
  onReportError: (error: unknown) => void;
}

async function loadSession(target: SessionTarget): Promise<TaskSession> {
  if (realpathSync(target.path) !== target.path) {
    throw new Error("Session path no longer matches the authorized target");
  }
  const sessionManager = SessionManager.open(target.path);
  const openedPath = sessionManager.getSessionFile();
  if (
    sessionManager.getSessionId() !== target.id ||
    !openedPath ||
    realpathSync(openedPath) !== target.path ||
    realpathSync(sessionManager.getCwd()) !== target.cwd
  ) {
    throw new Error("Opened session identity or cwd does not match the authorized target");
  }
  const { session } = await createAgentSession({ cwd: target.cwd, sessionManager });
  const dispose = async () => {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  };
  try {
    // Headless defaults intentionally use the target project's resources, not caller overrides.
    await session.bindExtensions({ mode: "print" });
    return {
      abort: () => session.abort(),
      prompt: (text, options) => session.prompt(text, options),
      steer: (text, images, options) => session.steer(text, images, options),
      subscribe: (listener) => session.subscribe(listener),
      sessionManager,
      get isStreaming() {
        return session.isStreaming;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

type ActiveTask = {
  target: SessionTarget;
  session?: TaskSession;
  loading?: Promise<TaskSession>;
  cleanup?: Promise<void>;
  pending: Set<Promise<unknown>>;
  unsubscribe?: () => void;
};

/** One runtime per caller lifecycle. No idle cache, external locks, or restart recovery. */
export class SessionTasks {
  private readonly active = new Map<string, ActiveTask>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly deps: TaskDependencies;

  constructor(deps: Partial<TaskDependencies> = {}) {
    this.deps = {
      find: findSession,
      load: loadSession,
      onReportError: (error) => console.error("pi-session report failed", error),
      ...deps,
    };
  }

  /** cwd must already be authorized with resolveCwd. Acceptance does not await model work. */
  async ask(
    request: AskRequest,
    report: (result: TaskReport) => void | Promise<void>,
  ): Promise<{ status: "accepted" | "steered" | "handled"; id: string; path: string }> {
    if (this.closed) throw new Error("Session tasks are closed");
    if (request.id === request.callerId) throw new Error("Cannot ask the current caller session");
    if (!request.prompt.trim()) throw new Error("Prompt must not be empty");
    const target = this.deps.find(request.cwd, request.id);
    const existing = this.active.get(request.id);
    if (request.steer) {
      if (!existing || existing.target.path !== target.path || existing.cleanup)
        throw new Error("No active task for this session");
      if (!existing.session) throw new Error("Session is still loading; cannot steer yet");
      if (!existing.session.isStreaming) throw new Error("Session is not streaming; cannot steer");
      const session = existing.session;
      const result = await this.track(existing, () =>
        session.steer(request.prompt, undefined, { source: "extension" }),
      );
      if (
        result === "queued" &&
        (this.closed ||
          this.active.get(request.id) !== existing ||
          existing.cleanup ||
          existing.session !== session ||
          !session.isStreaming)
      ) {
        throw new Error("Session stopped before steering could be confirmed");
      }
      return {
        status: result === "handled" ? "handled" : "steered",
        id: target.id,
        path: target.path,
      };
    }
    if (existing) throw new Error("Session is busy");
    const task: ActiveTask = { target, pending: new Set() };
    this.active.set(target.id, task);
    void this.run(task, request.prompt, report);
    return { status: "accepted", id: target.id, path: target.path };
  }

  private async run(
    task: ActiveTask,
    prompt: string,
    report: (result: TaskReport) => void | Promise<void>,
  ): Promise<void> {
    let result: TaskReport;
    try {
      task.loading = this.deps.load(task.target);
      const session = await task.loading;
      task.session = session;
      if (this.closed) return;
      task.unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_start" && task.cleanup) {
          // An input hook may resume after an earlier abort observed an idle session.
          void this.abort(session);
        }
      });
      const startLeafId = session.sessionManager.getLeafId();
      await this.track(task, () => session.prompt(prompt, { source: "extension" }));
      result = {
        ...task.target,
        ...describeSessionResult(startLeafId, session.sessionManager.getBranch()),
      };
    } catch (error) {
      result = {
        ...task.target,
        status: "failed",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await this.cleanup(task);
      this.active.delete(task.target.id);
    }
    if (!this.closed) {
      try {
        await report(result);
      } catch (error) {
        this.deps.onReportError(error);
      }
    }
  }

  private track<T>(task: ActiveTask, call: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => {
      if (task.cleanup) throw new Error("Session stopped before the SDK call could run");
      return call();
    });
    task.pending.add(pending);
    return pending.finally(() => task.pending.delete(pending));
  }

  private async abort(session: TaskSession): Promise<void> {
    try {
      await session.abort();
    } catch (error) {
      this.deps.onReportError(error);
    }
  }

  private cleanup(task: ActiveTask): Promise<void> {
    task.cleanup ??= Promise.resolve().then(async () => {
      // Loading may still be binding extensions; do not race their startup with shutdown.
      const session = await task.loading?.catch(() => undefined);
      try {
        if (session && task.pending.size) {
          const abort = this.abort(session);
          await Promise.allSettled(task.pending);
          await abort;
        }
        task.unsubscribe?.();
        await session?.dispose();
      } catch (error) {
        this.deps.onReportError(error);
      } finally {
        task.session = undefined;
      }
    });
    return task.cleanup;
  }

  /** Suppress late reports immediately, then await loaded and still-loading task cleanup. */
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= Promise.all([...this.active.values()].map((task) => this.cleanup(task))).then(
      () => {
        this.active.clear();
      },
    );
    return this.closing;
  }
}
