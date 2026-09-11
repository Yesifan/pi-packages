import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const MAX_ACTIVITY_LENGTH = 120;
const MAX_NAME_LENGTH = 40;
export const MAX_PROGRESS_WIDGET_LINES = 10;

export interface SubagentProgressState {
  modelCallCount: number;
  latestActivity: string;
}

export interface SubagentProgressEntry {
  name: string;
  progress: SubagentProgressState;
}

export function createSubagentProgressState(): SubagentProgressState {
  return { modelCallCount: 0, latestActivity: "starting" };
}

function singleLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, Math.max(0, maxLength - 3)).join("")}...`;
}

function stringArgument(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = Reflect.get(args, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function joinArguments(args: unknown, keys: string[]): string | undefined {
  const values = keys.flatMap((key) => {
    const value = stringArgument(args, key);
    return value ? [value] : [];
  });
  return values.length > 0 ? values.join(" ") : undefined;
}

export function formatToolActivity(toolName: string, args: unknown): string {
  const detail = (() => {
    switch (toolName) {
      case "bash":
      case "powershell":
        return stringArgument(args, "command");
      case "read":
      case "edit":
      case "write":
      case "ls":
        return stringArgument(args, "path");
      case "find":
      case "grep":
        return joinArguments(args, ["pattern", "path"]);
      default:
        return undefined;
    }
  })();
  const activity = detail ? `${toolName} ${detail}` : toolName;
  return truncate(singleLine(activity), MAX_ACTIVITY_LENGTH);
}

export function applyProgressEvent(
  progress: SubagentProgressState,
  event: AgentSessionEvent,
): boolean {
  if (event.type === "turn_start") {
    progress.modelCallCount += 1;
    progress.latestActivity = "thinking";
    return true;
  }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
    if (progress.latestActivity === "thinking") return false;
    progress.latestActivity = "thinking";
    return true;
  }
  if (event.type === "tool_execution_start") {
    progress.latestActivity = formatToolActivity(event.toolName, event.args);
    return true;
  }
  return false;
}

export function formatProgressLine(entry: SubagentProgressEntry): string {
  const name = truncate(singleLine(entry.name), MAX_NAME_LENGTH) || "subagent";
  return `${name}[${entry.progress.modelCallCount}]：${entry.progress.latestActivity}`;
}

export function buildProgressWidgetLines(
  entries: SubagentProgressEntry[],
  maxLines = MAX_PROGRESS_WIDGET_LINES,
): string[] {
  if (maxLines <= 0) return [];
  if (entries.length <= maxLines) return entries.map(formatProgressLine);
  if (maxLines === 1) return [`... ${entries.length} active subagents`];
  const visible = entries.slice(0, maxLines - 1).map(formatProgressLine);
  visible.push(`... +${entries.length - visible.length} active subagents`);
  return visible;
}
