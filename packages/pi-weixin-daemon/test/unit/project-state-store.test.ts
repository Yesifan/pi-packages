import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ProjectStateStore } from "../../src/projects/project-state-store.js";

let root: string;
let store: ProjectStateStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wx-project-state-"));
  store = new ProjectStateStore(path.join(root, "projects.json"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("persists default identity across store instances, scoped to project name and cwd", () => {
  store.setDefaultSession("foo", "/foo", "session-1");
  const restarted = new ProjectStateStore(store.statePath);
  expect(restarted.getDefaultSession("foo", "/foo")).toBe("session-1");
  expect(restarted.getDefaultSession("foo", "/other")).toBeUndefined();
  expect(restarted.getDefaultSession("bar", "/foo")).toBeUndefined();
});

it("cleans observed deleted and changed-cwd projects while retaining disabled projects", () => {
  store.setDefaultSession("deleted", "/deleted", "old");
  store.setDefaultSession("changed", "/old", "old");
  store.setDefaultSession("disabled", "/disabled", "keep");
  store.reconcile({
    changed: { cwd: "/new", enabled: true, accounts: [] },
    disabled: { cwd: "/disabled", enabled: false, accounts: [] },
  });
  expect(store.read().projects).toEqual({
    disabled: { cwd: "/disabled", defaultSessionId: "keep" },
  });
});

it("does not silently reset malformed state", () => {
  fs.writeFileSync(store.statePath, "not JSON");
  expect(() => store.setDefaultSession("foo", "/foo", "new")).toThrow();
  expect(fs.readFileSync(store.statePath, "utf8")).toBe("not JSON");
});
