import { describe, expect, it } from "vitest";
import { formatUserFacingError } from "../../src/util/user-facing-error.js";

describe("formatUserFacingError", () => {
  it("redacts credentials and control characters", () => {
    const value = formatUserFacingError(
      "failed\nAuthorization: Bearer secret-token-123 token=abcdefghi https://x.test/?api_key=topsecret&x=1",
    );
    expect(value).not.toContain("secret-token-123");
    expect(value).not.toContain("abcdefghi");
    expect(value).not.toContain("topsecret");
    expect(value).not.toContain("\n");
    expect(value).toContain("[REDACTED]");
  });

  it("uses a fallback and bounds output", () => {
    expect(formatUserFacingError(undefined, { fallback: "fallback" })).toBe("fallback");
    expect(formatUserFacingError("x".repeat(100), { maxLength: 10 })).toHaveLength(10);
  });
});
