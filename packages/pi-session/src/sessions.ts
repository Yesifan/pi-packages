import { readFileSync, realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";

async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("cwd must be an absolute directory path");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("cwd must be a directory");
  return canonical;
}

/** Authorization is exact canonical cwd matching, not a filesystem sandbox. */
export async function resolveCwd(callerCwd: string, requested?: string): Promise<string> {
  const caller = await directory(callerCwd);
  const target = await directory(requested?.trim() ? requested : caller);
  if (target === caller) return target;
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(caller, ".pi/pi-session/setting.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries =
    (config as { externalDirectories?: unknown } | undefined)?.externalDirectories ?? [];
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error("externalDirectories must be an array of directory paths");
  }
  for (const entry of entries as string[]) {
    const expanded = entry
      .replace(/^~(?=\/|$)/, homedir())
      .replace(/\$\{HOME\}|\$HOME(?=\/|$)/g, homedir());
    if ((await directory(expanded)) === target) return target;
  }
  throw new Error(`Unauthorized cwd: ${target}`);
}

export interface SessionTarget {
  id: string;
  cwd: string;
  path: string;
}

/** Caller must authorize cwd before discovery. SDK matches the entire ID, including custom IDs. */
export function findSession(cwd: string, id: string): SessionTarget {
  if (!id || id.includes("/") || id.includes("\\"))
    throw new Error("A complete session ID is required");
  const path = SessionManager.findById(cwd, id);
  if (!path) throw new Error(`Session not found in ${cwd}: ${id}`);
  // Default discovery groups by directory; verify the header before opening a writable manager.
  const header = parseSessionEntries(readFileSync(path, "utf8")).find(
    (entry) => entry.type === "session",
  );
  if (!header || realpathSync(header.cwd) !== realpathSync(cwd)) {
    throw new Error("Session cwd does not match the authorized project");
  }
  return { id, cwd, path: resolve(path) };
}

export interface SessionMatch extends SessionTarget {
  name?: string;
  modified: string;
  segments: { text: string; truncated: boolean }[];
  truncated: boolean;
}

export async function searchSessions(
  cwd: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ sessions: SessionMatch[]; truncated: boolean }> {
  if (!query.trim()) throw new Error("Search query must not be empty");
  signal?.throwIfAborted();
  const infos = await SessionManager.list(cwd, undefined, undefined, signal);
  signal?.throwIfAborted();
  const needle = query.toLowerCase();
  const matches: SessionMatch[] = [];
  for (const info of infos.sort((a, b) => b.modified.getTime() - a.modified.getTime())) {
    signal?.throwIfAborted();
    if (!info.cwd || realpathSync(info.cwd) !== realpathSync(cwd)) continue;
    const lines = info.allMessagesText
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(needle));
    if (!lines.length) continue;
    if (matches.length === 20) return { sessions: matches, truncated: true };
    const segments = lines
      .slice(0, 5)
      .map((line) => ({ text: line.slice(0, 2000), truncated: line.length > 2000 }));
    matches.push({
      id: info.id,
      cwd: info.cwd || cwd,
      path: resolve(info.path),
      name: info.name,
      modified: info.modified.toISOString(),
      segments,
      truncated: lines.length > 5 || segments.some((segment) => segment.truncated),
    });
  }
  return { sessions: matches, truncated: false };
}
