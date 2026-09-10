import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  migrateLegacyAccounts,
  resolveAccountsDir,
  resolveConfigPath,
  resolveDaemonSocket,
  resolveRuntimeDir,
  resolveStateDir,
} from "../../src/config/paths.js";

const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
const OLD_STATE = process.env.PI_WEIXIN_STATE_DIR;
let dataDir: string;
let stateDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "pdata-"));
  stateDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "pstate-"));
  process.env.PI_WEIXIN_DATA_DIR = dataDir;
  process.env.PI_WEIXIN_STATE_DIR = stateDir;
});

afterEach(() => {
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  if (OLD_STATE === undefined) delete process.env.PI_WEIXIN_STATE_DIR;
  else process.env.PI_WEIXIN_STATE_DIR = OLD_STATE;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("paths (XDG layout)", () => {
  it("separates config/data/state/runtime", () => {
    expect(resolveStateDir()).toBe(stateDir);
    expect(resolveAccountsDir()).toBe(path.join(dataDir, "accounts"));
    expect(resolveConfigPath()).toMatch(/pi-weixin-daemon[/\\]config\.json$/);
    expect(resolveDaemonSocket()).toMatch(/daemon\.sock$/);
    // runtime dir uses XDG_RUNTIME_DIR if set, else /run/user/<uid>
    expect(resolveRuntimeDir()).toBeTruthy();
  });

  it("migrates legacy accounts (state weixin/accounts) to data dir, idempotently", () => {
    const legacyDir = path.join(stateDir, "weixin", "accounts");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "acct-a.json"), JSON.stringify({ token: "t1" }), "utf-8");
    fs.writeFileSync(path.join(stateDir, "weixin", "accounts.json"), JSON.stringify(["acct-a"]), "utf-8");

    migrateLegacyAccounts();
    expect(fs.existsSync(path.join(dataDir, "accounts", "acct-a.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "accounts", "accounts.json"))).toBe(true);

    // idempotent: second run doesn't clobber existing target
    fs.writeFileSync(path.join(dataDir, "accounts", "acct-a.json"), JSON.stringify({ token: "t2" }), "utf-8");
    migrateLegacyAccounts();
    const moved = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts", "acct-a.json"), "utf-8"));
    expect(moved.token).toBe("t2");
  });

  it("migration is a no-op when no legacy accounts exist", () => {
    migrateLegacyAccounts();
    expect(fs.existsSync(path.join(dataDir, "accounts"))).toBe(false);
  });
});
