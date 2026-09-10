import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clearStaleAccountsForUserId,
  clearWeixinAccount,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  resolveWeixinAccountIdByName,
  resolveWeixinAccountName,
  saveWeixinAccount,
  unregisterWeixinAccountId,
} from "../../src/weixin/auth/accounts.js";

const OLD_ENV = process.env.PI_WEIXIN_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "data-"));
  process.env.PI_WEIXIN_DATA_DIR = dataDir;
});

afterEach(() => {
  if (OLD_ENV === undefined) {
    delete process.env.PI_WEIXIN_DATA_DIR;
  } else {
    process.env.PI_WEIXIN_DATA_DIR = OLD_ENV;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("weixin account store", () => {
  it("registers and lists accounts", () => {
    expect(listIndexedWeixinAccountIds()).toEqual([]);
    registerWeixinAccountId("acct-a");
    registerWeixinAccountId("acct-b");
    registerWeixinAccountId("acct-a"); // no-op
    expect(listIndexedWeixinAccountIds()).toEqual(["acct-a", "acct-b"]);
  });

  it("unregisters an account", () => {
    registerWeixinAccountId("acct-a");
    registerWeixinAccountId("acct-b");
    unregisterWeixinAccountId("acct-a");
    expect(listIndexedWeixinAccountIds()).toEqual(["acct-b"]);
  });

  it("saves and loads account data with merge semantics", () => {
    saveWeixinAccount("acct-a", { token: "tok-1" });
    let data = loadWeixinAccount("acct-a");
    expect(data?.token).toBe("tok-1");
    expect(data?.savedAt).toBeTruthy();

    // second save keeps token, adds userId
    saveWeixinAccount("acct-a", { userId: "user-1", baseUrl: "https://example.com" });
    data = loadWeixinAccount("acct-a");
    expect(data?.token).toBe("tok-1");
    expect(data?.userId).toBe("user-1");
    expect(data?.baseUrl).toBe("https://example.com");

    // empty userId clears it
    saveWeixinAccount("acct-a", { userId: "" });
    data = loadWeixinAccount("acct-a");
    expect(data?.userId).toBeUndefined();
    expect(data?.token).toBe("tok-1");
  });

  it("returns null for unknown account", () => {
    expect(loadWeixinAccount("nope")).toBeNull();
  });

  it("rejects malformed account files (zod validation)", () => {
    const dir = path.join(dataDir, "accounts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ token: 123 }), "utf-8");
    expect(loadWeixinAccount("bad")).toBeNull();
  });

  it("clears stale accounts sharing the same userId", () => {
    registerWeixinAccountId("old-acct");
    registerWeixinAccountId("new-acct");
    saveWeixinAccount("old-acct", { token: "t", userId: "user-x" });
    saveWeixinAccount("new-acct", { token: "t2", userId: "user-y" });

    const cleared: string[] = [];
    clearStaleAccountsForUserId("new-acct", "user-x", (id) => cleared.push(id));

    expect(cleared).toEqual(["old-acct"]);
    expect(listIndexedWeixinAccountIds()).toEqual(["new-acct"]);
    expect(loadWeixinAccount("old-acct")).toBeNull();
  });

  it("stores and resolves an account name label", () => {
    registerWeixinAccountId("acct-a");
    registerWeixinAccountId("acct-b");
    saveWeixinAccount("acct-a", { token: "t-a", name: "personal" });
    saveWeixinAccount("acct-b", { token: "t-b", name: "work" });

    expect(resolveWeixinAccountName("acct-a")).toBe("personal");
    expect(resolveWeixinAccountIdByName("personal")).toBe("acct-a");
    expect(resolveWeixinAccountIdByName("work")).toBe("acct-b");
    expect(resolveWeixinAccountIdByName("nope")).toBeUndefined();

    // name persists across merge (saving token again keeps name)
    saveWeixinAccount("acct-a", { token: "t-a2" });
    expect(resolveWeixinAccountName("acct-a")).toBe("personal");
  });

  it("clearWeixinAccount removes all account files", () => {
    registerWeixinAccountId("acct-a");
    saveWeixinAccount("acct-a", { token: "t" });
    const dir = path.join(dataDir, "accounts");
    fs.writeFileSync(path.join(dir, "acct-a.sync.json"), "{}", "utf-8");

    clearWeixinAccount("acct-a");
    expect(loadWeixinAccount("acct-a")).toBeNull();
    expect(fs.existsSync(path.join(dataDir, "accounts", "acct-a.sync.json"))).toBe(false);
  });
});
