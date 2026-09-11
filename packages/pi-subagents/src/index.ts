import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildDelegationContext } from "./delegation.js";
import { asSubagentError, SubagentError } from "./errors.js";
import { canonicalizeDirectory, findProjectRoot } from "./paths.js";
import { RootRuntime } from "./runtime.js";
import { createDelegationExtension, type DelegationRuntimeApi } from "./tools.js";
import type { CallerBinding, SubagentReport } from "./types.js";

const OWN_EXTENSION_PATH = fileURLToPath(import.meta.url);

async function assertRootProjectTrusted(
  ctx: ExtensionContext,
  projectRoot: string,
  agentDir: string,
): Promise<void> {
  const cwd = await canonicalizeDirectory(ctx.cwd, {
    missing: "CWD_NOT_FOUND",
    notDirectory: "CWD_NOT_DIRECTORY",
  });
  if (cwd === projectRoot) return;
  const saved = new ProjectTrustStore(agentDir).get(projectRoot);
  if (saved === true) return;
  if (saved === false) {
    throw new SubagentError(
      "PROJECT_NOT_TRUSTED",
      `Git project root must be trusted before pi-subagents can initialize: ${projectRoot}`,
    );
  }
  const policy = SettingsManager.create(projectRoot, agentDir, {
    projectTrusted: false,
  }).getDefaultProjectTrust();
  if (policy === "always") return;
  if (policy === "never" || !ctx.hasUI) {
    throw new SubagentError(
      "PROJECT_NOT_TRUSTED",
      `Git project root must be trusted before pi-subagents can initialize: ${projectRoot}`,
    );
  }
  const trusted = await ctx.ui.confirm(
    "Trust Git project root?",
    `Allow pi-subagents to read configuration and store session history in ${projectRoot}?`,
  );
  if (!trusted) {
    throw new SubagentError(
      "PROJECT_NOT_TRUSTED",
      `Git project root was not trusted: ${projectRoot}`,
    );
  }
}

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
    const fallbackCwd = ctx.cwd;
    let caller: CallerBinding = {
      agentId: null,
      depth: 0,
      ancestorCwds: [fallbackCwd],
      delegation: {
        cwd: fallbackCwd,
        projectRoot: fallbackCwd,
        externalDirectories: [],
        agentTypes: new Map(),
      },
    };
    let toolRuntime: DelegationRuntimeApi = runtime;
    try {
      const rootSessionFile = ctx.sessionManager.getSessionFile();
      if (!rootSessionFile) {
        throw new SubagentError(
          "ROOT_SESSION_NOT_PERSISTENT",
          "pi-subagents requires a file-backed root session",
        );
      }
      if (!ctx.isProjectTrusted()) {
        throw new SubagentError(
          "PROJECT_NOT_TRUSTED",
          `Project must be trusted before pi-subagents can initialize: ${ctx.cwd}`,
        );
      }
      const agentDir = getAgentDir();
      const projectRoot = await findProjectRoot(ctx.cwd);
      await assertRootProjectTrusted(ctx, projectRoot, agentDir);
      const { context, config } = await buildDelegationContext(ctx.cwd, agentDir);
      caller = {
        agentId: null,
        depth: 0,
        ancestorCwds: [context.cwd],
        delegation: context,
      };
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
