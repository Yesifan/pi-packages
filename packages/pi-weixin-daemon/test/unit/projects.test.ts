import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CONFIG_VERSION,
  validateProjectForInsert,
  validateProjectStoreData,
} from "../../src/projects/project-schema.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import { registerWeixinAccountId } from "../../src/weixin/auth/accounts.js";

const OLD_DATA = process.env.PI_WEIXIN_DATA_DIR;
let dataDir: string;

function tmpConfig(): string {
  return path.join(dataDir, "config.json");
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "proj-"));
  process.env.PI_WEIXIN_DATA_DIR = dataDir;
  registerWeixinAccountId("acct-a");
  registerWeixinAccountId("acct-b");
});

afterEach(() => {
  if (OLD_DATA === undefined) delete process.env.PI_WEIXIN_DATA_DIR;
  else process.env.PI_WEIXIN_DATA_DIR = OLD_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("project-schema", () => {
  it("accepts a valid config", () => {
    const result = validateProjectStoreData({
      version: CONFIG_VERSION,
      projects: {
        foo: { cwd: process.cwd(), accounts: ["acct-a"], enabled: true },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a project sharing an account across two projects", () => {
    const result = validateProjectStoreData({
      version: CONFIG_VERSION,
      projects: {
        foo: { cwd: process.cwd(), accounts: ["acct-a"], enabled: true },
        bar: { cwd: process.cwd(), accounts: ["acct-a"], enabled: false },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("")).toMatch(/account "acct-a" is already assigned to project "foo"/);
  });

  it("rejects a non-existent cwd", () => {
    const result = validateProjectStoreData({
      version: CONFIG_VERSION,
      projects: {
        foo: { cwd: "/definitely/not/a/dir", accounts: [], enabled: true },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("")).toMatch(/cwd does not exist/);
  });

  it("rejects an unregistered account", () => {
    const result = validateProjectStoreData({
      version: CONFIG_VERSION,
      projects: { foo: { cwd: process.cwd(), accounts: ["not-registered"], enabled: true } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("")).toMatch(/is not registered/);
  });
});

describe("project-store", () => {
  it("reads an empty/default config when none exists", () => {
    const store = new ProjectStore(tmpConfig());
    expect(store.read()).toEqual({ version: CONFIG_VERSION, projects: {} });
    expect(store.list()).toEqual([]);
  });

  it("upserts, lists, enables, and removes a project", () => {
    const store = new ProjectStore(tmpConfig());
    store.upsert("foo", { cwd: process.cwd(), accounts: ["acct-a"], enabled: false });
    store.upsert("bar", { cwd: process.cwd(), accounts: ["acct-b"], enabled: false });

    expect(store.list().map((p) => p.name)).toEqual(["foo", "bar"]);
    expect(store.get("foo")?.accounts).toEqual(["acct-a"]);

    store.setEnabled("foo", true);
    expect(store.get("foo")?.enabled).toBe(true);

    store.remove("bar");
    expect(store.get("bar")).toBeUndefined();
    expect(store.list().map((p) => p.name)).toEqual(["foo"]);
  });

  it("rejects adding a project that claims another project's account", () => {
    const store = new ProjectStore(tmpConfig());
    store.upsert("foo", { cwd: process.cwd(), accounts: ["acct-a"], enabled: false });
    expect(() =>
      store.upsert("bar", { cwd: process.cwd(), accounts: ["acct-a"], enabled: false }),
    ).toThrow(/already assigned to project "foo"/);
  });

  it("rejects changing a project's cwd after creation (fixed cwd)", () => {
    const store = new ProjectStore(tmpConfig());
    store.upsert("foo", { cwd: process.cwd(), accounts: ["acct-a"], enabled: false });
    expect(() =>
      store.upsert("foo", { cwd: "/somewhere/else", accounts: ["acct-a"], enabled: false }),
    ).toThrow(/cwd is fixed/);
  });

  it("allows an account to remain in the same project during update", () => {
    const store = new ProjectStore(tmpConfig());
    store.upsert("foo", { cwd: process.cwd(), accounts: ["acct-a"], enabled: false });
    expect(() =>
      store.upsert("foo", { cwd: process.cwd(), accounts: ["acct-a", "acct-b"], enabled: false }),
    ).not.toThrow();
    expect(store.get("foo")?.accounts).toEqual(["acct-a", "acct-b"]);
  });

  it("throws loudly on malformed config (never silently resets)", () => {
    const store = new ProjectStore(tmpConfig());
    fs.writeFileSync(tmpConfig(), "{ not json", "utf-8");
    expect(() => store.read()).toThrow(/malformed/);
  });

  it("persists with a readable atomic config file", () => {
    const store = new ProjectStore(tmpConfig());
    store.upsert("foo", { cwd: process.cwd(), accounts: ["acct-a"], enabled: true });
    const raw = JSON.parse(fs.readFileSync(tmpConfig(), "utf-8"));
    expect(raw.version).toBe(CONFIG_VERSION);
    expect(raw.projects.foo.accounts).toEqual(["acct-a"]);
  });
});
