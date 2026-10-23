import { Command } from "commander";
import { storageIdentity, withControlLock } from "../config/control-lock.js";
import { ProjectStore } from "../projects/project-store.js";
import type { AccountInfo } from "../projects/types.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount } from "../weixin/auth/accounts.js";
import { rpcCall } from "./rpc-client.js";

/**
 * `pi-wx accounts`
 *
 * Read persisted registration locally and merge the matching daemon runtime.
 * Unavailable runtime remains unknown; removed-but-active receivers stay visible.
 */
export function accountsCommand(): Command {
  return new Command("accounts")
    .description("List saved account registration separately from actual receiver status")
    .action(async () => {
      const saved = await withControlLock(() => {
        const projects = new ProjectStore().list();
        return listIndexedWeixinAccountIds().map((accountId) => {
          const data = loadWeixinAccount(accountId);
          return {
            accountId,
            name: data?.name,
            userId: data?.userId,
            since: data?.savedAt,
            projectId: projects.find((p) => p.config.accounts.includes(accountId))?.name,
          };
        });
      });
      let actual: AccountInfo[] = [];
      try {
        const status = await rpcCall<{ identity: string; accounts: AccountInfo[] }>(
          "daemon.status",
        );
        if (status.identity !== storageIdentity()) throw new Error("Storage identity mismatch");
        actual = status.accounts;
      } catch {
        console.warn(
          "Runtime unavailable or storage identity mismatch; receiver status is unknown.",
        );
      }
      const ids = new Set([...saved.map((a) => a.accountId), ...actual.map((a) => a.accountId)]);
      const accounts = [...ids].map((accountId) => {
        const desired = saved.find((a) => a.accountId === accountId);
        const live = actual.find((a) => a.accountId === accountId);
        return {
          ...live,
          ...desired,
          accountId,
          registered: !!desired,
          status: live?.status ?? "unknown",
        };
      });
      if (accounts.length === 0) {
        console.log("No accounts. Run `pi-wx login --name <label>` to add one.");
        return;
      }
      console.log(
        "NAME        ID                         REGISTERED  STATUS         USER              PROJECT        SINCE",
      );
      for (const a of accounts) {
        const name = a.name ?? a.accountId;
        const user = a.userId ?? "-";
        const project = a.projectId ?? "-";
        const sinceValue = a.since ?? "";
        const since = sinceValue.length > 19 ? sinceValue.slice(0, 19) : sinceValue || "-";
        console.log(
          `${name.padEnd(11)}${a.accountId.padEnd(26)}${(a.registered === false ? "no" : "yes").padEnd(12)}${a.status.padEnd(15)}${user.padEnd(17)}${project.padEnd(15)}${since}`,
        );
      }
    });
}
