import { listLocalNamedAccounts, type NamedAccount } from "../weixin/auth/accounts.js";
import { DaemonNotRunningError, rpcCall } from "./rpc-client.js";

/** The daemon is authoritative; only a failed connection permits local selection. */
export async function listSelectableAccounts(
  allowOffline = false,
): Promise<{ accounts: NamedAccount[]; offline: boolean }> {
  try {
    return { accounts: await rpcCall<NamedAccount[]>("account.list"), offline: false };
  } catch (error) {
    if (!allowOffline || !(error instanceof DaemonNotRunningError)) throw error;
    return { accounts: listLocalNamedAccounts(), offline: true };
  }
}
