import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChildSessionFactory } from "../../src/child-session.js";
import type { StoredSubagent } from "../../src/types.js";
import type { RootUiBroker } from "../../src/ui.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-child-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ChildSessionFactory session history", () => {
  it("creates a private file and validates the stored session identity", async () => {
    const cwd = await temporaryDirectory();
    const sessionsDirectory = path.join(cwd, "sessions");
    await mkdir(sessionsDirectory, { mode: 0o700 });
    const factory = new ChildSessionFactory(
      path.join(cwd, "agent"),
      path.join(cwd, "extension.js"),
      {} as RootUiBroker,
      async () => true,
    );
    const manager = await factory.createSessionManager(cwd, sessionsDirectory);
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();
    if (!sessionFile) throw new Error("Expected a file-backed child session");
    if (process.platform !== "win32") {
      expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
    }
    const timestamp = new Date().toISOString();
    const stored: StoredSubagent = {
      schemaVersion: 2,
      id: "sa_test",
      rootSessionId: "root",
      parentAgentId: null,
      name: "test",
      cwd,
      ancestorCwds: [cwd],
      agentType: "general",
      agentDefinitionSnapshot: {
        id: "general",
        prompt: "prompt",
        source: "/agents/general.md",
        contentHash: "hash",
      },
      depth: 1,
      model: { provider: "test", id: "model" },
      thinking: "off",
      sessionId: manager.getSessionId(),
      sessionPath: path.basename(sessionFile),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(factory.openSessionManager(stored, sessionFile).getSessionId()).toBe(stored.sessionId);
    expect(() =>
      factory.openSessionManager({ ...stored, sessionId: "different" }, sessionFile),
    ).toThrowError(/identity/i);
  });
});
