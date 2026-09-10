import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanupTestSessions, encodeCwd } from "../helpers/session-cleanup.js";

describe("session-cleanup", () => {
  it("encodes a cwd the same way Pi names session dirs", () => {
    expect(encodeCwd("/home/ye/code/pi-weixin-daemon/test/.tmp/m2-ext-load")).toBe(
      "--home-ye-code-pi-weixin-daemon-test-.tmp-m2-ext-load--",
    );
    expect(encodeCwd("/home/ye/code/pi-weixin-daemon")).toBe(
      "--home-ye-code-pi-weixin-daemon--",
    );
  });

  it("removes only sessions under the test tmp dir, keeps real ones", () => {
    const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-"));
    const tmpDir = path.join(os.tmpdir(), "repo", "test", ".tmp");
    fs.mkdirSync(path.join(sessionsRoot, encodeCwd(path.join(tmpDir, "m2-ext-load"))), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sessionsRoot, encodeCwd(path.join(tmpDir, "m9-select"))), {
      recursive: true,
    });
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

  it("is a no-op when the sessions dir does not exist", () => {
    const missing = path.join(os.tmpdir(), "pi-sess-missing-" + Date.now());
    expect(() => cleanupTestSessions({ sessionsDir: missing, tmpDir: "/x" })).not.toThrow();
  });
});
