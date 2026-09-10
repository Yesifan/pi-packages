import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Read our own package.json version (works from src/ in dev and dist/ in publish). */
function readPackageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const { root } = path.parse(dir);
  while (dir && dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as { name?: string; version?: string };
        if (parsed && parsed.name === "pi-weixin-daemon" && typeof parsed.version === "string") return parsed.version;
      } catch {
        // keep walking up
      }
    }
    dir = path.dirname(dir);
  }
  return "0.0.0";
}

/** Single source of truth for the daemon / CLI version. */
export const VERSION = readPackageVersion();
