import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const originalCwd = process.cwd();
const originalEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
  PI_OFFLINE: process.env.PI_OFFLINE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  PI_WEIXIN_DATA_DIR: process.env.PI_WEIXIN_DATA_DIR,
  PI_WEIXIN_STATE_DIR: process.env.PI_WEIXIN_STATE_DIR,
};
let agentDir: string;

/** Set before workers start: no SDK test reads or writes the user's Pi state. */
export function setup(): void {
  process.chdir(PACKAGE_ROOT);
  fs.mkdirSync(path.join(PACKAGE_ROOT, "test/.tmp"), { recursive: true });
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wx-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  process.env.PI_OFFLINE = "1";
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "PI_WEIXIN_DATA_DIR",
    "PI_WEIXIN_STATE_DIR",
  ]) {
    process.env[key] = path.join(agentDir, key);
  }
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ cacheWarming: "off", retry: { enabled: false } }),
  );
}

export function teardown(): void {
  try {
    fs.rmSync(agentDir, { recursive: true, force: true });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.chdir(originalCwd);
  }
}
