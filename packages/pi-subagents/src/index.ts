import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildDelegationContext } from "./delegation.js";
import { asSubagentError, SubagentError } from "./errors.js";
import { RootRuntime } from "./runtime.js";
import { createDelegationExtension, type DelegationRuntimeApi } from "./tools.js";
import type { CallerBinding, SubagentReport } from "./types.js";

const OWN_EXTENSION_PATH = fileURLToPath(import.meta.url);

function failedRuntime(error: unknown): DelegationRuntimeApi {
  const failure = asSubagentError(error, "INVALID_CONFIG");
  return {
    async createSubagent() {
      throw failure;
    },
    async askSubagent() {
      throw failure;
    },
  };
}

export default function piSubagents(pi: ExtensionAPI): void {
  const runtime = new RootRuntime(OWN_EXTENSION_PATH);
  let started = false;

  pi.on("session_start", async (_event, ctx) => {
    if (started) return;
    started = true;
    const { context, config } = await buildDelegationContext(ctx.cwd, getAgentDir());
    const caller: CallerBinding = {
      agentId: null,
      depth: 0,
      ancestorCwds: [context.cwd],
      delegation: context,
    };
    const rootSessionFile = ctx.sessionManager.getSessionFile();
    let toolRuntime: DelegationRuntimeApi = runtime;
    if (!rootSessionFile) {
      toolRuntime = failedRuntime(
        new SubagentError(
          "ROOT_SESSION_NOT_PERSISTENT",
          "pi-subagents requires a file-backed root session",
        ),
      );
    } else {
      try {
        await runtime.initialize(
          {
            rootSessionId: ctx.sessionManager.getSessionId(),
            rootSessionFile,
            ctx,
            sendReport: (report: SubagentReport) => {
              pi.sendMessage(
                {
                  customType: "bykwp-subagent-report",
                  content: formatRootReport(report),
                  display: true,
                  details: report,
                },
                { deliverAs: "steer", triggerTurn: true },
              );
            },
          },
          config,
        );
      } catch (error) {
        toolRuntime = failedRuntime(error);
        ctx.ui.notify(`pi-subagents unavailable: ${asSubagentError(error).message}`, "error");
      }
    }
    createDelegationExtension(toolRuntime, caller)(pi);
  });

  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });
}

function formatRootReport(report: SubagentReport): string {
  const error = report.error ? `\n${report.error.code}: ${report.error.message}` : "";
  return `[Subagent ${report.name} (${report.agentId}) ${report.outcome}]
run: ${report.runId}
cwd: ${report.cwd}${error}

${report.result}`;
}

export type { ExtensionContext };
