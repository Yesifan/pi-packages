import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { Command } from "commander";

const SERVICE_NAME = "pi-weixin-daemon";

/**
 * Resolve the CLI entry file's absolute path (for systemd ExecStart), verifying it exists.
 *
 * Prefers the *actually-invoked* binary (`process.argv[1]`). Under a real global install
 * (pnpm/npm install -g) this is the installed `dist/index.js` in the store — the daemon is
 * self-contained (its deps live in the store), so the systemd unit does not tie to a repo.
 * A shell shim (pnpm/npm global bin wrapper) is rejected; in that case we fall back to the
 * module-relative entry, which for a loaded global module is also the store's `dist/index.js`.
 */
function resolveCliEntry(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];

  // (1) The actually-invoked binary — only accept real JS/TS files (not a shell shim).
  if (process.argv[1] && /\.(js|mjs|cjs|ts)$/i.test(process.argv[1])) {
    try {
      const invoked = fs.realpathSync(process.argv[1]);
      if (fs.existsSync(invoked)) candidates.push(invoked);
    } catch {
      // ignore
    }
  }

  // (2) Module-relative entry: for a globally-installed module this is the store's index.js.
  candidates.push(path.join(moduleDir, "..", "index.js"), path.join(moduleDir, "..", "index.ts"));

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("cannot resolve pi-wx CLI entry path; is the package installed?");
}

function resolveUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

/** The systemd user unit content, with ExecStart resolved to this CLI. */
function buildUnit(): string {
  const cli = resolveCliEntry();
  const node = process.execPath;
  return [
    "[Unit]",
    "Description=Pi Weixin Daemon",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${node} ${cli} serve`,
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=15",
    // Optional model-API-key env (e.g. DEEPSEEK_API_KEY); `-` = OK if missing.
    "EnvironmentFile=-%h/.config/pi-weixin-daemon/env",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function serviceCommand(): Command {
  const cmd = new Command("service").description("Manage the systemd user service");

  cmd
    .command("install")
    .description("Write the systemd user unit for this CLI's absolute path")
    .action(() => {
      const unitPath = resolveUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, buildUnit(), "utf-8");
      console.log(`Wrote ${unitPath}`);
      console.log(`  ExecStart=${resolveCliEntry()}`);
      console.log("  EnvironmentFile=~/.config/pi-weixin-daemon/env");
      console.log("Next: `systemctl --user daemon-reload` then `pi-wx start`.");
      console.log(
        "To keep it running without a login shell: `loginctl enable-linger $USER` (do NOT use sudo).",
      );
    });

  cmd
    .command("uninstall")
    .description("Remove the systemd user unit")
    .action(() => {
      const unitPath = resolveUnitPath();
      fs.rmSync(unitPath, { force: true });
      console.log(`Removed ${unitPath}`);
      console.log("Next: `systemctl --user daemon-reload`.");
    });

  return cmd;
}
