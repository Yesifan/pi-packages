import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveAccountsDir } from "../storage/state-dir.js";

export type SyncBufData = {
  get_updates_buf: string;
};

const SyncBufSchema = z.object({
  get_updates_buf: z.string(),
});

/** Path to the persistent get_updates_buf file for an account. */
export function getSyncBufFilePath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}

function readSyncBufFile(filePath: string): string | undefined {
  try {
    const parsed = SyncBufSchema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    if (parsed.success) return parsed.data.get_updates_buf;
  } catch {
    // file not found or invalid
  }
  return undefined;
}

/** Load persisted get_updates_buf. */
export function loadGetUpdatesBuf(accountId: string): string | undefined {
  return readSyncBufFile(getSyncBufFilePath(accountId));
}

/** Persist get_updates_buf. Creates parent dir if needed. */
export function saveGetUpdatesBuf(accountId: string, getUpdatesBuf: string): void {
  const filePath = getSyncBufFilePath(accountId);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf } as SyncBufData, null, 0), "utf-8");
}
