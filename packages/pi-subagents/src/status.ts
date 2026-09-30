import type { ActiveSubagentSummary, DelegationStatusSnapshot, SubagentReport } from "./types.js";

const MAX_VISIBLE_ACTIVE_SUBAGENTS = 10;
const MAX_VISIBLE_NAME_LENGTH = 80;

function compactName(name: string): string {
  const singleLine = name.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_VISIBLE_NAME_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_VISIBLE_NAME_LENGTH - 1)}…`;
}

export function createDelegationStatusSnapshot(
  activeDirectSubagents: ActiveSubagentSummary[],
  liveAgents: number,
  maxLiveAgents: number,
  directSubagents: DelegationStatusSnapshot["directSubagents"] = activeDirectSubagents.map(
    (agent) => ({ ...agent, state: "running" }),
  ),
): DelegationStatusSnapshot {
  const ordered = [...directSubagents].sort(
    (a, b) => Number(b.state === "running") - Number(a.state === "running"),
  );
  return {
    activeDirectSubagents: activeDirectSubagents
      .slice(0, MAX_VISIBLE_ACTIVE_SUBAGENTS)
      .map(({ id, name }) => ({ id, name: compactName(name) })),
    activeDirectSubagentCount: activeDirectSubagents.length,
    directSubagents: ordered
      .slice(0, MAX_VISIBLE_ACTIVE_SUBAGENTS)
      .map(({ id, name, state }) => ({ id, name: compactName(name), state })),
    directSubagentCount: directSubagents.length,
    interruptedDirectSubagentCount: directSubagents.filter(({ state }) => state === "interrupted")
      .length,
    liveAgents,
    maxLiveAgents,
  };
}

export function formatSubagentReport(
  report: SubagentReport,
  status: DelegationStatusSnapshot,
): string {
  const error = report.error ? `\n${report.error.code}: ${report.error.message}` : "";
  return `[Subagent ${compactName(report.name)} (${report.agentId}) ${report.outcome}]
cwd: ${report.cwd}${error}

${report.result}

### Subagents

${formatDelegationStatus(status)}

**Follow-up:** For related work in the same area, use \`ask_subagent\` with ID \`${report.agentId}\` to ask this same subagent again.`;
}

export function formatDelegationStatus(status: DelegationStatusSnapshot): string {
  const running = status.activeDirectSubagentCount;
  const interrupted = status.interruptedDirectSubagentCount;
  const done = status.directSubagentCount - running - interrupted;
  const counts = [`${running} running`, `${done} done`];
  if (interrupted) counts.push(`${interrupted} interrupted`);
  const summary = `**${counts.join(", ")}; shared usage: ${status.liveAgents}/${status.maxLiveAgents}.**`;
  const visible = status.directSubagents.map(
    ({ id, name, state }) => `- ${name} (\`${id}\`): ${state}`,
  );
  const hidden = status.directSubagentCount - visible.length;
  if (hidden > 0) visible.push(`- …and ${hidden} more`);
  return `${summary}\n${visible.length ? visible.join("\n") : "- None"}`;
}
