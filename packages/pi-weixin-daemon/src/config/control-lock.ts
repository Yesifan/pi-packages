import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveDataDir, resolveStateDir } from "./paths.js";

/** Canonical storage identity, not the socket address (which can name another instance). */
export function storageIdentity(configPath = resolveConfigPath()): string {
  const canonical = (name: string): string => {
    const absolute = path.resolve(name);
    try {
      return fs.realpathSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
    }
  };
  return JSON.stringify([
    canonical(configPath),
    canonical(resolveDataDir()),
    canonical(resolveStateDir()),
  ]);
}

/**
 * Linux util-linux flock locks an inherited open file description. The helper
 * exits after acquiring it; our fd retains the kernel lock until close/exit.
 * Never unlink lock files: stale-file deletion would split the lock domain.
 */
async function acquire(
  kind: "control" | "daemon",
  wait: boolean,
): Promise<(() => void) | undefined> {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(dir, `.${kind}.lock`), "a", 0o600);
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      fs.closeSync(fd);
    }
  };
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        "flock",
        ["--exclusive", ...(wait ? ["--wait", "30"] : ["--nonblock"]), "3"],
        { stdio: ["ignore", "ignore", "pipe", fd] },
      );
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code === 1) {
      release();
      if (wait) throw new Error("Timed out waiting for control lock (30s)");
      return undefined;
    }
    if (code !== 0)
      throw new Error("Cannot acquire control lock; Linux util-linux flock is required");
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
export function acquireInstanceLock(): Promise<(() => void) | undefined> {
  return acquire("daemon", false);
}
export async function withControlLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const release = await acquire("control", true);
  try {
    return await operation();
  } finally {
    release?.();
  }
}

/** Serialize lifecycle operations, while allowing independent long-poll tasks. */
export class SerialOperations {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
}
