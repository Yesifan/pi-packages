import fs from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Pi normally defers files until conversation starts; defaults must survive even an empty /new. */
export function persistSessionIdentity(manager: SessionManager): void {
  const file = manager.getSessionFile();
  if (!file || fs.existsSync(file)) return;
  const entries = [manager.getHeader(), ...manager.getEntries()];
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    fs.fsyncSync(fd);
  } catch (err) {
    // A failed initial write must not look like a successfully persisted identity on retry.
    fs.unlinkSync(file);
    throw err;
  } finally {
    fs.closeSync(fd);
  }
  // Reload through the public SDK API so subsequent appends do not recreate the file.
  manager.setSessionFile(file);
}
