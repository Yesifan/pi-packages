import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import piSubagents from "../../src/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Pi extension integration", () => {
  it("registers session-local delegation tools with dynamic cwd and agents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-sdk-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const sessionDirectory = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDirectory)]);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [{ name: "pi-subagents-test", factory: piSubagents }],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.create(cwd, sessionDirectory),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    try {
      await session.bindExtensions({ mode: "print" });
      const tools = session.getAllTools();
      const subagent = tools.find((tool) => tool.name === "subagent");
      const ask = tools.find((tool) => tool.name === "ask_subagent");
      expect(subagent?.description).toContain(`Current cwd:\n- ${cwd}`);
      expect(subagent?.description).toContain("- general: General-purpose task execution.");
      expect(subagent?.description).toContain("- explore: Read-only code exploration.");
      expect(ask).toBeDefined();
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });

  it("does not let trusted subdirectory access an explicitly denied Git root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-sdk-root-trust-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "nested");
    const agentDir = path.join(root, "agent");
    const sessionDirectory = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDirectory)]);
    await execFileAsync("git", ["-C", root, "init", "-q"]);
    new ProjectTrustStore(agentDir).set(root, false);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [{ name: "pi-subagents-test", factory: piSubagents }],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.create(cwd, sessionDirectory),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await expect(stat(path.join(root, ".pi", "subagents"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });

  it("does not initialize project storage before project trust", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-sdk-untrusted-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const sessionDirectory = path.join(root, "sessions");
    await Promise.all([
      mkdir(path.join(cwd, ".pi"), { recursive: true }),
      mkdir(agentDir),
      mkdir(sessionDirectory),
    ]);
    await writeFile(path.join(cwd, ".pi", "settings.json"), "{}\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [{ name: "pi-subagents-test", factory: piSubagents }],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => false });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.create(cwd, sessionDirectory),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await expect(stat(path.join(cwd, ".pi", "subagents"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(session.getAllTools().some((tool) => tool.name === "subagent")).toBe(true);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
});
