import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  it("rejects relative configured directories", async () => {
    const cwd = await temporaryDirectory();
    const agentDir = await temporaryDirectory();
    const configDirectory = path.join(cwd, ".pi", "extensions");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "pi-subagents.json"),
      JSON.stringify({ external_directory: ["../other"] }),
    );
    await expect(loadSubagentsConfig(cwd, agentDir)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
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
