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

export function formatSubagentToolDescription(
  context: DelegationContext,
  maxLiveAgents?: number,
): string {
  const agents = [...context.agentTypes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((agent) => `- ${agent.id}: ${agent.description ?? "No description."}`)
    .join("\n");
  const external =
    context.externalDirectories.length > 0
      ? context.externalDirectories.map((cwd) => `- ${cwd}`).join("\n")
      : "- (none)";
  const liveLimit =
    maxLiveAgents === undefined
      ? "Parallel work is subject to the configured shared live-subagent limit."
      : `The configured shared limit is ${maxLiveAgents} live subagents across the entire root session tree.`;
  return `Create a background subagent. The call returns once accepted; the subagent
runs asynchronously and reports back to this agent automatically when done.

Start multiple independent tasks in parallel by issuing multiple subagent calls
in the same assistant turn. ${liveLimit} Give parallel subagents non-overlapping
tasks. Parallel editing tasks must have mutually exclusive boundaries.

Do not poll, redo, or re-delegate accepted work. If any relevant subagent report
is still pending, give only a brief progress update that identifies the active
subagents, then end your turn. Give the final answer only after all relevant
reports arrive.

Available agent types:
${agents}

Current cwd:
- ${context.cwd}

Available external cwd:
${external}

Use ask_subagent to delegate another task to an existing idle subagent, or
set isSteer to true to steer an actively executing run.`;
}
