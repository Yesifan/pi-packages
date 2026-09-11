import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { SubagentError } from "./errors.js";
import type { StoredRun, StoredSubagent } from "./types.js";

function stableRootKey(rootSessionId: string, rootSessionFile: string): string {
  return createHash("sha256")
    .update(`${rootSessionId}\0${path.resolve(rootSessionFile)}`)
    .digest("hex")
    .slice(0, 32);
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    throw new SubagentError("STORE_ERROR", `Cannot read stored subagent data: ${file}`, undefined, {
      cause: error,
    });
  }
}

export class PersistentSubagentStore {
  readonly rootKey: string;
  readonly rootDirectory: string;
  private releaseLock?: () => Promise<void>;
  private writes = Promise.resolve();

  constructor(
    agentDir: string,
    readonly rootSessionId: string,
    readonly rootSessionFile: string,
  ) {
    this.rootKey = stableRootKey(rootSessionId, rootSessionFile);
    this.rootDirectory = path.join(agentDir, ".bykwp-pi-subagents", "roots", this.rootKey);
  }

  async open(): Promise<StoredSubagent[]> {
    await mkdir(path.join(this.rootDirectory, "agents"), { recursive: true, mode: 0o700 });
    try {
      this.releaseLock = await lockfile.lock(this.rootDirectory, {
        realpath: false,
        retries: 0,
        stale: 30_000,
      });
    } catch (error) {
      throw new SubagentError(
        "ROOT_SCOPE_IN_USE",
        `Another Pi process is already using subagent scope ${this.rootKey}`,
        undefined,
        { cause: error },
      );
    }
    try {
      await atomicJson(path.join(this.rootDirectory, "root.json"), {
        schemaVersion: 1,
        rootSessionId: this.rootSessionId,
        rootSessionFile: path.resolve(this.rootSessionFile),
        updatedAt: new Date().toISOString(),
      });
      const agentsDirectory = path.join(this.rootDirectory, "agents");
      const entries = await readdir(agentsDirectory, { withFileTypes: true });
      const agents: StoredSubagent[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(agentsDirectory, entry.name, "agent.json");
        try {
          const agent = await readJson<StoredSubagent>(file);
          if (agent.schemaVersion !== 1 || agent.id !== entry.name) {
            throw new SubagentError("STORE_ERROR", `Invalid stored subagent record: ${file}`);
          }
          if (agent.activeRunId) {
            const activeRunId = agent.activeRunId;
            const run = await this.readRun(agent.id, activeRunId);
            const interruptedAt = new Date().toISOString();
            run.completedAt = interruptedAt;
            run.outcome = "interrupted";
            run.result = run.result ?? "";
            run.error = {
              code: "INTERRUPTED",
              message: "The root session ended before this run completed; it was not replayed.",
            };
            await this.saveRun(run);
            agent.activeRunId = undefined;
            agent.interrupted = true;
            agent.updatedAt = interruptedAt;
            await this.saveAgent(agent);
          }
          agents.push(agent);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      return agents;
    } catch (error) {
      const release = this.releaseLock;
      this.releaseLock = undefined;
      if (release) await release();
      throw error;
    }
  }

  agentDirectory(agentId: string): string {
    return path.join(this.rootDirectory, "agents", agentId);
  }

  sessionsDirectory(agentId: string): string {
    return path.join(this.agentDirectory(agentId), "sessions");
  }

  async saveAgent(agent: StoredSubagent): Promise<void> {
    return this.enqueue(() =>
      atomicJson(path.join(this.agentDirectory(agent.id), "agent.json"), agent),
    );
  }

  async saveRun(run: StoredRun): Promise<void> {
    return this.enqueue(() =>
      atomicJson(path.join(this.agentDirectory(run.agentId), "runs", `${run.id}.json`), run),
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    return this.enqueue(() => rm(this.agentDirectory(agentId), { recursive: true, force: true }));
  }

  async readRun(agentId: string, runId: string): Promise<StoredRun> {
    return readJson(path.join(this.agentDirectory(agentId), "runs", `${runId}.json`));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => {});
    return result;
  }

  async close(): Promise<void> {
    await this.writes;
    const release = this.releaseLock;
    this.releaseLock = undefined;
    if (release) await release();
  }
}
