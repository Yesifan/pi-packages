import { Command } from "commander";
import { accountsCommand } from "./accounts.js";
import { logsCommand, restartCommand, startCommand, statusCommand, stopCommand } from "./control.js";
import { doctorCommand } from "./doctor.js";
import { loginCommand } from "./login.js";
import { projectCommand } from "./project.js";
import { serveCommand } from "./serve.js";
import { serviceCommand } from "./service.js";
import { VERSION } from "../version.js";

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
  program.addCommand(doctorCommand());
  return program;
}

function logoutCommand(): Command {
  return new Command("logout")
    .description("Log out a Weixin account (clear credentials, unbind from projects, stop its monitor)")
    .argument("<account>", "account id or name")
    .action(async (account: string) => {
      try {
        const { rpcCall } = await import("./rpc-client.js");
        const list = await rpcCall<Array<{ accountId: string; name?: string }>>("account.list");
        const hit = list.find((a) => a.accountId === account || a.name === account);
        const accountId = (hit?.accountId ?? account) as string;
        const { resolveWeixinAccountIdByName } = await import("../weixin/auth/accounts.js");
        const resolved = resolveWeixinAccountIdByName(account) ?? accountId;
        await rpcCall("account.logout", { accountId: resolved });
        console.log(`Logged out account "${resolved}".`);
      } catch {
        // daemon not running: fall back to local credential removal.
        const { unregisterWeixinAccountId, clearWeixinAccount } = await import(
          "../weixin/auth/accounts.js"
        );
        clearWeixinAccount(account);
        unregisterWeixinAccountId(account);
        console.log(`Logged out account "${account}" (daemon not running; credentials cleared).`);
      }
    });
}
