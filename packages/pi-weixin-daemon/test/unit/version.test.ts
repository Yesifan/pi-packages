import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";

describe("VERSION", () => {
  it("reads the version from the scoped package manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };

    expect(VERSION).toBe(manifest.version);
  });
});
