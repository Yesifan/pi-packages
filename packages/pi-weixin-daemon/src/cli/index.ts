import { Command } from "commander";
import { storageIdentity } from "../config/control-lock.js";
import { VERSION } from "../version.js";
import { accountsCommand } from "./accounts.js";
import { applyControl } from "./apply-control.js";
import { broadcastCommand } from "./broadcast.js";
import {
  logsCommand,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from "./control.js";
import { ControlStore } from "./control-store.js";
import { doctorCommand } from "./doctor.js";
import { loginCommand } from "./login.js";
import { projectCommand } from "./project.js";
import { promptCommand } from "./prompt.js";
import { rpcCall } from "./rpc-client.js";
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
  program
    .command("reload")
    .description("Apply current saved configuration (daemon must be online)")
    .action(async () => {
      await rpcCall("control.sync", { identity: storageIdentity() });
      console.log("Daemon applied current saved configuration.");
    });
  program.addCommand(loginCommand());
  program.addCommand(logoutCommand());
  program.addCommand(accountsCommand());
  program.addCommand(projectCommand());
  program.addCommand(broadcastCommand());
  program.addCommand(promptCommand());
  program.addCommand(doctorCommand());
  return program;
}

function logoutCommand(): Command {
  return new Command("logout")
    .description(
      "Remove an unbound account: save registration, synchronize receivers, then safely clean files",
    )
    .argument("<name>", "account name (case-sensitive; IDs are not accepted)")
    .action(async (account: string) => {
      const removed = await new ControlStore().logout(account);
      await applyControl(removed);
    });
}
