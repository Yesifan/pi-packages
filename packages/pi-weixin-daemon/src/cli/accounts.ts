import { Command } from "commander";
import type { AccountInfo } from "../projects/types.js";
import { rpcCall } from "./rpc-client.js";

/**
 * `pi-wx accounts`
 *
 * Read account status from the running daemon (RPC). Shows the account label,
 * its ilink_bot_id, status, the bound project and login time.
 */
export function accountsCommand(): Command {
  return new Command("accounts")
    .description("List Weixin accounts (from the running daemon)")
    .action(async () => {
      const accounts = await rpcCall<AccountInfo[]>("account.list");
      if (accounts.length === 0) {
        console.log("No accounts. Run `pi-wx login --name <label>` to add one.");
        return;
      }
      console.log("NAME        ID                         STATUS         USER              PROJECT        SINCE");
      for (const a of accounts) {
        const name = a.name ?? a.accountId;
        const user = a.userId ?? "-";
        const project = a.projectId ?? "-";
        const since = (a.since ?? "").length > 19 ? a.since!.slice(0, 19) : a.since ?? "-";
        console.log(
          `${name.padEnd(11)}${a.accountId.padEnd(26)}${a.status.padEnd(15)}${user.padEnd(17)}${project.padEnd(15)}${since}`,
        );
      }
    });
}
