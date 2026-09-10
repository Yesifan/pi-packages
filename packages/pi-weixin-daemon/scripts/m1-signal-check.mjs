// M1 acceptance (updated for M4+): daemon starts with a fake logged-in account,
// runs, and exits gracefully on SIGTERM.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "dist", "index.js");

// Prepare a fake account so `run` gets past the login check.
const stateDir = path.join(root, "test", ".tmp", "signal-state");
fs.mkdirSync(path.join(stateDir, "weixin", "accounts"), { recursive: true });
fs.writeFileSync(path.join(stateDir, "weixin", "accounts.json"), JSON.stringify(["acct-a"]), "utf-8");
fs.writeFileSync(
  path.join(stateDir, "weixin", "accounts", "acct-a.json"),
  JSON.stringify({ token: "fake-token-for-signal-test", baseUrl: "https://example.com" }),
  "utf-8",
);

const child = spawn(
  process.execPath,
  [bin, "run", "--cwd", root, "--account", "acct-a"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_WEIXIN_STATE_DIR: stateDir },
  },
);

let output = "";
child.stdout.on("data", (d) => (output += d.toString()));
child.stderr.on("data", (d) => (output += d.toString()));

const timer = setTimeout(() => child.kill("SIGTERM"), 2500);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  console.log("exit code:", code, "signal:", signal);
  const started = output.includes("daemon started");
  const stopped = output.includes("daemon stopped");
  const ok = started && stopped && code === 0;
  if (!ok) console.log(output);
  console.log(ok ? "M1 ACCEPT: graceful start + SIGTERM stop" : "M1 FAIL");
  process.exit(ok ? 0 : 1);
});
