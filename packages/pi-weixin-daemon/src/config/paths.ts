import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * XDG-resolution for all pi-weixin-daemon paths.
 *
 * Layout (unified, XDG-compliant):
 *   config  : $XDG_CONFIG_HOME/pi-weixin-daemon/config.json  (project config — daemon is sole writer)
 *   data    : $XDG_DATA_HOME/pi-weixin-daemon/accounts/      (account credentials / index)
 *   state   : $XDG_STATE_HOME/pi-weixin-daemon/weixin/       (sync-buf, context-tokens — ephemeral)
 *   runtime : $XDG_RUNTIME_DIR/pi-weixin-daemon/daemon.sock  (UDS)
 *
 * Overrides (kept for migration / tests):
 *   PI_WEIXIN_STATE_DIR  — legacy state base; still honored.
 *   PI_WEIXIN_DATA_DIR   — accounts base override.
 */

/** Read an env var, falling back to `fallback` when unset/blank. */
function envOr(env: string, fallback: string): string {
  const v = process.env[env]?.trim();
  return v || fallback;
}

/** Resolve the daemon config directory: $XDG_CONFIG_HOME/pi-weixin-daemon. */
export function resolveConfigDir(): string {
  return path.join(envOr("XDG_CONFIG_HOME", path.join(os.homedir(), ".config")), "pi-weixin-daemon");
}

/** Resolve the project config file path. */
export function resolveConfigPath(): string {
  return path.join(resolveConfigDir(), "config.json");
}

/** Resolve the daemon data directory: $XDG_DATA_HOME/pi-weixin-daemon. */
export function resolveDataDir(): string {
  return (
    process.env.PI_WEIXIN_DATA_DIR?.trim() ||
    path.join(envOr("XDG_DATA_HOME", path.join(os.homedir(), ".local", "share")), "pi-weixin-daemon")
  );
}

/** Resolve the account credentials directory (data). */
export function resolveAccountsDir(): string {
  return path.join(resolveDataDir(), "accounts");
}

/** Resolve the daemon state directory: $XDG_STATE_HOME/pi-weixin-daemon. */
export function resolveStateDir(): string {
  return (
    process.env.PI_WEIXIN_STATE_DIR?.trim() ||
    path.join(envOr("XDG_STATE_HOME", path.join(os.homedir(), ".local", "state")), "pi-weixin-daemon")
  );
}

/** Resolve the weixin sub-state directory (sync-buf, context-tokens). */
export function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "weixin");
}

/** Resolve the per-account data directory under the legacy state layout (pre-unification). */
export function resolveLegacyAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

/** Resolve the daemon runtime directory: $XDG_RUNTIME_DIR/pi-weixin-daemon. */
export function resolveRuntimeDir(): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const base = envOr("XDG_RUNTIME_DIR", `/run/user/${uid}`);
  return path.join(base, "pi-weixin-daemon");
}

/** Resolve the daemon UDS socket path. */
export function resolveDaemonSocket(): string {
  return path.join(resolveRuntimeDir(), "daemon.sock");
}

/**
 * One-shot, idempotent, non-lossy migration of account credentials from the
 * legacy state dir (`<state>/weixin/accounts`) to the XDG data dir
 * (`<data>/accounts`). Only copies files/dirs that do not already exist in the
 * target, so re-running is safe and never overwrites newer data.
 */
export function migrateLegacyAccounts(): void {
  const legacyDir = resolveLegacyAccountsDir();
  const targetDir = resolveAccountsDir();
  if (!fs.existsSync(legacyDir)) return;

  fs.mkdirSync(targetDir, { recursive: true });
  let copied = false;
  for (const name of fs.readdirSync(legacyDir)) {
    const src = path.join(legacyDir, name);
    const dest = path.join(targetDir, name);
    try {
      if (!fs.statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(src, dest);
    copied = true;
  }

  // Migrate the accounts.json index too.
  const legacyIndex = path.join(resolveWeixinStateDir(), "accounts.json");
  const targetIndex = path.join(targetDir, "accounts.json");
  if (fs.existsSync(legacyIndex) && !fs.existsSync(targetIndex)) {
    fs.copyFileSync(legacyIndex, targetIndex);
    copied = true;
  }

  if (copied) {
    // Only remove the legacy dir when it is now empty of files (best-effort,
    // non-destructive). Never rm -rf a directory the user may have other data in.
    try {
      const remaining = fs.readdirSync(legacyDir).filter((n) => {
        try {
          return fs.statSync(path.join(legacyDir, n)).isFile();
        } catch {
          return false;
        }
      });
      if (remaining.length === 0 && fs.existsSync(path.join(resolveWeixinStateDir(), "accounts.json")) === false) {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      }
    } catch {
      // best-effort; leave legacy dir in place
    }
  }
}
