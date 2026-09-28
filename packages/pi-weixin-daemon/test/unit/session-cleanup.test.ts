import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTestSessions, encodeCwd } from "../helpers/session-cleanup.js";

describe("session-cleanup", () => {
  it("encodes a cwd the same way Pi names session dirs", () => {
    expect(encodeCwd("/home/ye/code/pi-weixin-daemon/test/.tmp/m2-ext-load")).toBe(
      "--home-ye-code-pi-weixin-daemon-test-.tmp-m2-ext-load--",
    );
    expect(encodeCwd("/home/ye/code/pi-weixin-daemon")).toBe("--home-ye-code-pi-weixin-daemon--");
  });

  it("removes only sessions under the test tmp dir, keeps real ones", () => {
    const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-"));
    const tmpDir = path.join(os.tmpdir(), "repo", "test", ".tmp");
    for (const project of ["m2-ext-load", "m9-select"]) {
      const cwd = path.join(tmpDir, project);
      const sessionDir = path.join(sessionsRoot, encodeCwd(cwd));
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "session.jsonl"),
        `${JSON.stringify({ type: "session", cwd })}\n`,
      );
    }
    // A real (non-test) project session must survive.
    const real = path.join(sessionsRoot, encodeCwd("/home/ye/code/pi-weixin-daemon"));
    fs.mkdirSync(real, { recursive: true });

    cleanupTestSessions({ sessionsDir: sessionsRoot, tmpDir });

    const remaining = fs.readdirSync(sessionsRoot);
    expect(remaining).toContain("--home-ye-code-pi-weixin-daemon--");
    expect(remaining).not.toContain(encodeCwd(path.join(tmpDir, "m2-ext-load")));
    expect(remaining).not.toContain(encodeCwd(path.join(tmpDir, "m9-select")));
    expect(remaining).toHaveLength(1);

    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("keeps sibling tmp paths even when their encoded names share the prefix", () => {
    const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-"));
    const tmpDir = path.join(os.tmpdir(), "repo", "test", ".tmp");
    const siblingCwd = `${tmpDir}-other`;
    const siblingDir = path.join(sessionsRoot, encodeCwd(siblingCwd));
    fs.mkdirSync(siblingDir);
    fs.writeFileSync(
      path.join(siblingDir, "session.jsonl"),
      `${JSON.stringify({ type: "session", cwd: siblingCwd })}\n`,
    );

    cleanupTestSessions({ sessionsDir: sessionsRoot, tmpDir });

    expect(fs.existsSync(siblingDir)).toBe(true);
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("removes only the test sessions that share a colliding encoded directory", () => {
    const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-"));
    const tmpDir = path.join(os.tmpdir(), "repo", "test", ".tmp");
    const testCwd = path.join(tmpDir, "x");
    const otherCwd = `${tmpDir}-x`;
    expect(encodeCwd(testCwd)).toBe(encodeCwd(otherCwd));
    const shared = path.join(sessionsRoot, encodeCwd(testCwd));
    fs.mkdirSync(shared, { recursive: true });
    for (const [name, cwd] of [
      ["test-session.jsonl", testCwd],
      ["other-session.jsonl", otherCwd],
    ]) {
      fs.writeFileSync(path.join(shared, name), `${JSON.stringify({ type: "session", cwd })}\n`);
    }

    cleanupTestSessions({ sessionsDir: sessionsRoot, tmpDir });

    expect(fs.readdirSync(shared)).toEqual(["other-session.jsonl"]);
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("removes a test session whose header exceeds the small read buffer", () => {
    const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-"));
    const tmpDir = path.join(os.tmpdir(), "repo", "test", ".tmp");
    const cwd = path.join(tmpDir, "long-header");
    const sessionDir = path.join(sessionsRoot, encodeCwd(cwd));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.jsonl"),
      `${JSON.stringify({ type: "session", cwd, padding: "x".repeat(8000) })}\n`,
    );

    cleanupTestSessions({ sessionsDir: sessionsRoot, tmpDir });

    expect(fs.existsSync(sessionDir)).toBe(false);
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("is a no-op when the sessions dir does not exist", () => {
    const missing = path.join(os.tmpdir(), `pi-sess-missing-${Date.now()}`);
    expect(() => cleanupTestSessions({ sessionsDir: missing, tmpDir: "/x" })).not.toThrow();
  });
});
