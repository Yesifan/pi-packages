import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import {
  CONFIG_VERSION,
  validateProjectForInsert,
  validateProjectStoreData,
} from "./project-schema.js";
import type { ProjectConfig, ProjectStoreData } from "./types.js";

/**
 * Persistent project config store. The daemon is the sole writer; CLI never
 * mutates config.json directly (it goes through the daemon RPC).
 *
 * Writes are atomic: write temp file -> fsync -> close -> rename.
 */
export class ProjectStore {
  constructor(private readonly configPath: string = resolveConfigPath()) {}

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
  }

  /** Read + validate config. Malformed/invalid config throws (never reset). */
  read(): ProjectStoreData {
    if (!fs.existsSync(this.configPath)) {
      return { version: CONFIG_VERSION, projects: {} };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    } catch (err) {
      throw new Error(`config is malformed at ${this.configPath}: ${String(err)}`);
    }
    const result = validateProjectStoreData(raw);
    if (!result.ok) {
      throw new Error(`config invalid: ${result.errors.join("; ")}`);
    }
    return result.data!;
  }

  /** Atomically persist config. */
  write(data: ProjectStoreData): void {
    this.ensureDir();
    const tmp = `${this.configPath}.tmp-${process.pid}-${Date.now()}`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, "w", 0o600);
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.configPath);
    // Best-effort directory fsync for rename durability.
    try {
      const dirFd = fs.openSync(path.dirname(this.configPath), "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // best-effort
    }
  }

  list(): Array<{ name: string; config: ProjectConfig }> {
    return Object.entries(this.read().projects).map(([name, config]) => ({ name, config }));
  }

  get(name: string): ProjectConfig | undefined {
    return this.read().projects[name];
  }

  /** Insert or update a project with semantic validation against existing data. */
  upsert(name: string, config: ProjectConfig): void {
    const data = this.read();
    // `cwd` is fixed after creation (ADR-0003 D-B): changing it is rejected.
    const existing = data.projects[name];
    if (existing && existing.cwd !== config.cwd) {
      throw new Error(`project "${name}" cwd is fixed (${existing.cwd}); recreate the project to change it`);
    }
    const errors = validateProjectForInsert(data, name, config);
    if (errors.length > 0) throw new Error(errors.join("; "));
    data.projects[name] = { ...config };
    this.write(data);
  }

  /** Append account ids to a project (dedup + cross-project uniqueness). */
  addAccounts(name: string, accountIds: string[]): void {
    const data = this.read();
    const proj = data.projects[name];
    if (!proj) throw new Error(`project "${name}" does not exist`);
    const existing = new Set(proj.accounts);
    const toAdd = accountIds.filter((id) => !existing.has(id));
    if (toAdd.length === 0) return;
    // Validate none of the new accounts are already claimed by another project.
    for (const id of toAdd) {
      for (const [pid, p] of Object.entries(data.projects)) {
        if (pid !== name && p.accounts.includes(id)) {
          throw new Error(`account "${id}" is already assigned to project "${pid}"`);
        }
      }
    }
    proj.accounts.push(...toAdd);
    this.write(data);
  }

  /** Remove account ids from a project. */
  removeAccounts(name: string, accountIds: string[]): void {
    const data = this.read();
    const proj = data.projects[name];
    if (!proj) throw new Error(`project "${name}" does not exist`);
    const rm = new Set(accountIds);
    proj.accounts = proj.accounts.filter((id) => !rm.has(id));
    this.write(data);
  }

  setEnabled(name: string, enabled: boolean): void {
    const data = this.read();
    const proj = data.projects[name];
    if (!proj) throw new Error(`project "${name}" does not exist`);
    proj.enabled = enabled;
    this.write(data);
  }

  remove(name: string): void {
    const data = this.read();
    if (!(name in data.projects)) throw new Error(`project "${name}" does not exist`);
    delete data.projects[name];
    this.write(data);
  }
}
