import fs from "node:fs";
import path from "node:path";
import { acquireInstanceLock, storageIdentity, withControlLock } from "../config/control-lock.js";
import { resolveAccountsDir } from "../config/paths.js";
import { listIndexedWeixinAccountIds } from "../weixin/auth/accounts.js";
import { DaemonNotRunningError, rpcCall } from "./rpc-client.js";

interface ControlStatus {
  identity: string;
  runningAccountIds: string[];
}
function validateStatus(value: ControlStatus, identity: string): ControlStatus {
  if (
    value?.identity !== identity ||
    !Array.isArray(value.runningAccountIds) ||
    !value.runningAccountIds.every((id) => typeof id === "string")
  ) {
    throw new Error("Invalid control response or storage identity mismatch");
  }
  return value;
}

/** Persistence has already committed. Never roll it back on application failure. */
export async function applyControl(removed: string[] = []): Promise<void> {
  let identity = "";
  let offline = false;
  try {
    identity = storageIdentity();
    validateStatus(await rpcCall<ControlStatus>("control.sync", { identity }), identity);
  } catch (error) {
    if (error instanceof DaemonNotRunningError) {
      try {
        offline = await withControlLock(async () => {
          const release = await acquireInstanceLock();
          if (!release) return false;
          release();
          return true;
        });
      } catch {
        /* Cannot prove offline: keep the saved/unknown failure result. */
      }
    }
    if (!offline) {
      if (removed.length)
        console.warn(
          "Files retained: first stop the account receivers (reload/restart) before manually removing account files.",
        );
      throw new Error(
        `Configuration saved; application failed or unknown; not rolled back. Reload/restart to synchronize. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(
    offline
      ? "Configuration saved; daemon confirmed offline, pending next startup."
      : "Configuration saved; daemon applied current desired state (concurrent changes may supersede this command).",
  );
  if (removed.length) await cleanupRemovedAccounts(removed, identity);
}

/** Revalidate under the shared lock; an earlier apply response alone is not a cleanup permit. */
export async function cleanupRemovedAccounts(
  removed: string[],
  identity = storageIdentity(),
): Promise<void> {
  try {
    await withControlLock(async () => {
      const registered = new Set(listIndexedWeixinAccountIds());
      const targets = removed.filter((id) => !registered.has(id));
      for (const id of removed.filter((id) => registered.has(id)))
        console.warn(`Cleanup skipped: ${id} was registered again.`);
      if (!targets.length) return;
      const release = await acquireInstanceLock();
      try {
        if (!release) {
          const status = validateStatus(
            await rpcCall<ControlStatus>("control.status", { identity }),
            identity,
          );
          if (targets.some((id) => status.runningAccountIds.includes(id)))
            throw new Error("receiver stop not confirmed");
        }
        for (const id of targets) {
          for (const suffix of [".sync.json", ".context-tokens.json", ".json"]) {
            const file = path.join(resolveAccountsDir(), `${id}${suffix}`);
            try {
              fs.unlinkSync(file);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                console.warn(`Cleanup warning: manually remove residual file ${file}`);
            }
          }
        }
      } finally {
        release?.();
      }
    });
  } catch {
    console.warn(
      `Cleanup skipped: stop not confirmed. First stop related receivers, then manually remove residual files for ${removed.map((id) => path.join(resolveAccountsDir(), id)).join(", ")} (.json, .sync.json, .context-tokens.json).`,
    );
    throw new Error(
      "Configuration saved; current receiver stop could not be confirmed. Files retained; reload/restart before cleanup.",
    );
  }
}
