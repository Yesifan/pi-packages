import type { ActiveSubagentSummary, DelegationStatusSnapshot, SubagentReport } from "./types.js";

function label(name: string): string {
  const text = name.replace(/\s+/g, " ").trim();
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`;
}
export function createDelegationStatusSnapshot(
  activeDirectSubagents: ActiveSubagentSummary[],
  liveAgents: number,
  maxLiveAgents: number,
  directSubagents: DelegationStatusSnapshot["directSubagents"] = activeDirectSubagents.map(
    (agent) => ({ ...agent, state: "running" }),
  ),
): DelegationStatusSnapshot {
  return {
    activeDirectSubagents: activeDirectSubagents.map((agent) => ({ ...agent })),
    activeDirectSubagentCount: activeDirectSubagents.length,
    directSubagents: [...directSubagents]
      .sort((a, b) => Number(b.state === "running") - Number(a.state === "running"))
      .map((agent) => ({ ...agent })),
    directSubagentCount: directSubagents.length,
    interruptedDirectSubagentCount: directSubagents.filter((agent) => agent.state === "interrupted")
      .length,
    liveAgents,
    maxLiveAgents,
  };
}
export function formatDelegationStatus(status: DelegationStatusSnapshot): string {
  const running = status.activeDirectSubagentCount;
  const interrupted = status.interruptedDirectSubagentCount;
  const counts = [
    `${running} running`,
    `${status.directSubagentCount - running - interrupted} done`,
  ];
  if (interrupted) counts.push(`${interrupted} interrupted`);
  const summary = `**${counts.join(", ")}; shared usage: ${status.liveAgents}/${status.maxLiveAgents} (includes initialization).**`;
  const lines = status.directSubagents.map(
    ({ name, agentType, state }) => `- ${label(name)} (role: ${agentType}): ${state}`,
  );
  return `${summary}\n${lines.length ? lines.join("\n") : "- None"}`;
}
export function formatSubagentReport(
  report: SubagentReport,
  status: DelegationStatusSnapshot,
): string {
  return `# ${label(report.name)} Subagent Report

> role: ${report.agentType} outcome: ${report.outcome} cwd: ${report.cwd}

${report.sessionFile ? `Complete conversation: \`${report.sessionFile}\`. Read it if more context is needed.` : "Complete conversation unavailable: persisted session history could not be validated."}

${report.error ? `## Error\n${report.error.code}: ${report.error.message}\n\n` : ""}## Result

${report.result}

## Subagents

${formatDelegationStatus(status)}

**Follow-up:** For related work, you can use \`ask_subagent\` with the full name of any idle subagent listed above.`;
}
