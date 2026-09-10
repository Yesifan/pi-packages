import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveAccountsDir, resolveStateDir } from "../storage/state-dir.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ---------------------------------------------------------------------------
// Account data schema (zod4 validation)
// ---------------------------------------------------------------------------

export const WeixinAccountDataSchema = z.object({
  token: z.string().optional(),
  savedAt: z.string().optional(),
  baseUrl: z.string().optional(),
  /** Last linked Weixin user id from QR login (optional). */
  userId: z.string().optional(),
  /** User-chosen account label (globally unique). The account id remains ilink_bot_id. */
  name: z.string().optional(),
});

export type WeixinAccountData = z.infer<typeof WeixinAccountDataSchema>;

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveAccountIndexPath(): string {
  // Colocate the account index with per-account credential files (data dir), so
  // the whole account store reads/writes from one place.
  return path.join(resolveAccountsDir(), "accounts.json");
}

/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = z.array(z.string().min(1)).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Add accountId to the persistent index (no-op if already present). */
export function registerWeixinAccountId(accountId: string): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(accountId)) return;

  const updated = [...existing, accountId];
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

/** Remove accountId from the persistent index. */
export function unregisterWeixinAccountId(accountId: string): void {
  const existing = listIndexedWeixinAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

/**
 * Remove stale accounts that share the same userId as the newly-bound account.
 * Called after a successful QR login to ensure only the latest account remains
 * for a given WeChat user, preventing ambiguous contextToken matches.
 *
 * @param onClearContextTokens callback to clear context tokens for the removed account
 */
export function clearStaleAccountsForUserId(
  currentAccountId: string,
  userId: string,
  onClearContextTokens?: (accountId: string) => void,
): void {
  if (!userId) return;
  const allIds = listIndexedWeixinAccountIds();
  for (const id of allIds) {
    if (id === currentAccountId) continue;
    const data = loadWeixinAccount(id);
    if (data?.userId?.trim() === userId) {
      onClearContextTokens?.(id);
      clearWeixinAccount(id);
      unregisterWeixinAccountId(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = WeixinAccountDataSchema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf-8")));
      return parsed.success ? parsed.data : null;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID. */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  return readAccountFile(resolveAccountPath(accountId));
}

/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolution falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string; name?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;
  const name =
    update.name !== undefined
      ? update.name.trim() || undefined
      : existing.name?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
    ...(name ? { name } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** Resolve the account id (ilink_bot_id) for a given account label, if any. */
export function resolveWeixinAccountIdByName(name: string): string | undefined {
  const target = name.trim();
  if (!target) return undefined;
  for (const id of listIndexedWeixinAccountIds()) {
    if (loadWeixinAccount(id)?.name?.trim() === target) return id;
  }
  return undefined;
}

/** Resolve the account label for a given account id (ilink_bot_id), if any. */
export function resolveWeixinAccountName(accountId: string): string | undefined {
  return loadWeixinAccount(accountId)?.name?.trim() || undefined;
}

/** Resolve the effective API base URL for an account. */
export function resolveWeixinBaseUrl(accountId: string): string {
  return loadWeixinAccount(accountId)?.baseUrl?.trim() || DEFAULT_BASE_URL;
}

/**
 * Remove all files associated with an account:
 *   - accounts/{accountId}.json
 *   - accounts/{accountId}.sync.json
 *   - accounts/{accountId}.context-tokens.json
 */
export function clearWeixinAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  const accountFiles = [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
  ];
  for (const file of accountFiles) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // ignore if not found
    }
  }
}

// Re-export for callers that need the state dir root.
export { resolveStateDir };
