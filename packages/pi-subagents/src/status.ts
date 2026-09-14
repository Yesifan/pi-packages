import type { ActiveSubagentSummary, DelegationStatusSnapshot } from "./types.js";

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
): DelegationStatusSnapshot {
  return {
    activeDirectSubagents: activeDirectSubagents
      .slice(0, MAX_VISIBLE_ACTIVE_SUBAGENTS)
      .map(({ id, name }) => ({ id, name: compactName(name) })),
    activeDirectSubagentCount: activeDirectSubagents.length,
    liveAgents,
    maxLiveAgents,
  };
}

export function formatDelegationStatus(status: DelegationStatusSnapshot): string {
  const total = status.activeDirectSubagentCount;
  const visible = status.activeDirectSubagents.map(({ id, name }) => `${name} (${id})`);
  const hidden = total - visible.length;
  const active =
    visible.length === 0
      ? "Active direct subagents: none."
      : `Active direct subagents (${total}): ${visible.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}.`;
  return `${active}\nShared live usage: ${status.liveAgents}/${status.maxLiveAgents}.`;
}
