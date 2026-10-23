import { Command } from "commander";
import { VERSION } from "../version.js";
import { listSelectableAccounts } from "./account-selection.js";
import { accountsCommand } from "./accounts.js";
import { broadcastCommand } from "./broadcast.js";
import {
  logsCommand,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from "./control.js";
import { doctorCommand } from "./doctor.js";
import { loginCommand } from "./login.js";
import { projectCommand } from "./project.js";
import { serveCommand } from "./serve.js";
import { serviceCommand } from "./service.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("pi-wx")
    .description("Connect Weixin iLink Bot with Pi Coding Agent (multi-project daemon)")
    .version(VERSION);
  program.addCommand(serveCommand());
  program.addCommand(serviceCommand());
  program.addCommand(startCommand());
  program.addCommand(stopCommand());
  program.addCommand(restartCommand());
  program.addCommand(statusCommand());
  program.addCommand(logsCommand());
  program.addCommand(loginCommand());
  program.addCommand(logoutCommand());
  program.addCommand(accountsCommand());
  program.addCommand(projectCommand());
  program.addCommand(broadcastCommand());
  program.addCommand(doctorCommand());
  return program;
}

function logoutCommand(): Command {
  return new Command("logout")
    .description(
      "Log out a Weixin account (clear credentials, unbind from projects, stop its monitor)",
    )
    .argument("<name>", "account name (case-sensitive; IDs are not accepted)")
    .action(async (account: string) => {
      const { rpcCall, DaemonNotRunningError } = await import("./rpc-client.js");
      const { requireAccountIdByName, unregisterWeixinAccountId, clearWeixinAccount } =
        await import("../weixin/auth/accounts.js");
      const { accounts, offline } = await listSelectableAccounts(true);
      const resolved = requireAccountIdByName(accounts, account);
      try {
        if (offline) throw new DaemonNotRunningError();
        await rpcCall("account.logout", { accountId: resolved });
        console.log(`Logged out account "${resolved}".`);
      } catch (err) {
        if (!(err instanceof DaemonNotRunningError)) throw err;
        // Only a failed connection permits offline credential removal; never retry an RPC.
        clearWeixinAccount(resolved);
        unregisterWeixinAccountId(resolved);
        console.log(`Logged out account "${resolved}" (daemon not running; credentials cleared).`);
      }
    });
}
