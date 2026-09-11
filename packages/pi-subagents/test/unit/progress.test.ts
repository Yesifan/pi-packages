import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  applyProgressEvent,
  buildProgressWidgetLines,
  createSubagentProgressState,
  formatToolActivity,
} from "../../src/progress.js";

describe("subagent progress", () => {
  it("counts model calls and replaces the latest activity without accumulating snapshots", () => {
    const progress = createSubagentProgressState();

    expect(applyProgressEvent(progress, { type: "turn_start" } as AgentSessionEvent)).toBe(true);
    expect(progress).toEqual({ modelCallCount: 1, latestActivity: "thinking" });

    expect(
      applyProgressEvent(progress, {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "package.json" },
      }),
    ).toBe(true);
    expect(progress).toEqual({ modelCallCount: 1, latestActivity: "read package.json" });

    expect(
      applyProgressEvent(progress, {
        type: "tool_execution_start",
        toolCallId: "tool-2",
        toolName: "bash",
        args: { command: "pnpm   test\n--runInBand" },
      }),
    ).toBe(true);
    expect(progress).toEqual({
      modelCallCount: 1,
      latestActivity: "bash pnpm test --runInBand",
    });

    expect(applyProgressEvent(progress, { type: "turn_start" } as AgentSessionEvent)).toBe(true);
    expect(progress).toEqual({ modelCallCount: 2, latestActivity: "thinking" });
  });

  it("does not expose thinking deltas or tool output", () => {
    const progress = { modelCallCount: 1, latestActivity: "bash pnpm test" };

    expect(
      applyProgressEvent(progress, {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "private reasoning",
          partial: { role: "assistant" },
        },
      } as AgentSessionEvent),
    ).toBe(false);
    expect(
      applyProgressEvent(progress, {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pnpm test" },
        partialResult: { content: [{ type: "text", text: "secret output" }] },
      } as AgentSessionEvent),
    ).toBe(false);
    expect(progress.latestActivity).toBe("bash pnpm test");
  });

  it("formats allowlisted tool arguments and hides arbitrary custom-tool arguments", () => {
    expect(formatToolActivity("grep", { pattern: "needle", path: "src" })).toBe("grep needle src");
    expect(formatToolActivity("custom", { secret: "do not show" })).toBe("custom");
    expect(formatToolActivity("bash", { command: `echo ${"x".repeat(200)}` })).toMatch(
      /^.{117}\.\.\.$/,
    );
    expect(Array.from(formatToolActivity("bash", { command: "😀".repeat(200) }))).toHaveLength(120);
  });

  it("renders one latest line per subagent and bounds the native widget", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `worker-${index + 1}`,
      progress: { modelCallCount: index + 1, latestActivity: "thinking" },
    }));

    expect(buildProgressWidgetLines(entries.slice(0, 2))).toEqual([
      "worker-1[1]：thinking",
      "worker-2[2]：thinking",
    ]);
    expect(buildProgressWidgetLines(entries)).toHaveLength(10);
    expect(buildProgressWidgetLines(entries).at(-1)).toBe("... +3 active subagents");
  });
});
