import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Atomic single-file replacement; callers coordinate read/modify/write. */
export function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteFile(file, JSON.stringify(value, null, 2));
}

export function atomicWriteFile(file: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    // Keep rename durability best-effort: a committed replacement is not rolled back.
    try {
      const dir = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } catch {}
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Never replace the save error (or a committed rename) with temp cleanup failure.
    }
  }
}
