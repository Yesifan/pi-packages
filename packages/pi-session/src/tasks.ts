import {
  type AgentSession,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { findSession, type SessionTarget } from "./sessions.js";

export type TaskSession = Pick<
  AgentSession,
  "prompt" | "steer" | "getLastAssistantText" | "messages" | "isStreaming"
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
  const { session } = await createAgentSession({
    cwd: target.cwd,
    sessionManager: SessionManager.open(target.path),
  });
  const dispose = session.dispose.bind(session);
  let cleanup: Promise<void> | undefined;
  const shutdown = () =>
    (cleanup ??= Promise.resolve().then(async () => {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        dispose();
      }
    }));
  try {
    // Headless defaults intentionally use the target project's resources, not caller overrides.
    await session.bindExtensions({ mode: "print" });
    return Object.assign(session, { dispose: shutdown });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

type ActiveTask = {
  target: SessionTarget;
  session?: TaskSession;
  loading?: Promise<TaskSession>;
  cleanup?: Promise<void>;
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
      if (!existing || existing.target.path !== target.path)
        throw new Error("No active task for this session");
      if (!existing.session) throw new Error("Session is still loading; cannot steer yet");
      if (!existing.session.isStreaming) throw new Error("Session is not streaming; cannot steer");
      const session = existing.session;
      const result = await session.steer(request.prompt, undefined, {
        source: "extension",
      });
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
    const task: ActiveTask = { target };
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
      const previous = session.messages.findLast((message) => message.role === "assistant");
      await session.prompt(prompt, { source: "extension" });
      const latest = session.messages.findLast((message) => message.role === "assistant");
      const last = latest !== previous ? latest : undefined;
      if (
        last?.role === "assistant" &&
        (last.stopReason === "error" || last.stopReason === "aborted")
      ) {
        throw new Error(last.errorMessage || `Session ${last.stopReason}`);
      }
      result = {
        ...task.target,
        status: "completed",
        text:
          (last ? session.getLastAssistantText() : undefined) ??
          "Session completed without an assistant response.",
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

  private cleanup(task: ActiveTask): Promise<void> {
    task.cleanup ??= Promise.resolve().then(async () => {
      // Loading may still be binding extensions; do not race their startup with shutdown.
      const session = await task.loading?.catch(() => undefined);
      try {
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
