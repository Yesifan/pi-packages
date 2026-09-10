import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const TEST_TMP_DIR = path.join(REPO_ROOT, "test", ".tmp");

/**
 * Encode an absolute cwd the same way Pi names its per-project session dir
 * (see pi-coding-agent's session-manager / migrations: `--<cwd>--` with
 * leading slash stripped and `/`/`:` replaced by `-`).
 */
export function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface CleanupOptions {
  /** Session store root. Defaults to Pi's `getAgentDir()/sessions`. */
  sessionsDir?: string;
  /** The test temp dir whose child projects are considered "test sessions". */
  tmpDir?: string;
}

/**
 * Remove every Pi session whose project cwd lives under `test/.tmp`. This
 * covers both current temp projects and ones whose dirs were already removed.
 *
 * Real (non-test) project sessions — e.g. the daemon's own cwd — are left
 * untouched because they don't share the `test/.tmp` path prefix.
 */
export function cleanupTestSessions(options: CleanupOptions = {}): void {
  const sessionsDir = options.sessionsDir ?? path.join(getAgentDir(), "sessions");
  const tmpDir = options.tmpDir ?? TEST_TMP_DIR;

  // Encoded test/.tmp session-dir name, minus its trailing "--". Any session
  // created for a cwd under test/.tmp starts with this prefix.
  const prefix = encodeCwd(tmpDir).slice(0, -2);

  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return; // sessions dir doesn't exist yet
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const target = path.join(sessionsDir, entry);
    fs.rmSync(target, { recursive: true, force: true });
  }
}
