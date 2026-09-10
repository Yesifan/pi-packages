import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clearContextTokensForAccount,
  findAccountIdsByContextToken,
  getContextToken,
  restoreContextTokens,
  setContextToken,
} from "../../src/weixin/storage/context-token.js";

const OLD_ENV = process.env.PI_WEIXIN_STATE_DIR;
const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "ctx-state-"));
  process.env.PI_WEIXIN_STATE_DIR = stateDir;
  process.env.PI_WEIXIN_DATA_DIR = stateDir;
});

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.PI_WEIXIN_STATE_DIR;
  else process.env.PI_WEIXIN_STATE_DIR = OLD_ENV;
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("context token store", () => {
  it("stores and retrieves per account+user tokens", () => {
    setContextToken("acct-a", "user-1", "tok-a1");
    setContextToken("acct-b", "user-1", "tok-b1");
    expect(getContextToken("acct-a", "user-1")).toBe("tok-a1");
    expect(getContextToken("acct-b", "user-1")).toBe("tok-b1");
    expect(getContextToken("acct-a", "user-2")).toBeUndefined();
  });

  it("persists to disk and restores across restart", () => {
    setContextToken("acct-a", "user-1", "tok-persist");

    // simulate restart: clear memory via a fresh lookup path (restore overwrites)
    const file = path.join(stateDir, "accounts", "acct-a.context-tokens.json");
    expect(fs.existsSync(file)).toBe(true);

    // restore into a fresh process state
    restoreContextTokens("acct-a");
    expect(getContextToken("acct-a", "user-1")).toBe("tok-persist");
  });

  it("clearContextTokensForAccount removes memory and disk", () => {
    setContextToken("acct-a", "user-1", "tok");
    clearContextTokensForAccount("acct-a");
    expect(getContextToken("acct-a", "user-1")).toBeUndefined();
    const file = path.join(stateDir, "accounts", "acct-a.context-tokens.json");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("findAccountIdsByContextToken finds accounts with an active token", () => {
    setContextToken("acct-a", "user-9", "t");
    expect(findAccountIdsByContextToken(["acct-a", "acct-b"], "user-9")).toEqual(["acct-a"]);
    expect(findAccountIdsByContextToken(["acct-a", "acct-b"], "other")).toEqual([]);
  });
});
