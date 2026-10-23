import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { storageIdentity, withControlLock } from "../config/control-lock.js";
import { ProjectStore } from "../projects/project-store.js";
import type { ProjectStatus } from "../projects/types.js";
import { applyControl } from "./apply-control.js";
import { ControlStore } from "./control-store.js";
import { formatProjectRow, rpcCall } from "./rpc-client.js";

/** Resolve cwd (require exists + dir). Returns resolved absolute path. */
function resolveCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }
  return resolved;
}

export function projectCommand(): Command {
  return new Command("project")
    .description(
      "Manage projects.\n" +
        "  pi-wx project create <name> --cwd <path>\n" +
        "  pi-wx project <name> add|remove <account-name>... (case-sensitive; no IDs)\n" +
        "  pi-wx project list|show|enable|disable|restart|remove",
    )
    .option("--cwd <path>", "project working directory (for create; fixed after creation)")
    .argument("<args...>")
    .action(async (args: string[], opts: { cwd?: string }) => {
      const [first, ...rest] = args;
      if (!first) {
        console.error("usage: pi-wx project <verb|name> ...");
        process.exitCode = 1;
        return;
      }
      try {
        await dispatch(first, rest, opts);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}

/** Config and runtime are separate columns; an unavailable daemon is not "off". */
async function persistentProjects() {
  const configured = await withControlLock(() => new ProjectStore().list());
  let actual: ProjectStatus[] = [];
  try {
    const status = await rpcCall<{ identity: string; projects: ProjectStatus[] }>("daemon.status");
    if (status.identity !== storageIdentity()) throw new Error("Storage identity mismatch");
    actual = status.projects;
  } catch {
    console.warn(
      "Runtime unavailable or storage identity mismatch; showing configuration with unknown runtime state.",
    );
  }
  const names = new Set([...configured.map((p) => p.name), ...actual.map((p) => p.name)]);
  return [...names].map((name) => {
    const desired = configured.find((p) => p.name === name)?.config;
    const live = actual.find((p) => p.name === name);
    return {
      name,
      cwd: desired?.cwd ?? live?.cwd ?? "",
      accounts: desired?.accounts ?? live?.accounts ?? [],
      configured: !!desired,
      enabled: desired?.enabled ?? false,
      state: live?.state ?? "unknown",
    };
  });
}

async function dispatch(first: string, rest: string[], opts: { cwd?: string }): Promise<void> {
  const name = rest[0];
  switch (first) {
    case "list": {
      const list = await persistentProjects();
      if (list.length === 0) {
        console.log("No projects. Add one with `project create <name> --cwd <path>`.");
        return;
      }
      console.log("NAME        CONFIGURED STATE     ENABLED  ACCOUNTS            CWD");
      for (const p of list) console.log(formatProjectRow(p));
      return;
    }
    case "create": {
      if (!name || !opts.cwd) {
        throw new Error("usage: project create <name> --cwd <path>");
      }
      const cwd = resolveCwd(opts.cwd);
      await new ControlStore().project("create", name, { cwd });
      await applyControl();
      console.log(
        `Created project "${name}" (disabled). Enable it with \`project enable ${name}\`.`,
      );
      return;
    }
    case "show": {
      if (!name) throw new Error("usage: project show <name>");
      const p = (await persistentProjects()).find((project) => project.name === name);
      if (!p) throw new Error(`project "${name}" does not exist`);
      console.log(formatProjectRow(p));
      return;
    }
    case "enable":
    case "disable":
    case "restart":
    case "remove": {
      if (!name) throw new Error(`usage: project ${first} <name>`);
      if (first === "restart")
        await rpcCall("project.restart", { name, identity: storageIdentity() });
      else {
        await new ControlStore().project(first, name);
        await applyControl();
      }
      const past =
        first === "enable"
          ? "Enabled"
          : first === "disable"
            ? "Disabled"
            : first === "restart"
              ? "Restarted"
              : "Removed";
      console.log(`${past} project "${name}".`);
      return;
    }
    default: {
      // project <name> add|remove <label>...  (first = project name, rest[0] = verb)
      const projectName = first;
      const verb = rest[0];
      const labels = rest.slice(1);
      if ((verb === "add" || verb === "remove") && labels.length > 0) {
        await new ControlStore().project(`account.${verb}`, projectName, { names: labels });
        await applyControl();
        console.log(
          `${verb === "add" ? "Added" : "Removed"} account(s) ${verb === "add" ? "to" : "from"} project "${projectName}".`,
        );
        return;
      }
      throw new Error(
        `unknown project action. Try \`project create\`, \`project ${projectName} add <label>...\`, or \`project list\`.`,
      );
    }
  }
}
