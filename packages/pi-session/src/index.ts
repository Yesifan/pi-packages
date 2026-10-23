import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createReferenceProvider, expandReferences, type SessionList } from "./references.js";
import { resolveCwd, searchSessions } from "./sessions.js";
import { SessionTasks } from "./tasks.js";

function listFor(cwd: string): SessionList {
  return (scope, signal) =>
    scope === "all"
      ? SessionManager.listAll(undefined, signal)
      : SessionManager.list(cwd, undefined, undefined, signal);
}

const cwdParameter = Type.Optional(
  Type.String({
    description:
      "Absolute project cwd; omitted or empty uses current cwd. Other directories require authorization.",
  }),
);

function warn(ctx: ExtensionContext, message: string, error: unknown): void {
  try {
    ctx.ui.notify(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  } catch {
    // Notifications are optional UI feedback, never a prerequisite for session tools or input.
  }
}

export default function piSession(pi: ExtensionAPI): void {
  let tasks: SessionTasks | undefined;
  let callerId: string | undefined;

  function requireRuntime(ctx: ExtensionContext): SessionTasks {
    if (!tasks || callerId !== ctx.sessionManager.getSessionId()) {
      throw new Error("pi-session tools require an active caller session");
    }
    return tasks;
  }

  pi.on("session_start", (_event, ctx) => {
    if (tasks) return;
    callerId = ctx.sessionManager.getSessionId();
    tasks = new SessionTasks();
    try {
      ctx.ui.addAutocompleteProvider((current) =>
        createReferenceProvider(current, listFor(ctx.cwd)),
      );
    } catch (error) {
      warn(ctx, "Session reference completion unavailable", error);
    }
  });

  pi.registerTool({
    name: "search-session",
    label: "Search sessions",
    description:
      "Search user/assistant text in sessions of one authorized cwd. Returns full session IDs, absolute paths and matching newline-delimited text (not whole messages). Results may be truncated; read the session file for more context.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), cwd: cwdParameter }),
    async execute(_id, params, signal, _onUpdate, toolCtx) {
      const runtime = requireRuntime(toolCtx);
      const cwd = await resolveCwd(toolCtx.cwd, params.cwd);
      signal?.throwIfAborted();
      if (tasks !== runtime) throw new Error("Caller session changed");
      const result = await searchSessions(cwd, params.query, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "ask-session",
    label: "Ask session",
    description:
      "Continue an existing session by full ID in an authorized cwd (default current cwd), writing to its original history. Runs in the background and reports completion or failure automatically. Do not poll or repeat accepted work. Use steer=true to adjust an active task; ask again after completion for follow-up work. Steering only controls tasks started by this extension instance. Reports require a live caller lifecycle; no external-instance locking or restart recovery.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Full session ID, not a name or file path" }),
      cwd: cwdParameter,
      prompt: Type.String({ minLength: 1 }),
      steer: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, toolCtx) {
      const runtime = requireRuntime(toolCtx);
      const origin = toolCtx.sessionManager.getSessionId();
      const cwd = await resolveCwd(toolCtx.cwd, params.cwd);
      signal?.throwIfAborted();
      if (tasks !== runtime) throw new Error("Caller session changed");
      const result = await runtime.ask({ ...params, cwd, callerId: origin }, (report) => {
        if (tasks !== runtime || callerId !== origin) return;
        pi.sendMessage(
          {
            customType: "session-report",
            content: `Session ${report.id} ${report.status}\nCwd: ${report.cwd}\nSession file: ${report.path}\n\n${report.text}\n\nFor related follow-up work, reuse ask-session with this full session ID.`,
            display: true,
            details: report,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      });
      const guidance = {
        accepted: `Accepted background task for session ${result.id}.\nReports arrive automatically; do not poll, redo, or re-delegate accepted work.\nWhile relevant reports are pending, give only a brief progress update identifying the pending sessions, then end your turn. Give the final answer only after all relevant reports arrive.`,
        steered: `Steering queued for session ${result.id}. Continue waiting for the original task's report; no separate report is created.`,
        handled:
          "Instructions were handled by the target's input handler, not queued as steering. This response is not a completion report and does not confirm that the original task is still active.",
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(result) },
          { type: "text", text: guidance[result.status] },
        ],
        details: result,
      };
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
    try {
      const text = await expandReferences(event.text, listFor(ctx.cwd), ctx.signal);
      return text === event.text ? { action: "continue" } : { action: "transform", text };
    } catch (error) {
      warn(ctx, "Session references left unchanged", error);
      return { action: "continue" };
    }
  });

  pi.on("session_shutdown", async () => {
    const runtime = tasks;
    tasks = undefined;
    callerId = undefined;
    await runtime?.close();
  });
}
