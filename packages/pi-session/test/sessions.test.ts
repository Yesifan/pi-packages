import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSession, resolveCwd, searchSessions } from "../src/sessions.js";

let root: string;
let caller: string;
let other: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-session-search-"));
  caller = join(root, "caller");
  other = join(root, "other");
  await Promise.all([mkdir(caller), mkdir(other)]);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function session(cwd: string, text: string) {
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  return manager;
}
async function config(value: unknown) {
  await mkdir(join(caller, ".pi/pi-session"), { recursive: true });
  await writeFile(join(caller, ".pi/pi-session/setting.json"), JSON.stringify(value));
}

describe("cwd authorization", () => {
  it("defaults omitted/empty cwd, canonicalizes symlinks, rejects relative and unauthorized paths", async () => {
    expect(await resolveCwd(caller)).toBe(caller);
    expect(await resolveCwd(caller, "")).toBe(caller);
    await symlink(caller, join(root, "alias"));
    expect(await resolveCwd(caller, join(root, "alias"))).toBe(caller);
    await expect(resolveCwd(caller, ".")).rejects.toThrow("absolute");
    await expect(resolveCwd(caller, other)).rejects.toThrow("Unauthorized");
  });
  it("authorizes only exact external realpaths, not descendants", async () => {
    await symlink(other, join(root, "external-alias"));
    await config({ externalDirectories: [join(root, "external-alias")] });
    expect(await resolveCwd(caller, other)).toBe(other);
    const nested = join(other, "nested");
    await mkdir(nested);
    await expect(resolveCwd(caller, nested)).rejects.toThrow("Unauthorized");
  });
  it("rejects malformed configuration", async () => {
    await config({ externalDirectories: "*" });
    await expect(resolveCwd(caller, other)).rejects.toThrow("array");
  });
});

describe("SDK session discovery", () => {
  it("finds only exact IDs in the selected cwd and never accepts paths or prefixes", () => {
    const manager = session(caller, "hello");
    const id = manager.getSessionId();
    expect(findSession(caller, id)).toEqual({ id, cwd: caller, path: manager.getSessionFile() });
    expect(() => findSession(caller, id.slice(0, 8))).toThrow();
    expect(() => findSession(other, id)).toThrow("not found");
    expect(() => findSession(caller, manager.getSessionFile()!)).toThrow("complete");
  });
  it("matches aggregate body case-insensitively by lines, not names, preserving SDK metadata", async () => {
    const manager = session(caller, "first\nNeEdLe in body\nlast");
    manager.appendSessionInfo("Body session");
    session(other, "needle elsewhere");
    const named = session(caller, "no match");
    named.appendSessionInfo("needle only name");
    const result = await searchSessions(caller, "needle");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      id: manager.getSessionId(),
      name: "Body session",
      segments: [{ text: "NeEdLe in body", truncated: false }],
      truncated: false,
    });
    expect(isAbsolute(result.sessions[0]!.path)).toBe(true);
    expect(result.truncated).toBe(false);
    manager.appendMessage({ role: "user", content: "freshneedle", timestamp: Date.now() });
    expect((await searchSessions(caller, "freshneedle")).sessions).toHaveLength(1);
  });
  it("sorts modified descending and explicitly bounds sessions, lines, and text", async () => {
    const managers = [];
    for (let i = 0; i < 21; i++) {
      const manager = session(
        caller,
        [`needle${"x".repeat(2100)}`, ...Array(6).fill("needle")].join("\n"),
      );
      managers.push(manager);
      await utimes(
        manager.getSessionFile()!,
        new Date(100000 + i * 1000),
        new Date(100000 + i * 1000),
      );
    }
    const result = await searchSessions(caller, "needle");
    expect(result.sessions).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.sessions[0]!.id).toBe(managers[20]!.getSessionId());
    expect(result.sessions[0]!.segments).toHaveLength(5);
    expect(result.sessions[0]!.segments[0]!.text).toHaveLength(2000);
    expect(result.sessions[0]!.segments[0]!.truncated).toBe(true);
    expect(result.sessions[0]!.truncated).toBe(true);
  });
  it("does not authorize a different header cwd merely because its file is in the selected directory", async () => {
    const local = session(caller, "local");
    const misplaced = SessionManager.create(other, local.getSessionDir());
    misplaced.appendMessage({ role: "user", content: "foreign needle", timestamp: Date.now() });
    expect(() => findSession(caller, misplaced.getSessionId())).toThrow("authorized project");
    expect((await searchSessions(caller, "needle")).sessions).toEqual([]);
  });
  it("rejects blank queries and canceled requests", async () => {
    await expect(searchSessions(caller, " ")).rejects.toThrow("empty");
    const controller = new AbortController();
    controller.abort();
    await expect(searchSessions(caller, "text", controller.signal)).rejects.toThrow();
  });
});
