import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentTypeRegistry, resolveAgentDefinition } from "../../src/agents.js";
import { ChildSessionFactory, type OpenedChild } from "../../src/child-session.js";
import type { DelegationRuntimeApi } from "../../src/tools.js";
import type { Agent } from "../../src/types.js";
import { RootUiBroker } from "../../src/ui.js";

const directories: string[] = [];
const children: OpenedChild[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fixture = fileURLToPath(new URL("../fixtures/builtin-mcp-server.mjs", import.meta.url));

afterEach(async () => {
  try {
    await Promise.all(children.splice(0).map((child) => child.dispose()));
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  }
});

async function harness(settings: Record<string, unknown> = {}, withMcp = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-builtins-"));
  directories.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const extensions = path.join(cwd, ".pi", "extensions");
  const connectionLog = path.join(root, "mcp-connections.log");
  await Promise.all([mkdir(extensions, { recursive: true }), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({ cacheWarming: "off", ...settings }),
  );
  // Only selection/authentication is needed to open a real SDK session. No prompt or model call.
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "builtin-test": {
          api: "openai-completions",
          apiKey: "local-test-only",
          baseUrl: "https://unused.invalid",
          models: [
            {
              id: "unused-model",
              name: "Never called",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 10000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  if (withMcp) {
    await writeFile(
      path.join(cwd, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [fixture, connectionLog], timeout: 5 },
        },
      }),
    );
  }
  const broker = new RootUiBroker({} as ConstructorParameters<typeof RootUiBroker>[0], false, 100);
  const factory = new ChildSessionFactory(
    agentDir,
    path.join(root, "own-extension.js"),
    broker,
    async () => true,
  );
  const open = async () => {
    const manager = await factory.createSessionManager(cwd);
    const registry = await loadAgentTypeRegistry(agentDir, cwd);
    const roleSnapshot = resolveAgentDefinition(registry);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    const callerAgent: Agent = {
      name: "builtins",
      identity: { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()! },
      roleSnapshot,
      parent: null,
      children: new Map(),
      state: "opening",
      cwd,
    };
    const child = await factory.open({
      name: "builtins",
      roleSnapshot,
      cwd,
      depth: 1,
      ancestorCwds: [cwd],
      callerAgent,
      runtime: {} as DelegationRuntimeApi,
      canDelegate: false,
      sessionManager: manager,
      model: modelRuntime.getModel("builtin-test", "unused-model")!,
      thinking: "off",
    });
    children.push(child);
    return child;
  };
  return { extensions, connectionLog, open };
}

async function execute(child: OpenedChild, name: string, args: Record<string, string>) {
  const tool = child.session.agent.state.tools.find((candidate) => candidate.name === name);
  expect(tool, `${name} should be declared in the real SDK tool registry`).toBeDefined();
  const callId = `builtin-test-${name}`;
  const model = child.session.model!;
  // Nested calls require an issuing assistant message in the SDK pipeline. Seed it
  // locally instead of calling a model, then execute the real registered tool.
  child.session.agent.state.messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  return tool!.execute(callId, args);
}

function text(result: Awaited<ReturnType<typeof execute>>) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function expectNoConnection(child: OpenedChild, connectionLog: string) {
  // Drain the session-start/shutdown lifecycle before checking: no arbitrary startup sleep.
  await child.dispose();
  children.splice(children.indexOf(child), 1);
  await expect(access(connectionLog)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("child built-in extensions through the real SDK", () => {
  it("loads codemode enabled by defaultTools and executes JavaScript", async () => {
    const h = await harness({ defaultTools: ["+codemode"] });
    const child = await h.open();
    expect(child.session.getActiveToolNames()).toContain("codemode");
    const result = await execute(child, "codemode", { code: 'text("child-code:" + (6 * 7));' });
    expect(text(result)).toContain("Script completed");
    expect(text(result)).toContain("child-code:42");
  });

  it("connects MCP with default codemode exposure, discovers and calls its tool", async () => {
    const h = await harness({}, true);
    const child = await h.open();
    await expect
      .poll(() => child.session.getActiveToolNames(), { timeout: 10000 })
      .toContain("codemode");
    expect(child.session.getActiveToolNames()).not.toContain("mcp__fixture__echo");
    // We execute the registered tool directly, without prompting a model. Wait for the
    // background session_start connection to publish its tools first.
    await expect
      .poll(() => child.session.getCallableToolNames(), { timeout: 10000 })
      .toContain("mcp__fixture__echo");
    const result = await execute(child, "codemode", {
      code: `const found = await searchTools("echo", { namespace: "fixture" });
text(found.map(tool => tool.name));
text(await tools.mcp__fixture__echo({ message: "from-child" }));`,
    });
    expect(text(result)).toContain("Script completed");
    expect(text(result)).toContain("mcp__fixture__echo");
    expect(text(result)).toContain("fixture:from-child");
    expect(child.session.getCallableToolNames()).toContain("mcp__fixture__echo");
    expect(await readFile(h.connectionLog, "utf8")).toContain("tools/call");
  });

  it("honors disabled built-ins without starting the configured MCP server", async () => {
    const h = await harness(
      {
        defaultTools: ["+codemode", "+tool_search"],
        extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"],
      },
      true,
    );
    const child = await h.open();
    const names = child.session.getAllTools().map((tool) => tool.name);
    expect(names).not.toContain("codemode");
    expect(names).not.toContain("tool_search");
    expect(names).not.toContain("mcp__fixture__echo");
    await expectNoConnection(child, h.connectionLog);
  });

  it.each(["codemode", "tool_search"])(
    "lets a third-party %s replace the SDK built-in without conflicts",
    async (name) => {
      const h = await harness({ defaultTools: [`+${name}`] });
      await writeFile(
        path.join(h.extensions, "replacement.js"),
        `export default function(pi) {
  pi.registerTool({
    name: ${JSON.stringify(name)}, label: "replacement", description: "third-party replacement",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "replacement:${name}" }], details: {} }),
  });
}`,
      );
      const child = await h.open();
      expect(child.session.resourceLoader.getExtensions().errors).toEqual([]);
      expect(child.session.getAllTools().filter((tool) => tool.name === name)).toHaveLength(1);
      expect(text(await execute(child, name, {}))).toBe(`replacement:${name}`);
      const loaded = child.session.resourceLoader.getExtensions().extensions;
      const builtinName = name === "tool_search" ? "tool-search" : name;
      expect(loaded.some((extension) => extension.path === `builtin:${builtinName}`)).toBe(false);
    },
  );

  it("lets a third-party /mcp replace built-in MCP without connecting its configured server", async () => {
    const h = await harness({}, true);
    await copyFile(
      fileURLToPath(new URL("../fixtures/replacement-mcp-extension.js", import.meta.url)),
      path.join(h.extensions, "replacement-mcp.js"),
    );
    const child = await h.open();
    const loaded = child.session.resourceLoader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.some((extension) => extension.path === "builtin:mcp")).toBe(false);
    expect(loaded.extensions.some((extension) => extension.commands.has("mcp"))).toBe(true);
    expect(text(await execute(child, "replacement_mcp_probe", {}))).toBe("third-party MCP");
    await expectNoConnection(child, h.connectionLog);
  });
});
