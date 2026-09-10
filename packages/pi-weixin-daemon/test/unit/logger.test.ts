import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/util/logger.js";

describe("createLogger", () => {
  it("creates a JSON logger and logs without throwing", () => {
    const l = createLogger({ level: "silent" });
    expect(l).toBeTruthy();
    expect(() => l.info("hello")).not.toThrow();
  });

  it("creates a pretty logger when pino-pretty is available (repo devDep) without throwing at creation", () => {
    // The historical crash was at createLogger() time (pino transport resolution).
    const l = createLogger({ pretty: true, level: "silent" });
    expect(l).toBeTruthy();
    expect(() => l.info("hello")).not.toThrow();
  });
});
