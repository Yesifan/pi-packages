import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildSessionFactory,
  type OpenChildOptions,
  type OpenedChild,
} from "../../src/child-session.js";
import type { DelegationRuntimeApi } from "../../src/tools.js";
import type {
  Agent,
  AgentDefinitionSnapshot,
  SessionIdentity,
  ThinkingLevel,
} from "../../src/types.js";
import { RootUiBroker } from "../../src/ui.js";

// Keep real SDK services; wrap only the factory export to inspect/perturb its result.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof sdk>();
  return { ...actual, createAgentSession: vi.fn(actual.createAgentSession) };
});

const temporaryDirectories: string[] = [];
const children: OpenedChild[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const roleSnapshot: AgentDefinitionSnapshot = {
  id: "general",
  prompt: "Saved role prompt",
  source: "/saved/agents/general.md",
  contentHash: "saved-hash",
};

afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof sdk>("@earendil-works/pi-coding-agent");
  vi.mocked(sdk.createAgentSession).mockReset().mockImplementation(actual.createAgentSession);
  await Promise.all(children.splice(0).map((child) => child.dispose()));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function identity(manager: sdk.SessionManager): SessionIdentity {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Expected persistent session");
  return { sessionId: manager.getSessionId(), sessionFile };
}

async function harness(trusted = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-subagents-child-session-")));
  temporaryDirectories.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(path.join(cwd, ".pi"), { recursive: true }), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const models = ["a", "b", "plain"].map((id) => ({
    id,
    name: id,
    reasoning: id !== "plain",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  }));
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "child-test": {
          api: "openai-completions",
          apiKey: "unit-test-only",
          baseUrl: "https://unused.invalid",
          models,
        },
        "child-no-auth": { api: "openai-completions", baseUrl: "https://unused.invalid", models },
      },
    }),
  );
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      defaultProvider: "child-test",
      defaultModel: "b",
      defaultThinkingLevel: "low",
      cacheWarming: "off",
    }),
  );
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel("child-test", "a");
  if (!model) throw new Error("Missing fixture model");
  const broker = new RootUiBroker({} as ConstructorParameters<typeof RootUiBroker>[0], false, 100);
  const ownExtension = path.join(cwd, ".pi", "extensions", "own.js");
  const resolveTrust = vi.fn(async () => trusted);
  const factory = new ChildSessionFactory(agentDir, ownExtension, broker, resolveTrust);
  const callerAgent: Agent = {
    name: "worker",
    roleSnapshot,
    parent: null,
    children: new Map(),
    state: "opening",
    cwd,
  };
  const open = async (manager: sdk.SessionManager, overrides: Partial<OpenChildOptions> = {}) => {
    const child = await factory.open({
      name: "worker",
      roleSnapshot,
      cwd,
      depth: 1,
      ancestorCwds: [cwd],
      runtime: { getMaxLiveAgents: () => 8 } as DelegationRuntimeApi,
      callerAgent,
      canDelegate: false,
      sessionManager: manager,
      model,
      thinking: "high",
      ...overrides,
    });
    children.push(child);
    return child;
  };
  return {
    root,
    cwd,
    agentDir,
    model,
    modelRuntime,
    broker,
    ownExtension,
    factory,
    resolveTrust,
    open,
  };
}

function addHistory(
  manager: sdk.SessionManager,
  provider = "child-test",
  model = "a",
  thinking: ThinkingLevel = "high",
) {
  manager.appendModelChange(provider, model);
  manager.appendThinkingLevelChange(thinking);
  manager.appendMessage({ role: "user", content: "Child's own task", timestamp: Date.now() });
}

function physicalReply(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Child reply" }],
    api: "openai-completions",
    provider: "child-test",
    model: "a",
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
  };
}

describe("ChildSessionFactory session history", () => {
  it("uses the SDK allocated cwd directory, private valid header, and opened actual identity", async () => {
    const h = await harness();
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(h.root, "env-override");
    await writeFile(
      path.join(h.agentDir, "settings.json"),
      JSON.stringify({ sessionDir: path.join(h.root, "global-override") }),
    );
    await writeFile(
      path.join(h.cwd, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: path.join(h.root, "project-override") }),
    );
    const create = vi.spyOn(sdk.SessionManager, "create");
    const sdkOpen = vi.spyOn(sdk.SessionManager, "open");
    const manager = await h.factory.createSessionManager(h.cwd);
    expect(create).toHaveBeenCalledWith(h.cwd);
    const allocated = create.mock.results[0]?.value as sdk.SessionManager;
    const saved = identity(manager);
    expect(saved.sessionFile).toBe(allocated.getSessionFile());
    expect(path.dirname(saved.sessionFile)).toBe(allocated.getSessionDir());
    expect(saved.sessionFile.startsWith(path.join(h.agentDir, "sessions") + path.sep)).toBe(true);
    expect(sdkOpen).toHaveBeenCalledWith(saved.sessionFile, path.dirname(saved.sessionFile), h.cwd);
    expect(saved.sessionId).not.toBe(allocated.getSessionId());
    const header = JSON.parse(await readFile(saved.sessionFile, "utf8"));
    expect(header).toMatchObject({ type: "session", id: saved.sessionId, cwd: h.cwd, version: 3 });
    expect(manager.getCwd()).toBe(h.cwd);
    if (process.platform !== "win32") {
      expect((await stat(saved.sessionFile)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(saved.sessionFile))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(h.agentDir, "sessions"))).mode & 0o777).toBe(0o700);
    }
    expect((await h.factory.openSessionManager(saved)).getSessionId()).toBe(saved.sessionId);
    // D3: header-only children remain discoverable; no filtering or timestamp hiding.
    expect((await sdk.SessionManager.list(h.cwd)).map((entry) => entry.id)).toContain(
      saved.sessionId,
    );
  });

  it.each(["agent", "sessions", "cwd-group"])(
    "rejects a preexisting %s directory symlink before SDK allocation writes outside history",
    async (target) => {
      const h = await harness();
      const outside = path.join(h.root, "outside");
      await mkdir(outside);
      let directory = h.agentDir;
      if (target === "sessions") directory = path.join(h.agentDir, "sessions");
      if (target === "cwd-group") {
        // Obtain the grouping from the public SDK, never reproduce its cwd encoding.
        directory = sdk.SessionManager.create(h.cwd).getSessionDir();
      }
      await rm(directory, { recursive: true, force: true });
      await symlink(outside, directory, "dir");
      const create = vi.spyOn(sdk.SessionManager, "create");
      const sdkOpen = vi.spyOn(sdk.SessionManager, "open");
      await expect(h.factory.createSessionManager(h.cwd)).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
      expect(create).not.toHaveBeenCalled();
      expect(sdkOpen).not.toHaveBeenCalled();
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it.each(["agent", "sessions"])(
    "rejects a non-directory %s ancestor before SDK allocation",
    async (target) => {
      const h = await harness();
      const directory = target === "agent" ? h.agentDir : path.join(h.agentDir, "sessions");
      await rm(directory, { recursive: true, force: true });
      await writeFile(directory, "not a directory");
      const create = vi.spyOn(sdk.SessionManager, "create");
      await expect(h.factory.createSessionManager(h.cwd)).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
      expect(create).not.toHaveBeenCalled();
      expect(await readFile(directory, "utf8")).toBe("not a directory");
    },
  );

  it("preserves existing directory permissions and permits unrelated ordinary files in sessions", async () => {
    const h = await harness();
    const existingGroup = sdk.SessionManager.create(h.cwd).getSessionDir();
    const before = (await stat(existingGroup)).mode;
    const unrelated = path.join(h.agentDir, "sessions", "unrelated.jsonl");
    await writeFile(unrelated, "existing history");
    const manager = await h.factory.createSessionManager(h.cwd);
    expect(manager.getSessionDir()).toBe(existingGroup);
    expect((await stat(existingGroup)).mode).toBe(before);
    expect(await readFile(unrelated, "utf8")).toBe("existing history");
  });

  it("uses SDK normalization for a relative agentDir and initializes missing directories privately", async () => {
    const h = await harness();
    const agentDir = path.join(h.root, "new", "agent");
    process.env.PI_CODING_AGENT_DIR = path.relative(process.cwd(), agentDir);
    const manager = await h.factory.createSessionManager(h.cwd);
    expect(
      identity(manager).sessionFile.startsWith(path.join(agentDir, "sessions") + path.sep),
    ).toBe(true);
    expect(await h.factory.openSessionManager(identity(manager))).toBeInstanceOf(
      sdk.SessionManager,
    );
    if (process.platform !== "win32") {
      for (const directory of [
        path.dirname(agentDir),
        agentDir,
        path.join(agentDir, "sessions"),
        manager.getSessionDir(),
      ])
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects wrong identity before calling SDK open and never rewrites history", async () => {
    const h = await harness();
    const saved = identity(await h.factory.createSessionManager(h.cwd));
    const before = await readFile(saved.sessionFile, "utf8");
    const sdkOpen = vi.spyOn(sdk.SessionManager, "open");
    await expect(
      h.factory.openSessionManager({ ...saved, sessionId: "wrong" }),
    ).rejects.toMatchObject({ code: "SESSION_HISTORY_UNAVAILABLE" });
    expect(sdkOpen).not.toHaveBeenCalled();
    expect(await readFile(saved.sessionFile, "utf8")).toBe(before);
  });

  it.each(["", "\n  \n", "not json\n", '{"type":"message","id":"wrong"}\n', "null\n"])(
    "rejects empty/malformed history %j without creating a replacement",
    async (content) => {
      const h = await harness();
      const sessionFile = path.join(h.root, "bad.jsonl");
      await writeFile(sessionFile, content);
      const sdkOpen = vi.spyOn(sdk.SessionManager, "open");
      await expect(
        h.factory.openSessionManager({ sessionId: "expected", sessionFile }),
      ).rejects.toMatchObject({ code: "SESSION_HISTORY_UNAVAILABLE" });
      expect(sdkOpen).not.toHaveBeenCalled();
      expect(await readFile(sessionFile, "utf8")).toBe(content);
    },
  );

  it("rejects missing, directory and symlink histories", async () => {
    const h = await harness();
    const saved = identity(await h.factory.createSessionManager(h.cwd));
    const link = path.join(h.root, "link.jsonl");
    await symlink(saved.sessionFile, link);
    const directoryLink = path.join(h.root, "linked-sessions");
    await symlink(path.dirname(saved.sessionFile), directoryLink, "dir");
    const sdkOpen = vi.spyOn(sdk.SessionManager, "open");
    for (const sessionFile of [
      path.join(h.root, "missing.jsonl"),
      h.cwd,
      link,
      path.join(directoryLink, path.basename(saved.sessionFile)),
    ]) {
      await expect(h.factory.openSessionManager({ ...saved, sessionFile })).rejects.toMatchObject({
        code: "SESSION_HISTORY_UNAVAILABLE",
      });
    }
    expect(sdkOpen).not.toHaveBeenCalled();
    await expect(stat(path.join(h.root, "missing.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects missing, non-directory, relative and noncanonical header cwds before SDK open", async () => {
    const h = await harness();
    const saved = identity(await h.factory.createSessionManager(h.cwd));
    const header = JSON.parse(await readFile(saved.sessionFile, "utf8"));
    const cwdLink = path.join(h.root, "cwd-link");
    await symlink(h.cwd, cwdLink, "dir");
    const sdkOpen = vi.spyOn(sdk.SessionManager, "open");
    for (const cwd of [
      path.join(h.root, "missing"),
      saved.sessionFile,
      "relative",
      cwdLink,
      `${h.cwd}${path.sep}`,
    ]) {
      const content = `${JSON.stringify({ ...header, cwd })}\n`;
      await writeFile(saved.sessionFile, content);
      await expect(h.factory.openSessionManager(saved)).rejects.toMatchObject({
        code: "SESSION_HISTORY_UNAVAILABLE",
      });
      expect(await readFile(saved.sessionFile, "utf8")).toBe(content);
    }
    expect(sdkOpen).not.toHaveBeenCalled();
  });

  it("verifies SDK identity/cwd again after opening", async () => {
    const h = await harness();
    const saved = identity(await h.factory.createSessionManager(h.cwd));
    vi.spyOn(sdk.SessionManager, "open").mockReturnValue(sdk.SessionManager.inMemory(h.root));
    await expect(h.factory.openSessionManager(saved)).rejects.toMatchObject({
      code: "SESSION_HISTORY_UNAVAILABLE",
    });
  });
});

describe("ChildSessionFactory target mounts", () => {
  it("creates with explicit parent selection, its own history, and actual Pi ID as UI owner", async () => {
    const h = await harness();
    const manager = await h.factory.createSessionManager(h.cwd);
    const proxy = vi.spyOn(h.broker, "proxy");
    const child = await h.open(manager);
    expect(child.session.model?.id).toBe("a");
    expect(child.actualThinking).toBe("high");
    expect(manager.getBranch().map((entry) => entry.type)).toEqual([
      "model_change",
      "thinking_level_change",
    ]);
    expect(manager.buildSessionContext().messages).toEqual([]);
    expect(proxy).toHaveBeenCalledWith(manager.getSessionId(), "worker");
    expect(child.session.systemPrompt).toContain(roleSnapshot.prompt);
  });

  it("rejects a missing parent model or target authentication at creation", async () => {
    const h = await harness();
    const manager = await h.factory.createSessionManager(h.cwd);
    await expect(h.open(manager, { model: undefined })).rejects.toMatchObject({
      code: "PARENT_MODEL_UNAVAILABLE",
    });
    await expect(
      h.open(manager, { model: h.modelRuntime.getModel("child-no-auth", "a") }),
    ).rejects.toMatchObject({ code: "MODEL_AUTH_UNAVAILABLE" });
    expect(manager.getEntries()).toEqual([]);
  });

  it("restores historical model/thinking without overrides, settings fallback, or new role messages", async () => {
    const h = await harness();
    const manager = await h.factory.createSessionManager(h.cwd);
    const first = await h.open(manager);
    manager.appendMessage({
      role: "user",
      content: "task cancelled before reply",
      timestamp: Date.now(),
    });
    first.session.dispose();
    await mkdir(path.join(h.cwd, ".pi", "agents"));
    await writeFile(
      path.join(h.cwd, ".pi", "agents", "general.md"),
      "Current role must NOT replace saved role",
    );
    await writeFile(path.join(h.cwd, "AGENTS.md"), "Current target instructions");
    const restoredManager = await h.factory.openSessionManager(identity(manager));
    const before = restoredManager.getEntries();
    const create = vi.spyOn(sdk, "createAgentSession");
    create.mockClear();
    const child = await h.open(restoredManager, {
      restoring: true,
      model: h.modelRuntime.getModel("child-test", "b"),
      thinking: "off",
    });
    const supplied = create.mock.calls[0]?.[0];
    expect(supplied).not.toHaveProperty("model");
    expect(supplied).not.toHaveProperty("thinkingLevel");
    expect(child.session.model?.id).toBe("a");
    expect(child.actualThinking).toBe("high");
    expect(child.session.systemPrompt).toContain("Current target instructions");
    expect(child.session.systemPrompt).toContain(roleSnapshot.prompt);
    expect(child.session.systemPrompt).not.toContain("Current role must NOT replace saved role");
    expect(restoredManager.getEntries()).toEqual(before);
    expect(child.session.messages).toEqual(restoredManager.buildSessionContext().messages);
  });

  it.each(["header-only", "setup-only", "missing-model", "missing-thinking", "invalid-thinking"])(
    "rejects insufficient restoration state: %s before SDK factory fallback",
    async (scenario) => {
      const h = await harness();
      const manager = await h.factory.createSessionManager(h.cwd);
      if (scenario !== "header-only" && scenario !== "missing-model")
        manager.appendModelChange("child-test", "a");
      if (scenario !== "header-only" && scenario !== "missing-thinking")
        manager.appendThinkingLevelChange(
          scenario === "invalid-thinking" ? ("bogus" as ThinkingLevel) : "high",
        );
      if (scenario !== "header-only" && scenario !== "setup-only")
        manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
      const before = manager.getEntries();
      const create = vi.spyOn(sdk, "createAgentSession");
      await expect(h.open(manager, { restoring: true })).rejects.toMatchObject({
        code: scenario === "missing-model" ? "MODEL_UNAVAILABLE" : "SESSION_HISTORY_UNAVAILABLE",
      });
      expect(create).not.toHaveBeenCalled();
      expect(manager.getEntries()).toEqual(before);
    },
  );

  it.each([
    ["absent-provider", "a", "MODEL_UNAVAILABLE"],
    ["child-test", "absent-model", "MODEL_UNAVAILABLE"],
    ["child-no-auth", "a", "MODEL_AUTH_UNAVAILABLE"],
  ])("rejects historical model/auth unavailability: %s/%s", async (provider, model, code) => {
    const h = await harness();
    const manager = await h.factory.createSessionManager(h.cwd);
    addHistory(manager, provider, model);
    const create = vi.spyOn(sdk, "createAgentSession");
    await expect(h.open(manager, { restoring: true })).rejects.toMatchObject({ code });
    expect(create).not.toHaveBeenCalled();
  });

  it("uses the latest physical response unless a registered virtual model_change holds", async () => {
    const h = await harness();
    const physical = await h.factory.createSessionManager(h.cwd);
    addHistory(physical, "child-test", "b");
    physical.appendMessage(physicalReply());
    expect((await h.open(physical, { restoring: true })).session.model?.id).toBe("a");
    const extensions = path.dirname(h.ownExtension);
    await mkdir(extensions);
    await writeFile(
      path.join(extensions, "virtual.js"),
      `export default function(pi) {
      pi.registerVirtualModel({ provider: "child-router", id: "auto", name: "Auto", thinkingLevels: ["low", "high"],
        route: () => { throw new Error("No model requests in this test"); } });
    }`,
    );
    const virtual = await h.factory.createSessionManager(h.cwd);
    addHistory(virtual, "child-router", "auto");
    virtual.appendMessage(physicalReply());
    expect(virtual.buildSessionContext().model?.modelId).toBe("a");
    const child = await h.open(virtual, { restoring: true });
    expect(child.session.model?.provider).toBe("child-router");
    expect(child.session.model?.id).toBe("auto");
    expect(child.actualThinking).toBe("high");
  });

  it("allows legitimate thinking clamp during restoration", async () => {
    const h = await harness();
    const manager = await h.factory.createSessionManager(h.cwd);
    addHistory(manager, "child-test", "plain", "high");
    expect((await h.open(manager, { restoring: true })).actualThinking).toBe("off");
  });

  it.each(["fallback", "model-mismatch", "thinking-mismatch"])(
    "rejects an SDK restoration discrepancy: %s",
    async (scenario) => {
      const h = await harness();
      const manager = await h.factory.createSessionManager(h.cwd);
      addHistory(manager);
      const { createAgentSession: realCreate } = await vi.importActual<typeof sdk>(
        "@earendil-works/pi-coding-agent",
      );
      const dispose = vi.fn();
      vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options) => {
        const result = await realCreate(options);
        const realDispose = result.session.dispose.bind(result.session);
        vi.spyOn(result.session, "dispose").mockImplementation(() => {
          dispose();
          realDispose();
        });
        if (scenario === "model-mismatch")
          result.session.agent.state.model = h.modelRuntime.getModel("child-test", "b")!;
        if (scenario === "thinking-mismatch") result.session.agent.state.thinkingLevel = "low";
        return {
          ...result,
          ...(scenario === "fallback" ? { modelFallbackMessage: "Unexpected fallback" } : {}),
        };
      });
      await expect(h.open(manager, { restoring: true })).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
      });
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("checks trust before loading target extensions", async () => {
    const h = await harness(false);
    await mkdir(path.dirname(h.ownExtension));
    const marker = path.join(h.root, "extension-executed");
    await writeFile(
      path.join(path.dirname(h.ownExtension), "untrusted.js"),
      `import {writeFileSync} from "node:fs"; export default function() {writeFileSync(${JSON.stringify(marker)}, "loaded");}`,
    );
    await expect(h.open(await h.factory.createSessionManager(h.cwd))).rejects.toMatchObject({
      code: "PROJECT_NOT_TRUSTED",
    });
    expect(h.resolveTrust).toHaveBeenCalledWith(h.cwd);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("filters its own extension and preserves dynamic exclusions/current tools on remount", async () => {
    const h = await harness();
    const extensions = path.dirname(h.ownExtension);
    await mkdir(extensions);
    await writeFile(
      h.ownExtension,
      `export default function(pi) {pi.registerTool({name:"own_tool",label:"own",description:"own",parameters:{type:"object"},execute:async()=>({content:[],details:{}})});}`,
    );
    const currentExtension = path.join(extensions, "current.js");
    const script = (allowed: string) => `export default function(pi) {
      const register = name => pi.registerTool({name,label:name,description:name,parameters:{type:"object"},execute:async()=>({content:[],details:{}})});
      register(${JSON.stringify(allowed)}); register("blocked");
      pi.on("session_start", () => {register("late_blocked"); register("bash"); pi.setActiveTools([${JSON.stringify(allowed)},"blocked","late_blocked","bash","subagent"]);});
    }`;
    await writeFile(currentExtension, script("current_one"));
    const manager = await h.factory.createSessionManager(h.cwd);
    const savedRole = { ...roleSnapshot, disallowedTools: ["blocked", "late_blocked", "bash"] };
    const first = await h.open(manager, { roleSnapshot: savedRole });
    manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
    expect(first.session.getActiveToolNames()).toContain("current_one");
    first.session.dispose();
    await rm(currentExtension);
    await writeFile(path.join(extensions, "current-v2.js"), script("current_two"));
    const child = await h.open(await h.factory.openSessionManager(identity(manager)), {
      restoring: true,
      roleSnapshot: savedRole,
    });
    child.session.setActiveToolsByName([
      "current_two",
      "blocked",
      "late_blocked",
      "bash",
      "subagent",
      "ask_subagent",
      "own_tool",
    ]);
    expect(child.session.getActiveToolNames()).toEqual(["current_two"]);
    const names = child.session.getAllTools().map((tool) => tool.name);
    expect(names).not.toContain("own_tool");
    expect(names).not.toContain("current_one");
    for (const excluded of ["blocked", "late_blocked", "bash", "subagent", "ask_subagent"])
      expect(names).not.toContain(excluded);
  });
});
