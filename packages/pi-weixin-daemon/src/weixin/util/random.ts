import crypto from "node:crypto";

/**
 * Generate a prefixed unique ID using timestamp + crypto random bytes.
 * Format: `{prefix}:{timestamp}-{8-char hex}`
 */
export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}
