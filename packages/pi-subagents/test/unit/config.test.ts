import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandConfiguredHome, loadSubagentsConfig } from "../../src/config.js";
import { SubagentError } from "../../src/errors.js";
import { resolveToolCwd } from "../../src/paths.js";
import type { DelegationContext } from "../../src/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("external_directory config", () => {
  it("expands only supported home forms", () => {
    expect(expandConfiguredHome("~", "/home/test")).toBe("/home/test");
    expect(expandConfiguredHome("~/code", "/home/test")).toBe("/home/test/code");
    expect(expandConfiguredHome("$HOME/code", "/home/test")).toBe("/home/test/code");
    expect(expandConfiguredHome("$" + "{HOME}/code", "/home/test")).toBe("/home/test/code");
    expect(expandConfiguredHome("$OTHER/code", "/home/test")).toBe("$OTHER/code");
  });

  it("initializes project-local storage and uses defaults without setting.json", async () => {
    const cwd = await temporaryDirectory();
    const config = await loadSubagentsConfig(cwd);
    expect(config).toMatchObject({
      externalDirectories: [],
      maxDepth: 4,
      maxLiveAgents: 8,
      uiTimeoutMs: 120_000,
      projectRoot: cwd,
      storageDirectory: path.join(cwd, ".pi", "subagents"),
    });
    await expect(readFile(path.join(config.storageDirectory, ".gitignore"), "utf8")).resolves.toBe(
      "/sessions/\n",
    );
  });

  it("reads only project-local setting.json and rejects relative configured directories", async () => {
    const cwd = await temporaryDirectory();
    const configDirectory = path.join(cwd, ".pi", "subagents");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "setting.json"),
      JSON.stringify({ external_directory: ["../other"] }),
    );
    await expect(loadSubagentsConfig(cwd)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("loads project settings from .pi/subagents/setting.json", async () => {
    const cwd = await temporaryDirectory();
    const external = await temporaryDirectory();
    const configDirectory = path.join(cwd, ".pi", "subagents");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "setting.json"),
      JSON.stringify({
        external_directory: [external],
        max_depth: 6,
        max_live_agents: 3,
        ui_timeout_ms: 500,
      }),
    );
    await expect(loadSubagentsConfig(cwd)).resolves.toMatchObject({
      externalDirectories: [external],
      maxDepth: 6,
      maxLiveAgents: 3,
      uiTimeoutMs: 500,
    });
  });

  it("rejects a symlinked project setting", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const configDirectory = path.join(cwd, ".pi", "subagents");
    await mkdir(configDirectory, { recursive: true });
    const target = path.join(outside, "setting.json");
    await writeFile(target, "{}\n");
    await symlink(target, path.join(configDirectory, "setting.json"));
    await expect(loadSubagentsConfig(cwd)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("does not read the legacy project config path", async () => {
    const cwd = await temporaryDirectory();
    const legacyDirectory = path.join(cwd, ".pi", "extensions");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(
      path.join(legacyDirectory, "pi-subagents.json"),
      JSON.stringify({ max_depth: 99 }),
    );
    await expect(loadSubagentsConfig(cwd)).resolves.toMatchObject({ maxDepth: 4 });
  });
});

describe("tool cwd authorization", () => {
  it("uses caller cwd when omitted and rejects relative paths", async () => {
    const cwd = await temporaryDirectory();
    const context: DelegationContext = {
      cwd,
      projectRoot: cwd,
      externalDirectories: [],
      agentTypes: new Map(),
    };
    await expect(resolveToolCwd(undefined, context)).resolves.toEqual({ cwd, kind: "same" });
    await expect(resolveToolCwd(".", context)).rejects.toBeInstanceOf(SubagentError);
    await expect(resolveToolCwd("~/code", context)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("matches exact canonical directories rather than descendants or prefixes", async () => {
    const cwd = await temporaryDirectory();
    const external = await temporaryDirectory();
    const child = path.join(external, "child");
    const adjacent = `${external}-other`;
    await mkdir(child);
    await mkdir(adjacent);
    temporaryDirectories.push(adjacent);
    const context: DelegationContext = {
      cwd,
      projectRoot: cwd,
      externalDirectories: [external],
      agentTypes: new Map(),
    };
    await expect(resolveToolCwd(external, context)).resolves.toEqual({
      cwd: external,
      kind: "external",
    });
    await expect(resolveToolCwd(child, context)).rejects.toMatchObject({ code: "CWD_NOT_ALLOWED" });
    await expect(resolveToolCwd(adjacent, context)).rejects.toMatchObject({
      code: "CWD_NOT_ALLOWED",
    });
  });

  it("accepts a symlink resolving to a configured canonical directory", async () => {
    const cwd = await temporaryDirectory();
    const external = await temporaryDirectory();
    const linkParent = await temporaryDirectory();
    const link = path.join(linkParent, "external-link");
    await symlink(external, link, "dir");
    const context: DelegationContext = {
      cwd,
      projectRoot: cwd,
      externalDirectories: [external],
      agentTypes: new Map(),
    };
    await expect(resolveToolCwd(link, context)).resolves.toEqual({
      cwd: external,
      kind: "external",
    });
  });
});
