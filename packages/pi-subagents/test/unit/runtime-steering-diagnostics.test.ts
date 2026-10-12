import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorToolResult } from "../../src/errors.js";
import { createSubagentProgressState } from "../../src/progress.js";
import { RootRuntime } from "../../src/runtime.js";
import type { AcceptedResult, Agent, Execution, RootScope } from "../../src/types.js";

let directory: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "pi-steering-diagnostics-"));
  process.env.PI_CODING_AGENT_DIR = directory;
});
afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const runtime = new RootRuntime(path.join(directory, "extension.ts"));
  const scope: RootScope = {
    identity: { sessionId: "internal-session", sessionFile: path.join(directory, "root.jsonl") },
    closing: false,
    children: new Map(),
    agents: new Set(),
    executions: new Set(),
    deliveries: new Set(),
  };
  const agent: Agent = {
    name: "reviewer",
    roleSnapshot: {
      id: "general",
      description: "General",
      prompt: "Review",
      source: "test",
      contentHash: "hash",
    },
    parent: null,
    children: new Map(),
    state: "running",
  };
  const prompt = vi.fn();
  const execution: Execution = {
    scope,
    agent,
    parent: scope,
    phase: "executing",
    session: { isStreaming: true, prompt } as unknown as AgentSession,
    pendingChildren: new Set(),
    pendingReports: new Set(),
    finalizing: false,
    reportSubmitted: false,
    accepted: true,
    sdkSettled: false,
    startLeafId: null,
    progress: createSubagentProgressState(),
  };
  agent.currentExecution = execution;
  Reflect.set(runtime, "scope", scope);
  const steer = Reflect.get(runtime, "steer") as (
    agent: Agent,
    prompt: string,
  ) => Promise<AcceptedResult>;
  return {
    runtime,
    scope,
    agent,
    execution,
    prompt,
    steer: () => steer.call(runtime, agent, "Focus"),
  };
}

describe("steering rejection diagnostics", () => {
  it("still queues steering on the same streaming execution even with pending children", async () => {
    const value = fixture();
    value.execution.pendingChildren.add(value.execution);
    const result = { name: "reviewer", status: "steered" } as AcceptedResult;
    Reflect.set(
      value.runtime,
      "acceptedResult",
      vi.fn(() => result),
    );
    value.prompt.mockImplementation((_prompt, options) => {
      options.preflightResult("queued");
      return Promise.resolve();
    });
    await expect(value.steer()).resolves.toBe(result);
    expect(value.prompt).toHaveBeenCalledWith(
      "Focus",
      expect.objectContaining({ streamingBehavior: "steer", expandPromptTemplates: false }),
    );
    expect(value.agent.currentExecution).toBe(value.execution);
    expect(value.execution.pendingChildren.size).toBe(1);
  });
  const cases: Array<{
    label: string;
    setup: (value: ReturnType<typeof fixture>) => void;
    reason: RegExp;
  }> = [
    {
      label: "idle",
      setup: ({ agent }) => {
        agent.state = "idle";
        agent.currentExecution = undefined;
      },
      reason: /idle.*no current execution/i,
    },
    {
      label: "interrupted",
      setup: ({ agent }) => {
        agent.state = "interrupted";
        agent.currentExecution = undefined;
      },
      reason: /interrupted.*no current execution/i,
    },
    {
      label: "released execution",
      setup: ({ agent }) => {
        agent.currentExecution = undefined;
      },
      reason: /no current execution.*released/i,
    },
    {
      label: "opening",
      setup: ({ execution }) => {
        execution.phase = "opening";
      },
      reason: /opening.*not.*started/i,
    },
    {
      label: "released SDK session",
      setup: ({ execution }) => {
        execution.session = undefined;
      },
      reason: /session.*released|no.*session/i,
    },
    {
      label: "waiting children",
      setup: ({ execution }) => {
        execution.phase = "waiting";
        execution.pendingChildren.add(execution);
      },
      reason: /waiting for.*children/i,
    },
    {
      label: "waiting reports",
      setup: ({ execution }) => {
        execution.phase = "waiting";
        execution.pendingReports.add({} as never);
      },
      reason: /waiting for.*reports/i,
    },
    {
      label: "waiting children and reports",
      setup: ({ execution }) => {
        execution.phase = "waiting";
        execution.pendingChildren.add(execution);
        execution.pendingReports.add({} as never);
      },
      reason: /waiting for.*children.*reports/i,
    },
    {
      label: "waiting SDK",
      setup: ({ execution }) => {
        execution.phase = "waiting";
      },
      reason: /waiting for.*SDK/i,
    },
    {
      label: "closing",
      setup: ({ execution }) => {
        execution.phase = "closing";
      },
      reason: /closing/i,
    },
    {
      label: "finalizing",
      setup: ({ execution }) => {
        execution.finalizing = true;
      },
      reason: /finalizing/i,
    },
    {
      label: "closed",
      setup: ({ execution }) => {
        execution.phase = "closed";
      },
      reason: /closed.*released/i,
    },
    {
      label: "SDK not streaming",
      setup: ({ execution }) => {
        execution.session = { isStreaming: false } as AgentSession;
      },
      reason: /SDK.*not streaming/i,
    },
    {
      label: "SDK settled",
      setup: ({ execution }) => {
        execution.session = { isStreaming: false } as AgentSession;
        execution.sdkSettled = true;
      },
      reason: /SDK.*settled.*not streaming/i,
    },
    {
      label: "scope closing",
      setup: ({ scope }) => {
        scope.closing = true;
      },
      reason: /root.*closing/i,
    },
    {
      label: "scope replaced",
      setup: ({ runtime }) => {
        Reflect.set(runtime, "scope", undefined);
      },
      reason: /owning.*scope.*no longer active/i,
    },
  ];
  it.each(cases)("explains $label without modifying the execution", async ({ setup, reason }) => {
    const value = fixture();
    setup(value);
    const currentExecution = value.agent.currentExecution;
    const phase = value.execution.phase;
    const children = value.execution.pendingChildren.size;
    const reports = value.execution.pendingReports.size;
    const error = await value.steer().catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "SUBAGENT_NOT_STEERABLE",
      message: expect.stringMatching(reason),
    });
    const result = errorToolResult(error);
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(reason) })]),
    );
    expect(JSON.stringify(result)).not.toContain("internal-session");
    expect(value.prompt).not.toHaveBeenCalled();
    expect(value.agent.currentExecution).toBe(currentExecution);
    expect(value.execution.phase).toBe(phase);
    expect(value.execution.pendingChildren.size).toBe(children);
    expect(value.execution.pendingReports.size).toBe(reports);
  });
});
