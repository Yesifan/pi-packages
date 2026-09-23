import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProjectSubagents } from "../../src/project-storage.js";
import { PersistentSubagentStore } from "../../src/store.js";
import type { StoredRun, StoredSubagent } from "../../src/types.js";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-store-"));
  temporaryDirectories.push(project);
  return project;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PersistentSubagentStore", () => {
  it("persists project-local identity and excludes concurrent writers", async () => {
    const project = await temporaryProject();
    const storage = await initializeProjectSubagents(project);
    const rootSessionFile = path.join(project, "root.jsonl");
    const first = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      rootSessionFile,
    );
    const second = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      rootSessionFile,
    );
    await expect(first.open()).resolves.toEqual([]);
    await expect(second.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });

    await first.prepareAgent("sa_test");
    const sessionFile = path.join(first.sessionsDirectory("sa_test"), "child.jsonl");
    const timestamp = new Date().toISOString();
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session", timestamp, cwd: project })}\n`,
    );
    const stored: StoredSubagent = {
      schemaVersion: 2,
      id: "sa_test",
      rootSessionId: "root-id",
      parentAgentId: null,
      name: "test",
      cwd: project,
      ancestorCwds: [project],
      agentType: "general",
      agentDefinitionSnapshot: {
        id: "general",
        prompt: "snapshot",
        source: "/agents/general.md",
        contentHash: "hash",
      },
      depth: 1,
      model: { provider: "test", id: "model" },
      thinking: "off",
      sessionId: "session",
      sessionPath: first.toSessionPath("sa_test", sessionFile),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(path.isAbsolute(stored.sessionPath)).toBe(false);
    await expect(first.resolveSessionPath("sa_test", stored.sessionPath)).resolves.toBe(
      sessionFile,
    );
    await first.saveAgent(stored);
    await first.close();

    const reopened = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      rootSessionFile,
    );
    await expect(reopened.open()).resolves.toEqual([stored]);
    await reopened.close();
    expect(
      reopened.rootDirectory.startsWith(path.join(project, ".pi", "subagents", "sessions")),
    ).toBe(true);
  });

  it("discards a prepared run that Pi never accepted", async () => {
    const project = await temporaryProject();
    const storage = await initializeProjectSubagents(project);
    const rootSessionFile = path.join(project, "root.jsonl");
    const store = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      rootSessionFile,
    );
    await store.open();
    await store.prepareAgent("sa_test");
    const timestamp = new Date().toISOString();
    const agent = {
      schemaVersion: 2,
      id: "sa_test",
      rootSessionId: "root-id",
      parentAgentId: null,
      name: "test",
      cwd: project,
      ancestorCwds: [project],
      agentType: "general",
      agentDefinitionSnapshot: {
        id: "general",
        prompt: "snapshot",
        source: "/agents/general.md",
        contentHash: "hash",
      },
      depth: 1,
      model: { provider: "test", id: "model" },
      thinking: "off",
      sessionId: "session",
      sessionPath: "agents/sa_test/sessions/child.jsonl",
      lastRunId: "run_test",
      activeRunId: "run_test",
      interrupted: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies StoredSubagent;
    const run = {
      id: "run_test",
      agentId: agent.id,
      parentRunId: null,
      state: "opening",
    } satisfies StoredRun;
    await store.saveRun(run);
    await store.saveAgent(agent);
    await store.close();

    const reopened = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      rootSessionFile,
    );
    await expect(reopened.open()).resolves.toMatchObject([{ id: agent.id, interrupted: false }]);
    await expect(reopened.readRun(agent.id, run.id)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await reopened.close();
  });

  it("rejects escaped and absolute child session paths", async () => {
    const project = await temporaryProject();
    const storage = await initializeProjectSubagents(project);
    const store = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      path.join(project, "root.jsonl"),
    );
    await store.open();
    await expect(store.resolveSessionPath("sa_test", "../outside.jsonl")).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await expect(
      store.resolveSessionPath("sa_test", path.join(project, "outside.jsonl")),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });
    await store.close();
  });

  it("binds child history to its own agent directory and rejects empty files", async () => {
    const project = await temporaryProject();
    const storage = await initializeProjectSubagents(project);
    const store = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      path.join(project, "root.jsonl"),
    );
    await store.open();
    await Promise.all([store.prepareAgent("sa_test"), store.prepareAgent("sa_other")]);
    const siblingFile = path.join(store.sessionsDirectory("sa_other"), "child.jsonl");
    await writeFile(siblingFile, '{"type":"session"}\n');
    const siblingPath = path.relative(store.rootDirectory, siblingFile);
    expect(() => store.toSessionPath("sa_test", siblingFile)).toThrowError(/agent session/i);
    await expect(store.resolveSessionPath("sa_test", siblingPath)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    const emptyFile = path.join(store.sessionsDirectory("sa_test"), "empty.jsonl");
    await writeFile(emptyFile, "");
    await expect(
      store.resolveSessionPath("sa_test", path.relative(store.rootDirectory, emptyFile)),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });

    const outside = await temporaryProject();
    const escapedFile = path.join(outside, "escaped.jsonl");
    await writeFile(escapedFile, '{"type":"session"}\n');
    await rm(store.sessionsDirectory("sa_test"), { recursive: true });
    await symlink(outside, store.sessionsDirectory("sa_test"), "dir");
    await expect(
      store.resolveSessionPath(
        "sa_test",
        path.join("agents", "sa_test", "sessions", "escaped.jsonl"),
      ),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });
    await store.close();
  });

  it("does not recreate project storage deleted after initialization", async () => {
    const project = await temporaryProject();
    const storage = await initializeProjectSubagents(project);
    const store = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      path.join(project, "root.jsonl"),
    );
    await store.open();
    await rm(storage.directory, { recursive: true });
    await expect(store.prepareAgent("sa_test")).rejects.toMatchObject({ code: "STORE_ERROR" });
    await expect(stat(storage.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await store.close().catch(() => undefined);
  });

  it("validates an existing root record instead of overwriting another identity", async () => {
    const project = await temporaryProject();
    const storage = await initializeProjectSubagents(project);
    const rootSessionFile = path.join(project, "root.jsonl");
    const first = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      rootSessionFile,
    );
    await first.open();
    await first.close();
    const rootRecord = path.join(first.rootDirectory, "root.json");
    const value = JSON.parse(await readFile(rootRecord, "utf8")) as Record<string, unknown>;
    value.rootSessionId = "other-root";
    await writeFile(rootRecord, `${JSON.stringify(value)}\n`);

    const reopened = new PersistentSubagentStore(
      project,
      storage.directory,
      "root-id",
      rootSessionFile,
    );
    await expect(reopened.open()).rejects.toMatchObject({ code: "STORE_ERROR" });
  });
});
