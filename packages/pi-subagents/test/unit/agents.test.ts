import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentTypeRegistry, resolveAgentDefinition } from "../../src/agents.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-agents-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeAgent(directory: string, id: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.md`), content);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("AgentTypeRegistry", () => {
  it("loads built-in, global, then current-project definitions as full overrides", async () => {
    const agentDir = await temporaryDirectory();
    const projectRoot = await temporaryDirectory();
    await writeAgent(
      path.join(agentDir, "agents"),
      "explore",
      `---\nname: explore\ndescription: global\ntools: [read, bash]\n---\nglobal prompt`,
    );
    await writeAgent(
      path.join(projectRoot, ".pi", "agents"),
      "explore",
      `---\nname: explore\ndescription: project\n---\nproject prompt`,
    );
    await writeAgent(
      path.join(projectRoot, ".pi", "agents"),
      "tester",
      `---\nname: tester\ndescription: tests\n---\ntest prompt`,
    );

    const registry = await loadAgentTypeRegistry(agentDir, projectRoot);
    expect(registry.get("general")).toBeDefined();
    expect(registry.get("explore")).toMatchObject({
      description: "project",
      prompt: "project prompt",
    });
    expect(registry.get("explore")?.tools).toBeUndefined();
    expect(registry.get("tester")?.description).toBe("tests");
  });

  it("keeps the built-in explore read-only by default", async () => {
    const registry = await loadAgentTypeRegistry(
      await temporaryDirectory(),
      await temporaryDirectory(),
    );
    expect(registry.get("explore")?.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("accepts only the supported thinking levels in frontmatter", async () => {
    const agentDir = await temporaryDirectory();
    const projectRoot = await temporaryDirectory();
    const agentsDir = path.join(projectRoot, ".pi", "agents");
    await writeAgent(
      agentsDir,
      "reviewer",
      `---\nname: reviewer\ndescription: reviews\nthinking: high\n---\nreview prompt`,
    );
    const registry = await loadAgentTypeRegistry(agentDir, projectRoot);
    expect(registry.get("reviewer")?.thinking).toBe("high");

    await writeAgent(
      agentsDir,
      "legacy",
      `---\nname: legacy\ndescription: legacy\nthinking: xhigh\n---\nlegacy prompt`,
    );
    await expect(loadAgentTypeRegistry(agentDir, projectRoot)).rejects.toThrow(
      /Invalid thinking level 'xhigh'.*allowed values: off, low, medium, high, max/,
    );
  });

  it("returns a detached snapshot and lists caller roles for unknown ids", async () => {
    const registry = await loadAgentTypeRegistry(
      await temporaryDirectory(),
      await temporaryDirectory(),
    );
    const snapshot = resolveAgentDefinition(registry, "general");
    snapshot.prompt = "changed";
    expect(registry.get("general")?.prompt).not.toBe("changed");
    expect(() => resolveAgentDefinition(registry, "missing")).toThrow(
      /Available: explore, general/,
    );
  });
});
