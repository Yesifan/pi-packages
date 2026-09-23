import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { SubagentError } from "./errors.js";
import { assertProjectStorageAvailable } from "./project-storage.js";
import type { StoredRun, StoredSubagent } from "./types.js";

interface StoredRoot {
  schemaVersion: 2;
  rootSessionId: string;
  rootSessionFile: string;
  updatedAt: string;
}

function stableRootKey(rootSessionId: string, rootSessionFile: string): string {
  return createHash("sha256")
    .update(`${rootSessionId}\0${path.resolve(rootSessionFile)}`)
    .digest("hex")
    .slice(0, 32);
}

function storeError(message: string, cause?: unknown): SubagentError {
  return new SubagentError(
    "STORE_ERROR",
    message,
    undefined,
    cause instanceof Error ? { cause } : undefined,
  );
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function safeSegment(value: string, kind: string): string {
  if (!value || value === "." || value === ".." || path.basename(value) !== value) {
    throw storeError(`Invalid ${kind} path segment: ${value}`);
  }
  return value;
}

async function ensurePlainDirectory(directory: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw storeError(`Stored subagent path must be a non-symlink directory: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) throw storeError(`Stored subagent directory is unavailable: ${directory}`, error);
    try {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw storeError(`Cannot create stored subagent directory: ${directory}`, mkdirError);
      }
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw storeError(`Stored subagent path must be a non-symlink directory: ${directory}`);
    }
  }
}

function atomicJsonSync(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Preserve the original persistence error.
    }
    throw storeError(`Cannot atomically write ${file}`, error);
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw storeError(`Cannot write stored subagent data: ${file}`, error);
  }
}

async function readJson<T>(file: string): Promise<T> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw storeError(`Stored subagent data must be a non-symlink file: ${file}`);
    }
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (error instanceof SubagentError) throw error;
    throw storeError(`Cannot read stored subagent data: ${file}`, error);
  }
}

export class PersistentSubagentStore {
  readonly rootKey: string;
  readonly rootDirectory: string;
  readonly sessionsRoot: string;
  private releaseLock?: () => Promise<void>;
  private writes = Promise.resolve();

  constructor(
    readonly projectRoot: string,
    readonly storageDirectory: string,
    readonly rootSessionId: string,
    readonly rootSessionFile: string,
  ) {
    this.rootKey = stableRootKey(rootSessionId, rootSessionFile);
    this.sessionsRoot = path.join(storageDirectory, "sessions");
    this.rootDirectory = path.join(this.sessionsRoot, this.rootKey);
  }

  async open(): Promise<StoredSubagent[]> {
    await assertProjectStorageAvailable(this.projectRoot, this.storageDirectory);
    await ensurePlainDirectory(this.rootDirectory, true);
    const agentsDirectory = path.join(this.rootDirectory, "agents");
    await ensurePlainDirectory(agentsDirectory, true);
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
      await this.openRootRecord();
      const entries = await readdir(agentsDirectory, { withFileTypes: true });
      const agents: StoredSubagent[] = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw storeError(
            `Stored subagent agent directory must not be a symlink: ${path.join(agentsDirectory, entry.name)}`,
          );
        }
        if (!entry.isDirectory()) continue;
        const file = path.join(agentsDirectory, entry.name, "agent.json");
        try {
          const agent = await readJson<StoredSubagent>(file);
          if (agent.schemaVersion !== 2 || agent.id !== entry.name) {
            throw storeError(`Invalid stored subagent record: ${file}`);
          }
          await this.assertAgentDirectories(agent.id);
          if (agent.activeRunId) {
            const activeRunId = agent.activeRunId;
            const run = await this.readRun(agent.id, activeRunId);
            const recoveredAt = new Date().toISOString();
            if (run.state === "opening") {
              await this.deleteRun(agent.id, run.id);
              if (agent.lastRunId === run.id) agent.lastRunId = undefined;
              agent.interrupted = false;
            } else {
              if (!run.completedAt) {
                run.state = "completed";
                run.completedAt = recoveredAt;
                run.outcome = "interrupted";
                run.result = run.result ?? "";
                run.error = {
                  code: "INTERRUPTED",
                  message: "The root session ended before this run completed; it was not replayed.",
                };
                await this.saveRun(run);
              }
              agent.interrupted = run.outcome === "interrupted";
            }
            agent.activeRunId = undefined;
            agent.updatedAt = recoveredAt;
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

  private async openRootRecord(): Promise<void> {
    const file = path.join(this.rootDirectory, "root.json");
    const expectedFile = path.resolve(this.rootSessionFile);
    try {
      const stored = await readJson<StoredRoot>(file);
      if (
        stored.schemaVersion !== 2 ||
        stored.rootSessionId !== this.rootSessionId ||
        path.resolve(stored.rootSessionFile) !== expectedFile
      ) {
        throw storeError(`Stored root identity does not match the current root session: ${file}`);
      }
    } catch (error) {
      if (!(error instanceof SubagentError) || error.cause === undefined) throw error;
      const cause = error.cause as NodeJS.ErrnoException;
      if (cause.code !== "ENOENT") throw error;
    }
    await atomicJson(file, {
      schemaVersion: 2,
      rootSessionId: this.rootSessionId,
      rootSessionFile: expectedFile,
      updatedAt: new Date().toISOString(),
    } satisfies StoredRoot);
  }

  agentDirectory(agentId: string): string {
    return path.join(this.rootDirectory, "agents", safeSegment(agentId, "agent ID"));
  }

  sessionsDirectory(agentId: string): string {
    return path.join(this.agentDirectory(agentId), "sessions");
  }

  async prepareAgent(agentId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.assertRootAvailable();
      const directory = this.agentDirectory(agentId);
      await ensurePlainDirectory(directory, true);
      await ensurePlainDirectory(path.join(directory, "runs"), true);
      await ensurePlainDirectory(path.join(directory, "sessions"), true);
    });
  }

  toSessionPath(agentId: string, sessionFile: string): string {
    const absolute = path.resolve(sessionFile);
    const expectedDirectory = this.sessionsDirectory(agentId);
    if (!isWithin(absolute, expectedDirectory) || absolute === expectedDirectory) {
      throw storeError(
        `Child session file must be inside its agent session directory: ${sessionFile}`,
      );
    }
    return path.relative(this.rootDirectory, absolute);
  }

  async resolveSessionPath(agentId: string, sessionPath: string): Promise<string> {
    if (!sessionPath || path.isAbsolute(sessionPath)) {
      throw storeError(`Stored child session path must be relative: ${sessionPath}`);
    }
    const normalized = path.normalize(sessionPath);
    if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw storeError(`Stored child session path escapes its root scope: ${sessionPath}`);
    }
    await this.assertAgentDirectories(agentId);
    const candidate = path.resolve(this.rootDirectory, normalized);
    const expectedDirectory = this.sessionsDirectory(agentId);
    if (!isWithin(candidate, expectedDirectory) || candidate === expectedDirectory) {
      throw storeError(
        `Stored child session path escapes its agent session directory: ${sessionPath}`,
      );
    }
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isFile() || info.size === 0) {
        throw storeError(
          `Stored child session must be a non-empty, non-symlink file: ${candidate}`,
        );
      }
      const [canonicalFile, canonicalDirectory] = await Promise.all([
        realpath(candidate),
        realpath(expectedDirectory),
      ]);
      if (!isWithin(canonicalFile, canonicalDirectory)) {
        throw storeError(
          `Stored child session path escapes its agent session directory: ${sessionPath}`,
        );
      }
      return canonicalFile;
    } catch (error) {
      if (error instanceof SubagentError) throw error;
      throw storeError(`Stored child session is unavailable: ${candidate}`, error);
    }
  }

  async saveAgent(agent: StoredSubagent): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAgentDirectories(agent.id);
      await atomicJson(path.join(this.agentDirectory(agent.id), "agent.json"), agent);
    });
  }

  async saveRun(run: StoredRun): Promise<void> {
    return this.enqueue(async () => {
      await this.assertAgentDirectories(run.agentId);
      const runId = safeSegment(run.id, "run ID");
      await atomicJson(path.join(this.agentDirectory(run.agentId), "runs", `${runId}.json`), run);
    });
  }

  commitAcceptedRun(run: StoredRun): void {
    if (run.state !== "accepted" || !run.acceptedAt || !this.releaseLock) {
      throw storeError(`Cannot commit an unaccepted subagent run: ${run.id}`);
    }
    const directories = [
      path.join(this.projectRoot, ".pi"),
      this.storageDirectory,
      path.join(this.storageDirectory, "sessions"),
      this.rootDirectory,
      path.join(this.rootDirectory, "agents"),
      this.agentDirectory(run.agentId),
      path.join(this.agentDirectory(run.agentId), "runs"),
    ];
    try {
      for (const directory of directories) {
        const info = lstatSync(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw storeError(`Subagent storage directory is unsafe: ${directory}`);
        }
      }
      const root = realpathSync(this.rootDirectory);
      const runs = realpathSync(path.join(this.agentDirectory(run.agentId), "runs"));
      if (!isWithin(runs, root)) {
        throw storeError(`Subagent run directory escapes its root scope: ${runs}`);
      }
      atomicJsonSync(path.join(runs, `${safeSegment(run.id, "run ID")}.json`), run);
    } catch (error) {
      if (error instanceof SubagentError) throw error;
      throw storeError(`Cannot commit accepted subagent run: ${run.id}`, error);
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    return this.enqueue(() =>
      rm(this.agentDirectory(agentId), { recursive: true, force: true }).catch((error) => {
        throw storeError(`Cannot delete stored subagent: ${agentId}`, error);
      }),
    );
  }

  async deleteRun(agentId: string, runId: string): Promise<void> {
    return this.enqueue(() =>
      rm(path.join(this.agentDirectory(agentId), "runs", `${safeSegment(runId, "run ID")}.json`), {
        force: true,
      }).catch((error) => {
        throw storeError(`Cannot delete stored subagent run: ${runId}`, error);
      }),
    );
  }

  async readRun(agentId: string, runId: string): Promise<StoredRun> {
    await this.assertAgentDirectories(agentId);
    const file = path.join(
      this.agentDirectory(agentId),
      "runs",
      `${safeSegment(runId, "run ID")}.json`,
    );
    const run = await readJson<StoredRun>(file);
    if (
      run.id !== runId ||
      run.agentId !== agentId ||
      !["opening", "accepted", "completed"].includes(run.state)
    ) {
      throw storeError(`Invalid stored subagent run: ${file}`);
    }
    return run;
  }

  private async assertRootAvailable(): Promise<void> {
    await assertProjectStorageAvailable(this.projectRoot, this.storageDirectory);
    await ensurePlainDirectory(this.rootDirectory, false);
    await ensurePlainDirectory(path.join(this.rootDirectory, "agents"), false);
  }

  private async assertAgentDirectories(agentId: string): Promise<void> {
    await this.assertRootAvailable();
    const directory = this.agentDirectory(agentId);
    await ensurePlainDirectory(directory, false);
    await ensurePlainDirectory(path.join(directory, "runs"), false);
    await ensurePlainDirectory(path.join(directory, "sessions"), false);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    await this.writes;
    const release = this.releaseLock;
    this.releaseLock = undefined;
    if (release) await release();
  }
}
