import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { SubagentError } from "./errors.js";
import type {
  AgentDefinitionSnapshot,
  ChildRecord,
  ParentSessionRecord,
  SessionIdentity,
} from "./types.js";

export type { ChildRecord, ParentSessionRecord, SessionIdentity } from "./types.js";

function storeError(message: string, cause?: unknown): SubagentError {
  return new SubagentError(
    "STORE_ERROR",
    message,
    undefined,
    cause instanceof Error ? { cause } : undefined,
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function normalizeIdentity(value: SessionIdentity): SessionIdentity {
  if (
    !object(value) ||
    !nonempty(value.sessionId) ||
    !nonempty(value.sessionFile) ||
    !path.isAbsolute(value.sessionFile)
  ) {
    throw storeError("Session identity requires a non-empty ID and an absolute file path.");
  }
  return { sessionId: value.sessionId, sessionFile: path.normalize(value.sessionFile) };
}

function storedIdentity(value: unknown): SessionIdentity {
  if (!object(value) || !onlyKeys(value, ["sessionId", "sessionFile"])) {
    throw storeError("Invalid stored session identity.");
  }
  return normalizeIdentity(value as unknown as SessionIdentity);
}

function sameIdentity(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.sessionId === b.sessionId && a.sessionFile === b.sessionFile;
}

export function sessionKey(identity: SessionIdentity): string {
  const normalized = normalizeIdentity(identity);
  return createHash("sha256")
    .update(`${normalized.sessionId}\0${normalized.sessionFile}`)
    .digest("hex")
    .slice(0, 32);
}

function validateName(name: string): void {
  if (typeof name !== "string" || !name.trim() || name !== name.trim()) {
    throw storeError("Child names must be non-empty and already trimmed.");
  }
}

function snapshot(value: unknown): AgentDefinitionSnapshot {
  if (
    !object(value) ||
    !onlyKeys(value, [
      "id",
      "description",
      "tools",
      "disallowedTools",
      "thinking",
      "prompt",
      "source",
      "contentHash",
    ]) ||
    !nonempty(value.id) ||
    typeof value.prompt !== "string" ||
    !nonempty(value.source) ||
    !nonempty(value.contentHash) ||
    (value.description !== undefined && typeof value.description !== "string") ||
    (value.tools !== undefined && value.disallowedTools !== undefined) ||
    (value.thinking !== undefined &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        value.thinking as string,
      ))
  ) {
    throw storeError("Invalid stored role snapshot.");
  }
  for (const tools of [value.tools, value.disallowedTools]) {
    if (tools !== undefined && (!Array.isArray(tools) || !tools.every(nonempty))) {
      throw storeError("Invalid stored role tool policy.");
    }
  }
  return structuredClone(value) as unknown as AgentDefinitionSnapshot;
}

function childRecord(value: unknown): ChildRecord {
  if (
    !object(value) ||
    !onlyKeys(value, ["sessionId", "sessionFile", "roleSnapshot", "state", "hasChildren"]) ||
    !["opening", "running", "idle", "interrupted"].includes(value.state as string) ||
    (value.hasChildren !== undefined && value.hasChildren !== true)
  ) {
    throw storeError("Invalid stored child record.");
  }
  return {
    ...normalizeIdentity(value as unknown as SessionIdentity),
    roleSnapshot: snapshot(value.roleSnapshot),
    state: value.state as ChildRecord["state"],
    ...(value.hasChildren === true ? { hasChildren: true } : {}),
  };
}

function plainDirectory(directory: string, create = false): void {
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw storeError(`Subagent storage requires a non-symlink directory: ${directory}`);
    }
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    plainDirectory(directory);
  }
}

function directoryChain(directory: string): string[] {
  const directories: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    directories.unshift(current);
    if (path.dirname(current) === current) return directories;
  }
}

let temporarySequence = 0;

function atomicJson(file: string, value: ParentSessionRecord): void {
  // These suffixes identify scratch files only, never sessions or executions.
  const temporary = `${file}.${process.pid}.${++temporarySequence}.tmp`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    const directory = openSync(path.dirname(file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) rmSync(temporary, { force: true });
  }
}

/** Global direct-owner metadata. History validation and recursive recovery belong to runtime. */
export class PersistentSubagentStore {
  readonly rootKey: string;
  private readonly root: SessionIdentity;
  private readonly directories: string[];
  private readonly sessionsDirectory: string;
  private readonly lockTarget: string;
  private readonly lockDirectory: string;
  private releaseLock?: () => Promise<void>;
  private lockFailure?: Error;
  private writes: Promise<unknown> = Promise.resolve();
  private closing = false;
  private opened = false;
  private openPromise?: Promise<ParentSessionRecord | undefined>;
  private closePromise?: Promise<void>;
  private readonly loadedOwners = new Set<string>();
  private revision = 0;
  private readonly applied = new Map<string, Map<string, number>>();

  constructor(agentDir: string, root: SessionIdentity) {
    if (!nonempty(agentDir) || !path.isAbsolute(agentDir)) {
      throw storeError("Subagent agentDir must be an absolute path.");
    }
    this.root = normalizeIdentity(root);
    this.rootKey = sessionKey(this.root);
    const storage = path.join(path.normalize(agentDir), "subagents");
    this.sessionsDirectory = path.join(storage, "sessions");
    const locks = path.join(storage, "locks");
    this.lockTarget = path.join(locks, this.rootKey);
    this.lockDirectory = path.join(this.lockTarget, ".writer");
    this.directories = [...directoryChain(storage), this.sessionsDirectory, locks, this.lockTarget];
  }

  open(): Promise<ParentSessionRecord | undefined> {
    if (this.opened || this.closing) {
      return Promise.reject(storeError("Subagent store has already been opened."));
    }
    this.opened = true;
    this.openPromise = this.openNow();
    return this.openPromise;
  }

  private async openNow(): Promise<ParentSessionRecord | undefined> {
    try {
      for (const directory of this.directories) plainDirectory(directory, true);
      // Reject an unsafe existing lock path before asking the lock library to inspect it.
      try {
        plainDirectory(this.lockDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        this.releaseLock = await lockfile.lock(this.lockTarget, {
          realpath: false,
          lockfilePath: this.lockDirectory,
          retries: 0,
          stale: 30_000,
          fs: {
            ...fs,
            mkdir: (directory: string, callback: (error: NodeJS.ErrnoException | null) => void) =>
              fs.mkdir(directory, { mode: 0o700 }, callback),
          },
          onCompromised: (error) => {
            this.lockFailure = error;
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        throw new SubagentError(
          "ROOT_SCOPE_IN_USE",
          "Another Pi process is already managing this root session's subagent tree.",
          undefined,
          { cause: error },
        );
      }
      if (this.closing) throw storeError("Subagent store closed during lock acquisition.");
      plainDirectory(this.lockDirectory);
      chmodSync(this.lockDirectory, 0o700);
      return this.readOwnerNow(this.root, null);
    } catch (error) {
      const release = this.releaseLock;
      this.releaseLock = undefined;
      if (release) await release().catch(() => undefined);
      throw this.error(error);
    }
  }

  readOwner(
    owner: SessionIdentity,
    parent: SessionIdentity | null,
    required = false,
  ): Promise<ParentSessionRecord | undefined> {
    return this.enqueue(() => this.readOwnerNow(owner, parent, required));
  }

  /** Publish a valid empty branch owner before its parent's hasChildren marker. */
  ensureOwner(owner: SessionIdentity, parent: SessionIdentity | null): Promise<void> {
    try {
      const normalizedOwner = normalizeIdentity(owner);
      const normalizedParent = parent === null ? null : normalizeIdentity(parent);
      return this.enqueue(() => {
        this.readOwnerNow(this.root, null, !sameIdentity(normalizedOwner, this.root));
        if (this.readOwnerNow(normalizedOwner, normalizedParent)) return;
        const record: ParentSessionRecord = {
          schemaVersion: 1,
          root: { ...this.root },
          owner: normalizedOwner,
          parent: normalizedParent,
          children: Object.create(null),
        };
        const key = sessionKey(normalizedOwner);
        atomicJson(path.join(this.sessionsDirectory, `${key}.json`), record);
        this.loadedOwners.add(key);
      });
    } catch (error) {
      return Promise.reject(this.error(error));
    }
  }

  /** Grow-only field merge; never replace a child's newer state with a captured snapshot. */
  markHasChildren(
    owner: SessionIdentity,
    parent: SessionIdentity | null,
    name: string,
  ): Promise<void> {
    try {
      const normalizedOwner = normalizeIdentity(owner);
      const normalizedParent = parent === null ? null : normalizeIdentity(parent);
      validateName(name);
      return this.enqueue(() => {
        this.readOwnerNow(this.root, null, true);
        const record = this.readOwnerNow(normalizedOwner, normalizedParent, true);
        const child = record?.children[name];
        if (!record || !child) throw storeError("Branch marker requires an existing child record.");
        this.readOwnerNow(child, normalizedOwner, true);
        if (child.hasChildren) return;
        child.hasChildren = true;
        // Do not advance the child's mutation revision: this field-only merge must neither
        // overwrite sync acceptance nor supersede a subsequent queued state update.
        atomicJson(
          path.join(this.sessionsDirectory, `${sessionKey(normalizedOwner)}.json`),
          record,
        );
      });
    } catch (error) {
      return Promise.reject(this.error(error));
    }
  }

  setChild(
    owner: SessionIdentity,
    parent: SessionIdentity | null,
    name: string,
    child: ChildRecord,
  ): Promise<void> {
    try {
      const prepared = childRecord(child);
      const normalizedOwner = normalizeIdentity(owner);
      const normalizedParent = parent === null ? null : normalizeIdentity(parent);
      validateName(name);
      const revision = ++this.revision;
      return this.enqueue(() =>
        this.update(normalizedOwner, normalizedParent, name, prepared, revision),
      );
    } catch (error) {
      return Promise.reject(this.error(error));
    }
  }

  /** Synchronous preflight acceptance: requires an already durable opening record. */
  setChildSync(
    owner: SessionIdentity,
    parent: SessionIdentity | null,
    name: string,
    child: ChildRecord,
  ): void {
    try {
      if (this.closing) throw storeError("Subagent store is closing.");
      validateName(name);
      const prepared = childRecord(child);
      const record = this.readOwnerNow(owner, parent, true);
      const previous = record?.children[name];
      if (
        !previous ||
        previous.state !== "opening" ||
        prepared.state !== "running" ||
        !sameIdentity(previous, prepared)
      ) {
        throw storeError(
          "Synchronous acceptance requires the same child's durable opening record.",
        );
      }
      this.update(owner, parent, name, prepared, ++this.revision);
    } catch (error) {
      throw this.error(error);
    }
  }

  removeChild(owner: SessionIdentity, parent: SessionIdentity | null, name: string): Promise<void> {
    try {
      validateName(name);
      const normalizedOwner = normalizeIdentity(owner);
      const normalizedParent = parent === null ? null : normalizeIdentity(parent);
      const revision = ++this.revision;
      return this.enqueue(() =>
        this.update(normalizedOwner, normalizedParent, name, undefined, revision),
      );
    } catch (error) {
      return Promise.reject(this.error(error));
    }
  }

  private assertAvailable(): void {
    if (!this.releaseLock || this.lockFailure) {
      throw storeError("Subagent tree writer lock is unavailable.", this.lockFailure);
    }
    for (const directory of [...this.directories, this.lockDirectory]) plainDirectory(directory);
  }

  private readOwnerNow(
    ownerInput: SessionIdentity,
    parentInput: SessionIdentity | null,
    required = false,
  ): ParentSessionRecord | undefined {
    this.assertAvailable();
    const owner = normalizeIdentity(ownerInput);
    const parent = parentInput === null ? null : normalizeIdentity(parentInput);
    if (sameIdentity(owner, this.root) !== (parent === null)) {
      throw storeError("Only the root owner may have a null parent.");
    }
    const key = sessionKey(owner);
    const file = path.join(this.sessionsDirectory, `${key}.json`);
    let descriptor: number | undefined;
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw storeError(`Owner metadata must be a non-symlink regular file: ${file}`);
      }
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!fstatSync(descriptor).isFile()) throw storeError(`Unsafe owner metadata: ${file}`);
      const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
      if (
        !object(value) ||
        !onlyKeys(value, ["schemaVersion", "root", "owner", "parent", "children"]) ||
        value.schemaVersion !== 1 ||
        !sameIdentity(storedIdentity(value.root), this.root) ||
        !sameIdentity(storedIdentity(value.owner), owner) ||
        (parent === null
          ? value.parent !== null
          : value.parent === null || !sameIdentity(storedIdentity(value.parent), parent)) ||
        !object(value.children)
      ) {
        throw storeError(`Owner metadata schema or root/owner/parent header mismatch: ${file}`);
      }
      const children: Record<string, ChildRecord> = Object.create(null);
      for (const [name, child] of Object.entries(value.children)) {
        validateName(name);
        children[name] = childRecord(child);
      }
      this.loadedOwners.add(key);
      return { schemaVersion: 1, root: { ...this.root }, owner, parent, children };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        !required &&
        !this.loadedOwners.has(key)
      ) {
        return undefined;
      }
      throw this.error(error);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private update(
    ownerInput: SessionIdentity,
    parentInput: SessionIdentity | null,
    name: string,
    child: ChildRecord | undefined,
    revision: number,
  ): void {
    const owner = normalizeIdentity(ownerInput);
    const parent = parentInput === null ? null : normalizeIdentity(parentInput);
    // Validate the root header at every write, including descendant-owner mutations.
    this.readOwnerNow(this.root, null, !sameIdentity(owner, this.root));
    const record = this.readOwnerNow(owner, parent);
    const key = sessionKey(owner);
    const revisions = this.applied.get(key) ?? new Map<string, number>();
    // A sync preflight can overtake queued writes. Skip only the superseded child mutation,
    // not sibling updates; no asynchronous filesystem write can be in flight here.
    if ((revisions.get(name) ?? 0) > revision) return;
    if (!record && !child) return;
    const next = record ?? {
      schemaVersion: 1,
      root: { ...this.root },
      owner,
      parent,
      children: Object.create(null),
    };
    if (child) {
      next.children[name] = {
        ...child,
        ...(next.children[name]?.hasChildren ? { hasChildren: true } : {}),
      };
    } else delete next.children[name];
    atomicJson(path.join(this.sessionsDirectory, `${key}.json`), next);
    this.loadedOwners.add(key);
    revisions.set(name, revision);
    this.applied.set(key, revisions);
  }

  private error(error: unknown): SubagentError {
    return error instanceof SubagentError
      ? error
      : storeError("Subagent metadata is unavailable or unsafe.", error);
  }

  private enqueue<T>(operation: () => T): Promise<T> {
    if (this.closing) return Promise.reject(storeError("Subagent store is closing."));
    const result = this.writes.then(() => {
      try {
        return operation();
      } catch (error) {
        throw this.error(error);
      }
    });
    this.writes = result.catch(() => undefined);
    return result;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = (this.openPromise ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => this.writes)
        .then(async () => {
          const release = this.releaseLock;
          this.releaseLock = undefined;
          if (release) await release();
        });
    }
    return this.closePromise;
  }
}
