import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProjectSubagents } from "../../src/project-storage.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-project-storage-"));
  temporaryDirectories.push(project);
  return project;
}

async function initializeGit(project: string): Promise<void> {
  await execFileAsync("git", ["-C", project, "init", "-q"]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("project subagent storage", () => {
  it("creates the local layout and ignores runtime sessions in Git", async () => {
    const project = await temporaryProject();
    await initializeGit(project);
    const storage = await initializeProjectSubagents(project);
    expect(storage.directory).toBe(path.join(project, ".pi", "subagents"));
    await expect(readFile(path.join(storage.directory, ".gitignore"), "utf8")).resolves.toBe(
      "/sessions/\n",
    );
    await expect(
      execFileAsync("git", [
        "-C",
        project,
        "check-ignore",
        "-q",
        "--no-index",
        "--",
        ".pi/subagents/sessions",
      ]),
    ).resolves.toBeDefined();
  });

  it("does not overwrite an existing gitignore that exposes sessions", async () => {
    const project = await temporaryProject();
    await initializeGit(project);
    const directory = path.join(project, ".pi", "subagents");
    await mkdir(directory, { recursive: true });
    const gitignore = path.join(directory, ".gitignore");
    await writeFile(gitignore, "/other/\n");
    await expect(initializeProjectSubagents(project)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await expect(readFile(gitignore, "utf8")).resolves.toBe("/other/\n");
  });

  it("rejects a later negation that could expose a session file", async () => {
    const project = await temporaryProject();
    await initializeGit(project);
    const directory = path.join(project, ".pi", "subagents");
    await mkdir(path.join(directory, "sessions"), { recursive: true });
    await writeFile(path.join(directory, ".gitignore"), "/sessions/*\n!/sessions/exposed.jsonl\n");
    await expect(initializeProjectSubagents(project)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
  });

  it("rejects session data that is already tracked", async () => {
    const project = await temporaryProject();
    await initializeGit(project);
    const sessions = path.join(project, ".pi", "subagents", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(project, ".pi", "subagents", ".gitignore"), "/sessions/\n");
    await writeFile(path.join(sessions, "tracked.jsonl"), "");
    await execFileAsync("git", [
      "-C",
      project,
      "add",
      "-f",
      ".pi/subagents/sessions/tracked.jsonl",
    ]);
    await expect(initializeProjectSubagents(project)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
  });

  it("fails closed when Git status cannot be inspected", async () => {
    const project = await temporaryProject();
    await initializeGit(project);
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(initializeProjectSubagents(project)).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("rejects a symlinked project storage directory", async () => {
    const project = await temporaryProject();
    const outside = await temporaryProject();
    const piDirectory = path.join(project, ".pi");
    await mkdir(piDirectory);
    await symlink(outside, path.join(piDirectory, "subagents"), "dir");
    await expect(initializeProjectSubagents(project)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
  });
});
