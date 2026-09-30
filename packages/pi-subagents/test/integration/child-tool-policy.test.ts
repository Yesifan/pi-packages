import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentTypeRegistry, resolveAgentDefinition } from "../../src/agents.js";
import { ChildSessionFactory, type OpenedChild } from "../../src/child-session.js";
import type { DelegationRuntimeApi } from "../../src/tools.js";
import type { AgentDefinitionSnapshot, StoredSubagent } from "../../src/types.js";
import { RootUiBroker } from "../../src/ui.js";

const directories: string[] = [];
const children: OpenedChild[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.dispose()));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-tool-policy-"));
  directories.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const extensions = path.join(cwd, ".pi", "extensions");
  const sessions = path.join(root, "sessions");
  await Promise.all([mkdir(extensions, { recursive: true }), mkdir(agentDir), mkdir(sessions)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "test-only" } }),
  );
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"],
    }),
  );
  await writeFile(
    path.join(extensions, "policy.js"),
    `
export default function(pi) {
  const register = (name) => pi.registerTool({
    name, label: name, description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
  });
  register("search_web");
  register("blocked_extension");
  pi.on("session_start", () => {
    for (const name of ["blocked_extension", "late_blocked", "late_allowed", "bash", "subagent", "ask_subagent"]) register(name);
    pi.setActiveTools(["read", "search_web", "blocked_extension", "late_blocked", "late_allowed", "bash", "subagent", "ask_subagent"]);
  });
  pi.on("session_shutdown", () => {
    register("blocked_extension");
    register("late_allowed");
    pi.setActiveTools(["read", "search_web", "late_allowed", "blocked_extension", "late_blocked", "bash", "edit", "write", "subagent", "ask_subagent"]);
  });
}
`,
  );
  const broker = new RootUiBroker({} as ConstructorParameters<typeof RootUiBroker>[0], false, 100);
  const factory = new ChildSessionFactory(
    agentDir,
    path.join(root, "own-extension.js"),
    broker,
    async () => true,
  );
  const manager = await factory.createSessionManager(cwd, sessions);
  const registry = await loadAgentTypeRegistry(agentDir, cwd);
  const open = async (
    snapshot: AgentDefinitionSnapshot,
    sessionManager = manager,
    canDelegate = false,
  ) => {
    const timestamp = new Date().toISOString();
    const stored: StoredSubagent = {
      schemaVersion: 2,
      id: "sa_policy",
      rootSessionId: "root",
      parentAgentId: null,
      name: "policy",
      cwd,
      ancestorCwds: [cwd],
      agentType: snapshot.id,
      agentDefinitionSnapshot: snapshot,
      depth: 1,
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      thinking: "off",
      sessionId: manager.getSessionId(),
      sessionPath: path.basename(manager.getSessionFile()!),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const child = await factory.open({
      stored,
      runId: "run_policy",
      runtime: { getMaxLiveAgents: () => 8 } as DelegationRuntimeApi,
      canDelegate,
      ...(canDelegate
        ? {
            delegationContext: {
              cwd,
              projectRoot: cwd,
              agentTypes: registry,
              externalDirectories: [],
            },
          }
        : {}),
      sessionManager,
      thinking: "off",
    });
    children.push(child);
    return { child, stored };
  };
  return { cwd, agentDir, extensions, factory, manager, registry, open };
}

function expectExcluded(child: OpenedChild, names: string[]) {
  for (const name of names) {
    expect(child.session.getAllTools().map((tool) => tool.name)).not.toContain(name);
    expect(child.session.getActiveToolNames()).not.toContain(name);
    expect(child.session.agent.state.tools.map((tool) => tool.name)).not.toContain(name);
    expect(child.session.getToolDefinition(name)).toBeUndefined();
  }
}

describe("child role tool policy with the real SDK", () => {
  it("keeps explore extension tools and excludes built-ins despite extension re-registration", async () => {
    const h = await harness();
    const { child } = await h.open(resolveAgentDefinition(h.registry, "explore"));
    expectExcluded(child, ["edit", "write", "bash", "subagent", "ask_subagent"]);
    expect(child.session.getActiveToolNames()).toContain("search_web");
    expect(child.session.getAllTools().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["grep", "find", "ls", "powershell"]),
    );
    await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    child.session.setActiveToolsByName(["bash", "edit", "write", "search_web"]);
    expectExcluded(child, ["edit", "write", "bash", "subagent", "ask_subagent"]);
    expect(child.session.getActiveToolNames()).toEqual(["search_web"]);
  });

  it("excludes initially registered and future extension tools without requiring denied names to exist", async () => {
    const h = await harness();
    const snapshot = {
      ...resolveAgentDefinition(h.registry),
      disallowedTools: ["blocked_extension", "late_blocked", "absent_tool", "bash"],
    };
    const { child } = await h.open(snapshot);
    expectExcluded(child, [...snapshot.disallowedTools, "subagent", "ask_subagent"]);
    expect(child.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["search_web", "late_allowed"]),
    );
    await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expectExcluded(child, snapshot.disallowedTools);
  });

  it("keeps denylist registries isolated across target cwds", async () => {
    const first = await harness();
    const second = await harness();
    const { child: restricted } = await first.open({
      ...resolveAgentDefinition(first.registry),
      disallowedTools: ["blocked_extension", "bash"],
    });
    const { child: unrestricted } = await second.open(resolveAgentDefinition(second.registry));
    expect(unrestricted.session.getAllTools().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["blocked_extension", "bash"]),
    );
    await restricted.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expectExcluded(restricted, ["blocked_extension", "bash"]);
    expect(unrestricted.session.getActiveToolNames()).toContain("blocked_extension");
  });

  it("restores an old explore allowlist snapshot without adopting the new built-in denylist", async () => {
    const h = await harness();
    const saved: AgentDefinitionSnapshot = {
      id: "explore",
      description: "Read-only code exploration.",
      tools: ["read", "grep", "find", "ls"],
      prompt: "Saved exploration prompt",
      source: "/old/agents/explore.md",
      contentHash: "saved-hash",
    };
    const { child } = await h.open(saved);
    expect(
      child.session
        .getAllTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["find", "grep", "ls", "read"]);
    expectExcluded(child, ["bash", "edit", "write", "search_web"]);
    expect(child.session.systemPrompt).toContain(saved.prompt);
    expect(saved).not.toHaveProperty("disallowedTools");
  });

  it("independently excludes ask_subagent on a delegation-capable child", async () => {
    const h = await harness();
    const { child } = await h.open(
      { ...resolveAgentDefinition(h.registry), disallowedTools: ["ask_subagent"] },
      h.manager,
      true,
    );
    expectExcluded(child, ["ask_subagent"]);
    expect(child.session.getAllTools().map((tool) => tool.name)).toContain("subagent");
    await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expectExcluded(child, ["ask_subagent"]);
  });

  it.each([undefined, []])(
    "preserves unrestricted policy %j and legacy whitelist behavior",
    async (disallowedTools) => {
      const h = await harness();
      const { child } = await h.open({
        ...resolveAgentDefinition(h.registry),
        ...(disallowedTools ? { disallowedTools } : {}),
      });
      expect(child.session.getActiveToolNames()).toContain("bash");
      const { child: limited } = await h.open({
        ...resolveAgentDefinition(h.registry),
        tools: ["read", "search_web"],
      });
      expect(
        limited.session
          .getAllTools()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(["read", "search_web"]);
      await expect(
        h.open({ ...resolveAgentDefinition(h.registry), tools: ["absent_tool"] }),
      ).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
    },
  );

  it("remounts the saved denylist while discovering current tools without injecting role messages", async () => {
    const h = await harness();
    const snapshot = {
      ...resolveAgentDefinition(h.registry),
      disallowedTools: ["blocked_extension", "late_blocked"],
    };
    const { child, stored } = await h.open(snapshot);
    h.manager.appendMessage({ role: "user", content: "original task", timestamp: Date.now() });
    await child.dispose();
    children.splice(children.indexOf(child), 1);
    await mkdir(path.join(h.cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      path.join(h.cwd, ".pi", "agents", "general.md"),
      "---\nname: general\ntools: [read]\n---\nreplacement prompt",
    );
    await writeFile(
      path.join(h.extensions, "current.js"),
      `export default function(pi) { pi.registerTool({ name: "current_tool", label: "current", description: "current", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }); }`,
    );
    const restored = h.factory.openSessionManager(stored, h.manager.getSessionFile()!);
    const before = restored.getBranch();
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user", content: "original task" }),
        }),
      ]),
    );
    const { child: remounted } = await h.open(snapshot, restored);
    expectExcluded(remounted, snapshot.disallowedTools);
    expect(remounted.session.getAllTools().map((tool) => tool.name)).toContain("current_tool");
    expect(remounted.session.systemPrompt).toContain(snapshot.prompt);
    expect(remounted.session.systemPrompt).not.toContain("replacement prompt");
    expect(restored.getBranch()).toEqual(before);
  });
});
