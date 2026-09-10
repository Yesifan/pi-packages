import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { validateSendFileParams } from "../../src/pi/extensions/weixin-send-file.js";
import { sanitizeFilename } from "../../src/util/sanitize.js";

describe("validateSendFileParams (W9: no path boundary)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "path-validate-"));
  });

  it("accepts a regular file inside cwd", () => {
    const file = path.join(root, "ok.txt");
    fs.writeFileSync(file, "hi");
    const result = validateSendFileParams(file, root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(file);
      expect(result.basename).toBe("ok.txt");
    }
  });

  it("rejects a missing file", () => {
    const result = validateSendFileParams(path.join(root, "nope.txt"), root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not exist");
  });

  it("rejects a directory", () => {
    const dir = path.join(root, "subdir");
    fs.mkdirSync(dir);
    const result = validateSendFileParams(dir, root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not a regular file");
  });

  it("accepts a file outside cwd (permission model = agent process)", () => {
    const outside = path.join(root, "..", "outside.txt");
    fs.writeFileSync(outside, "secret");
    const result = validateSendFileParams(outside, root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedPath).toBe(path.resolve(outside));
  });

  it("resolves relative ../ paths against cwd without a boundary check", () => {
    const outside = path.join(root, "..", "outside.txt");
    fs.writeFileSync(outside, "secret");
    const result = validateSendFileParams("../outside.txt", root);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty basename after sanitization", () => {
    const file = path.join(root, " \u0001");
    fs.writeFileSync(file, "x");
    const result = validateSendFileParams(file, root);
    expect(result.ok).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("strips control characters and path separators", () => {
    expect(sanitizeFilename("a\u0001b/c\\d.txt")).toBe("ab_c_d.txt");
  });
  it("trims whitespace", () => {
    expect(sanitizeFilename("  file.txt  ")).toBe("file.txt");
  });
});
