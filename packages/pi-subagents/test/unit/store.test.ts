import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentSubagentStore } from "../../src/store.js";
import type { StoredSubagent } from "../../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PersistentSubagentStore", () => {
  it("persists logical identity and excludes concurrent writers", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-store-"));
    temporaryDirectories.push(agentDir);
    const first = new PersistentSubagentStore(agentDir, "root-id", "/tmp/root.jsonl");
    const second = new PersistentSubagentStore(agentDir, "root-id", "/tmp/root.jsonl");
    await expect(first.open()).resolves.toEqual([]);
    await expect(second.open()).rejects.toMatchObject({ code: "ROOT_SCOPE_IN_USE" });

    const timestamp = new Date().toISOString();
    const stored: StoredSubagent = {
      schemaVersion: 1,
      id: "sa_test",
      rootSessionId: "root-id",
      parentAgentId: null,
      name: "test",
      cwd: "/tmp",
      ancestorCwds: ["/tmp"],
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
      sessionFile: "/tmp/session.jsonl",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await first.saveAgent(stored);
    await first.close();

    const reopened = new PersistentSubagentStore(agentDir, "root-id", "/tmp/root.jsonl");
    await expect(reopened.open()).resolves.toEqual([stored]);
    await reopened.close();
  });
});
