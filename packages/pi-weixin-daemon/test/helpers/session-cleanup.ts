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

const MAX_HEADER_SCAN_BYTES = 1024 * 1024;

/**
 * Read the `cwd` of the first session record, or `undefined` when the file is
 * not a session, is unreadable, or its header exceeds Pi's own scan limit.
 */
function readSessionCwd(file: string): string | undefined {
  const fd = fs.openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    let total = 0;
    let complete = false;
    while (total < MAX_HEADER_SCAN_BYTES) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (bytesRead === 0) {
        complete = true;
        break;
      }
      const slice = buffer.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(slice.subarray(0, newline));
        total += newline;
        complete = true;
        break;
      }
      chunks.push(Buffer.from(slice));
      total += bytesRead;
    }
    if (!complete || total === 0) return undefined;
    const header: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof header !== "object" || header === null) return undefined;
    const record = header as { type?: unknown; cwd?: unknown };
    if (record.type !== "session" || typeof record.cwd !== "string") return undefined;
    return record.cwd;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove every Pi session whose project cwd lives under `test/.tmp`. This
 * covers both current temp projects and ones whose dirs were already removed.
 *
 * Pi's directory-name encoding loses path separators, so one session directory
 * may hold both a test project and an unrelated cwd that encodes identically
 * (`test/.tmp/project` vs `test/.tmp-project`). Each session file is therefore
 * matched by its own recorded cwd, and the directory is only removed once no
 * sessions remain in it.
 */
export function cleanupTestSessions(options: CleanupOptions = {}): void {
  const sessionsDir = options.sessionsDir ?? path.join(getAgentDir(), "sessions");
  const tmpDir = options.tmpDir ?? TEST_TMP_DIR;

  // The encoded prefix narrows candidates; the header's cwd resolves the
  // ambiguity between a child path and a sibling with a similar name.
  const prefix = `${encodeCwd(tmpDir).slice(0, -2)}-`;

  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return; // sessions dir doesn't exist yet
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const target = path.join(sessionsDir, entry);
    let files: string[];
    try {
      files = fs.readdirSync(target).filter((file) => file.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let removed = false;
    for (const file of files) {
      const cwd = readSessionCwd(path.join(target, file));
      if (cwd === undefined || encodeCwd(cwd) !== entry) continue;
      const relative = path.relative(tmpDir, cwd);
      const belongsToTest =
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
      if (!belongsToTest) continue;
      fs.rmSync(path.join(target, file), { force: true });
      removed = true;
    }
    // Keep still-populated (or already empty) directories: a session dir may
    // be shared with a non-test cwd or reserved for a future session.
    if (removed) {
      try {
        fs.rmdirSync(target);
      } catch {
        // Directory still holds other sessions or files.
      }
    }
  }
}
