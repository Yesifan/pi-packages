import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { persistSessionIdentity } from "../../src/pi/session-persistence.js";
import { createTmpProject } from "../helpers/tmp-project.js";

it("surfaces initial write failure, removes the partial file, and permits retry", () => {
  const project = createTmpProject("empty-session-failure");
  const manager = SessionManager.create(project.dir, path.join(project.dir, "sessions"));
  const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  try {
    expect(() => persistSessionIdentity(manager)).toThrow("disk full");
    expect(fs.existsSync(manager.getSessionFile()!)).toBe(false);
    write.mockRestore();
    persistSessionIdentity(manager);
    expect(SessionManager.open(manager.getSessionFile()!).getSessionId()).toBe(
      manager.getSessionId(),
    );
  } finally {
    write.mockRestore();
    project.cleanup();
  }
});

it("persists empty SDK sessions, lists and reopens them, then appends without losing identity", async () => {
  const project = createTmpProject("empty-session");
  try {
    const directory = path.join(project.dir, "sessions");
    const manager = SessionManager.create(project.dir, directory);
    const id = manager.getSessionId();
    const file = manager.getSessionFile()!;
    expect(fs.existsSync(file)).toBe(false);
    manager.appendThinkingLevelChange("medium");
    persistSessionIdentity(manager);
    expect((await SessionManager.list(project.dir, directory)).map((item) => item.id)).toContain(
      id,
    );
    expect(SessionManager.open(file).getSessionId()).toBe(id);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const original = fs.readFileSync(file, "utf8");
    persistSessionIdentity(manager);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    persistSessionIdentity(manager);
    const reopened = SessionManager.open(file);
    expect(reopened.getSessionId()).toBe(id);
    expect(reopened.getEntries()).toHaveLength(2);
  } finally {
    project.cleanup();
  }
});
