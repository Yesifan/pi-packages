import { loadAgentTypeRegistry } from "./agents.js";
import { loadSubagentsConfig } from "./config.js";
import { canonicalizeDirectory } from "./paths.js";
import type { DelegationContext, SubagentsConfig } from "./types.js";

export async function buildDelegationContext(
  cwdInput: string,
  agentDir: string,
  options: { initializeStorage?: boolean } = {},
): Promise<{ context: DelegationContext; config: SubagentsConfig }> {
  const cwd = await canonicalizeDirectory(cwdInput, {
    missing: "CWD_NOT_FOUND",
    notDirectory: "CWD_NOT_DIRECTORY",
  });
  const config = await loadSubagentsConfig(cwd, options);
  const agentTypes = await loadAgentTypeRegistry(agentDir, config.projectRoot);
  return {
    config,
    context: {
      cwd,
      agentTypes,
      externalDirectories: config.externalDirectories,
      projectRoot: config.projectRoot,
    },
  };
}

export function formatSubagentToolDescription(context: DelegationContext): string {
  const agents = [...context.agentTypes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((agent) => `- ${agent.id}: ${agent.description ?? "No description."}`)
    .join("\n");
  const external =
    context.externalDirectories.length > 0
      ? context.externalDirectories.map((cwd) => `- ${cwd}`).join("\n")
      : "- (none)";
  return `Create a background subagent. The call returns immediately after the
subagent has been accepted. Its final response is automatically reported
back to this agent.

Available agent types:
${agents}

Current cwd:
- ${context.cwd}

Available external cwd:
${external}

Use ask_subagent to delegate another task to an existing idle subagent, or
set isSteer to true to steer an actively executing run.`;
}
