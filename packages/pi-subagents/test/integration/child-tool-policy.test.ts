import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentTypeRegistry, resolveAgentDefinition } from "../../src/agents.js";
import { ChildSessionFactory, type OpenedChild } from "../../src/child-session.js";
import type { DelegationRuntimeApi } from "../../src/tools.js";
import type { Agent, AgentDefinitionSnapshot } from "../../src/types.js";
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

async function harness(withMcpTools = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-tool-policy-"));
  directories.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const extensions = path.join(cwd, ".pi", "extensions");
  await Promise.all([mkdir(extensions, { recursive: true }), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "policy-test": {
          api: withMcpTools ? "policy-fixture" : "openai-completions",
          apiKey: "local-test-only",
          baseUrl: "https://unused.invalid",
          models: [
            {
              id: "policy-model",
              name: "Policy fixture",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"],
      cacheWarming: "off",
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
  if (withMcpTools) {
    await writeFile(
      path.join(extensions, "mcp-policy.js"),
      `
import { createAssistantMessageEventStream } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")))};
export default function(pi) {
  // Offline model drives a normal tool turn; this is not QuickJS codemode scripting.
  pi.registerProvider("policy-test", {
    api: "policy-fixture",
    apiKey: "local-test-only",
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const finished = context.messages.some((message) => message.role === "toolResult" && message.toolName === "codemode");
      const message = {
        role: "assistant",
        content: finished
          ? [{ type: "text", text: "Nested fixture complete" }]
          : [{ type: "toolCall", id: "policy-nested-call", name: "codemode", arguments: { name: "mcp__fixture__write" } }],
        api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: finished ? "stop" : "toolUse",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  const register = (name) => pi.registerTool({
    name, label: name, description: name, exposure: "codemode",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
  });
  pi.registerTool({
    name: "codemode", label: "nested-call fixture", description: "Tests the nested-tool execution pathway",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: async (_id, args, _signal, _update, ctx) => {
      const outcome = await ctx.executeTool(args.name, {});
      if (outcome.isError) throw new Error(JSON.stringify(outcome.result));
      return outcome.result;
    },
  });
  register("mcp__fixture__read");
  register("mcp__fixture__write");
  register("list_mcp_resources");
  const refresh = () => {
    register("mcp__fixture__write");
    register("mcp__fixture__late");
    pi.setActiveTools(["read", "codemode", "mcp__fixture__write"]);
  };
  pi.on("session_start", refresh);
  pi.on("session_shutdown", refresh);
}
`,
    );
  }
  const broker = new RootUiBroker({} as ConstructorParameters<typeof RootUiBroker>[0], false, 100);
  const factory = new ChildSessionFactory(
    agentDir,
    path.join(root, "own-extension.js"),
    broker,
    async () => true,
  );
  const manager = await factory.createSessionManager(cwd);
  const registry = await loadAgentTypeRegistry(agentDir, cwd);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel("policy-test", "policy-model")!;
  const open = async (
    snapshot: AgentDefinitionSnapshot,
    sessionManager = manager,
    canDelegate = false,
    restoring = false,
  ) => {
    const callerAgent: Agent = {
      name: "policy",
      identity: {
        sessionId: sessionManager.getSessionId(),
        sessionFile: sessionManager.getSessionFile()!,
      },
      roleSnapshot: snapshot,
      parent: null,
      children: new Map(),
      state: "opening",
      cwd,
    };
    const child = await factory.open({
      name: "policy",
      roleSnapshot: snapshot,
      cwd,
      depth: 1,
      ancestorCwds: [cwd],
      callerAgent,
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
      ...(restoring ? { restoring: true } : { model, thinking: "off" }),
    });
    children.push(child);
    return { child };
  };
  return { cwd, agentDir, extensions, factory, manager, registry, open };
}

function seedHistory(manager: SessionManager) {
  manager.appendModelChange("policy-test", "policy-model");
  manager.appendThinkingLevelChange("off");
  manager.appendMessage({ role: "user", content: "original task", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "original reply" }],
    api: "openai-completions",
    provider: "policy-test",
    model: "policy-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
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
  it.each([["read"], ["read", "codemode"], ["read", "list_mcp_resources"]])(
    "retains registered MCP tools when selections contain no mcp__ entry: %j",
    async (...tools) => {
      const h = await harness(true);
      const { child } = await h.open({ ...resolveAgentDefinition(h.registry), tools });
      const retained = [
        "mcp__fixture__read",
        "mcp__fixture__write",
        "mcp__fixture__late",
        "list_mcp_resources",
      ];
      expect(child.session.getCallableToolNames()).toEqual(expect.arrayContaining(retained));
      expectExcluded(child, ["bash", "search_web", "subagent", "ask_subagent"]);
      if (tools.includes("codemode")) {
        child.session.setActiveToolsByName(tools);
        await child.session.prompt("Run the nested-tool fixture", { expandPromptTemplates: false });
        const result = child.session.agent.state.messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "policy-nested-call",
        );
        expect(result).toMatchObject({
          role: "toolResult",
          toolName: "codemode",
          isError: false,
          content: [{ type: "text", text: "mcp__fixture__write" }],
        });
      }
      await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(child.session.getCallableToolNames()).toEqual(expect.arrayContaining(retained));
    },
  );

  it("filters MCP tools when an MCP entry is explicitly allowlisted", async () => {
    const h = await harness(true);
    const { child } = await h.open({
      ...resolveAgentDefinition(h.registry),
      tools: ["read", "codemode", "mcp__fixture__read"],
    });
    expect(child.session.getCallableToolNames()).toContain("mcp__fixture__read");
    const excluded = ["mcp__fixture__write", "mcp__fixture__late", "list_mcp_resources"];
    expectExcluded(child, excluded);
    await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expectExcluded(child, excluded);
    for (const name of excluded) expect(child.session.getCallableToolNames()).not.toContain(name);
  });

  it("excludes all tools including MCP tools for an empty allowlist", async () => {
    const h = await harness(true);
    const { child } = await h.open({ ...resolveAgentDefinition(h.registry), tools: [] });
    expect(child.session.getAllTools()).toEqual([]);
    expect(child.session.getCallableToolNames()).toEqual([]);
    await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(child.session.getAllTools()).toEqual([]);
  });

  it.each([["mcp__fixture__*", "late_*"], ["*"]])(
    "uses SDK wildcard exclusions %j across dynamic registration",
    async (...disallowedTools) => {
      const h = await harness(true);
      const { child } = await h.open({ ...resolveAgentDefinition(h.registry), disallowedTools });
      const excluded = [
        "mcp__fixture__read",
        "mcp__fixture__write",
        "mcp__fixture__late",
        "late_allowed",
        "late_blocked",
      ];
      expectExcluded(child, excluded);
      await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expectExcluded(child, excluded);
      for (const name of excluded) expect(child.session.getCallableToolNames()).not.toContain(name);
      if (disallowedTools.includes("*")) {
        expect(child.session.getAllTools()).toEqual([]);
        expect(child.session.getCallableToolNames()).toEqual([]);
      } else {
        expect(child.session.getAllTools().map((tool) => tool.name)).toContain("search_web");
        expect(child.session.getCallableToolNames()).toContain("list_mcp_resources");
      }
    },
  );

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
    seedHistory(h.manager);
    const before = h.manager.getBranch();
    const { child } = await h.open(saved, h.manager, false, true);
    expect(h.manager.getBranch()).toEqual(before);
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

  it("restores header-only history with SDK defaults without replacing its identity", async () => {
    const h = await harness();
    const settingsFile = path.join(h.cwd, ".pi", "settings.json");
    await writeFile(
      settingsFile,
      JSON.stringify({
        ...JSON.parse(await readFile(settingsFile, "utf8")),
        defaultProvider: "policy-test",
        defaultModel: "policy-model",
        defaultThinkingLevel: "low",
      }),
    );
    const identity = {
      sessionId: h.manager.getSessionId(),
      sessionFile: h.manager.getSessionFile()!,
    };
    const before = await readFile(identity.sessionFile, "utf8");
    expect(h.manager.getEntries()).toEqual([]);
    await expect(
      h.factory.openSessionManager({ ...identity, sessionId: "wrong-identity" }),
    ).rejects.toMatchObject({ code: "SESSION_HISTORY_UNAVAILABLE" });
    expect(await readFile(identity.sessionFile, "utf8")).toBe(before);

    const restored = await h.factory.openSessionManager(identity);
    const role = resolveAgentDefinition(h.registry);
    const { child } = await h.open(role, restored, false, true);
    expect(child.session.model?.provider).toBe("policy-test");
    expect(child.session.model?.id).toBe("policy-model");
    expect(child.actualThinking).toBe("low");
    expect(child.session.sessionManager).toBe(restored);
    expect(restored.getSessionId()).toBe(identity.sessionId);
    expect(restored.getSessionFile()).toBe(identity.sessionFile);
    expect(restored.getHeader()?.cwd).toBe(h.cwd);
    expect(child.session.messages).toEqual([]);
    expect(child.session.systemPrompt).toContain(role.prompt);
    expectExcluded(child, ["subagent", "ask_subagent"]);
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
    },
  );

  it("defers unknown selectors and pending MCP tool selection to the SDK", async () => {
    const h = await harness(true);
    // The fixture registers this MCP name only during session_start, not factory load.
    const { child } = await h.open({
      ...resolveAgentDefinition(h.registry),
      tools: ["read", "absent_tool", "mcp__fixture__late"],
    });
    expect(
      child.session
        .getAllTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["mcp__fixture__late", "read"]);
    expect(child.session.getCallableToolNames()).toContain("mcp__fixture__late");
    expectExcluded(child, ["absent_tool", "mcp__fixture__read", "mcp__fixture__write"]);
  });

  it("remounts the saved denylist while discovering current tools without injecting role messages", async () => {
    const h = await harness();
    const snapshot = {
      ...resolveAgentDefinition(h.registry),
      disallowedTools: ["blocked_extension", "late_blocked"],
    };
    const { child } = await h.open(snapshot);
    seedHistory(h.manager);
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
    const restored = await h.factory.openSessionManager({
      sessionId: h.manager.getSessionId(),
      sessionFile: h.manager.getSessionFile()!,
    });
    const before = restored.getBranch();
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user", content: "original task" }),
        }),
      ]),
    );
    const { child: remounted } = await h.open(snapshot, restored, false, true);
    expect(remounted.session.sessionManager.getSessionId()).toBe(h.manager.getSessionId());
    expect(remounted.session.model?.provider).toBe("policy-test");
    expect(remounted.session.model?.id).toBe("policy-model");
    expect(remounted.actualThinking).toBe("off");
    expectExcluded(remounted, snapshot.disallowedTools);
    expect(remounted.session.getAllTools().map((tool) => tool.name)).toContain("current_tool");
    expect(remounted.session.systemPrompt).toContain(snapshot.prompt);
    expect(remounted.session.systemPrompt).not.toContain("replacement prompt");
    expect(restored.getBranch()).toEqual(before);
  });
});
