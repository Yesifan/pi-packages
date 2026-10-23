import { withControlLock } from "../config/control-lock.js";
import { migrateLegacyAccounts } from "../config/paths.js";
import { ProjectStore } from "../projects/project-store.js";
import {
  listIndexedWeixinAccountIds,
  listLocalNamedAccounts,
  loadWeixinAccount,
  requireAccountIdByName,
  saveWeixinAccount,
  saveWeixinAccountIds,
} from "../weixin/auth/accounts.js";

/** CLI-only control writes. Never call daemon RPC while holding this lock. */
export class ControlStore {
  constructor(readonly projects = new ProjectStore()) {}

  private mutate<T>(operation: () => T): Promise<T> {
    return withControlLock(() => {
      migrateLegacyAccounts();
      // Validate all control input before any requested modification.
      this.projects.read();
      listLocalNamedAccounts();
      return operation();
    });
  }

  private requireUnbound(ids: string[]): void {
    for (const { name, config } of this.projects.list()) {
      for (const id of ids) {
        if (config.accounts.includes(id))
          throw new Error(
            `Account ${id} is bound to project ${name}; unbind first with pi-wx project ${name} remove <account-name>`,
          );
      }
    }
  }

  logout(name: string): Promise<string[]> {
    return this.mutate(() => {
      const id = requireAccountIdByName(listLocalNamedAccounts(), name);
      this.requireUnbound([id]);
      saveWeixinAccountIds(listIndexedWeixinAccountIds().filter((other) => other !== id));
      return [id];
    });
  }

  login(
    id: string,
    data: { token?: string; baseUrl?: string; userId?: string; name: string },
  ): Promise<string[]> {
    return this.mutate(() => {
      const ids = listIndexedWeixinAccountIds();
      const replaced = ids.filter(
        (other) => other !== id && data.userId && loadWeixinAccount(other)?.userId === data.userId,
      );
      const collision = listLocalNamedAccounts().find(
        (account) =>
          account.name === data.name &&
          account.accountId !== id &&
          !replaced.includes(account.accountId),
      );
      if (collision) throw new Error(`Account name ${data.name} is already used`);
      this.requireUnbound(replaced);
      // No multi-file transaction: an index failure can leave unregistered credentials.
      saveWeixinAccount(id, data);
      saveWeixinAccountIds([
        ...ids.filter((other) => other !== id && !replaced.includes(other)),
        id,
      ]);
      return replaced;
    });
  }

  project(
    action: string,
    name: string,
    options: { cwd?: string; names?: string[] } = {},
  ): Promise<void> {
    return this.mutate(() => {
      switch (action) {
        case "create":
          if (this.projects.get(name)) throw new Error(`project "${name}" already exists`);
          if (!options.cwd) throw new Error("cwd required");
          this.projects.upsert(name, { cwd: options.cwd, accounts: [], enabled: false });
          break;
        case "enable":
        case "disable":
          this.projects.setEnabled(name, action === "enable");
          break;
        case "remove":
          this.projects.remove(name);
          break;
        case "account.add":
        case "account.remove": {
          const ids = (options.names ?? []).map((label) =>
            requireAccountIdByName(listLocalNamedAccounts(), label),
          );
          if (action === "account.add") this.projects.addAccounts(name, ids);
          else this.projects.removeAccounts(name, ids);
          break;
        }
        default:
          throw new Error(`Unknown project operation ${action}`);
      }
    });
  }
}
