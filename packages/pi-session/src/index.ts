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

export default function piSession(pi: ExtensionAPI): void {
  let tasks: SessionTasks | undefined;
  let callerId: string | undefined;
  let installed = false;

  function requireRuntime(ctx: ExtensionContext): SessionTasks {
    if (ctx.mode !== "tui" || !tasks || callerId !== ctx.sessionManager.getSessionId()) {
      throw new Error("pi-session tools require an active terminal session");
    }
    return tasks;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (installed) return;
    installed = true;
    callerId = ctx.sessionManager.getSessionId();
    tasks = new SessionTasks();
    ctx.ui.addAutocompleteProvider((current) => createReferenceProvider(current, listFor(ctx.cwd)));

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
        "Continue an existing session by full ID within the specified authorized cwd (default current cwd). Writes to the original session and runs in the background. Completion or failure is reported automatically: do not poll or repeat accepted work; give only a brief progress update and end your turn while waiting. Ask again after completion for a follow-up. Use steer=true only to adjust an active task started by this extension. No external-instance locking or restart recovery; avoid using the same session in another terminal concurrently.",
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
              content: `Session ${report.id} ${report.status}\nCwd: ${report.cwd}\nSession file: ${report.path}\n\n${report.text}`,
              display: true,
              details: report,
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  });

  pi.on("input", async (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" };
    try {
      const text = await expandReferences(event.text, listFor(ctx.cwd), ctx.signal);
      return text === event.text ? { action: "continue" } : { action: "transform", text };
    } catch (error) {
      ctx.ui.notify(
        `Session references left unchanged: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return { action: "continue" };
    }
  });

  pi.on("session_shutdown", async () => {
    const runtime = tasks;
    tasks = undefined;
    callerId = undefined;
    installed = false;
    await runtime?.close();
  });
}
