import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ControlStore } from "../../src/cli/control-store.js";
import { acquireInstanceLock, withControlLock } from "../../src/config/control-lock.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import {
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "../../src/weixin/auth/accounts.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-store-"));
  vi.stubEnv("PI_WEIXIN_DATA_DIR", dir);
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  registerWeixinAccountId("A");
  saveWeixinAccount("A", { name: "personal", token: "fake" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("rejects a disabled binding without changing registration or credentials", async () => {
  new ProjectStore().upsert("foo", { cwd: dir, accounts: ["A"], enabled: false });
  await expect(new ControlStore().logout("personal")).rejects.toThrow(/foo.*unbind/);
  expect(listIndexedWeixinAccountIds()).toEqual(["A"]);
  expect(loadWeixinAccount("A")?.token).toBe("fake");
});
it("does not notify or clean when saving fails", async () => {
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("save failed");
  });
  await expect(new ControlStore().logout("personal")).rejects.toThrow("save failed");
  expect(listIndexedWeixinAccountIds()).toEqual(["A"]);
  expect(loadWeixinAccount("A")?.token).toBe("fake");
});
it("serializes control operations and excludes a second daemon", async () => {
  const release = await acquireInstanceLock();
  expect(await acquireInstanceLock()).toBeUndefined();
  release?.();
  const order: number[] = [];
  await Promise.all([
    withControlLock(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    }),
    withControlLock(async () => {
      order.push(3);
    }),
  ]);
  // flock guarantees mutual exclusion, not acquisition in JavaScript call order.
  expect([
    [1, 2, 3],
    [3, 1, 2],
  ]).toContainEqual(order);
});
