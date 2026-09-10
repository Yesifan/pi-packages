import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".tmp");

export interface TmpProject {
  dir: string;
  markerFile: string;
  uiMarkerFile: string;
}

/** Create a temporary project with .pi/extensions fixtures. */
export function createTmpProject(name: string, options: { withUiExtension?: boolean } = {}): TmpProject {
  const dir = path.join(TEST_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const extDir = path.join(dir, ".pi", "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  const fixture = fs.readFileSync(path.join(fixturesDir, "project-extension.ts"), "utf-8");
  fs.writeFileSync(path.join(extDir, "test-extension.ts"), fixture, "utf-8");
  if (options.withUiExtension) {
    const uiFixture = fs.readFileSync(path.join(fixturesDir, "ui-extension.ts"), "utf-8");
    fs.writeFileSync(path.join(extDir, "ui-extension.ts"), uiFixture, "utf-8");
  }
  const markerFile = path.join(TEST_ROOT, `${name}.marker`);
  fs.rmSync(markerFile, { force: true });
  const uiMarkerFile = path.join(TEST_ROOT, `${name}.ui-marker`);
  fs.rmSync(uiMarkerFile, { force: true });
  // The fixture tools read $MARKER_FILE / $UI_MARKER (same process).
  process.env.MARKER_FILE = markerFile;
  process.env.UI_MARKER = uiMarkerFile;
  return { dir, markerFile, uiMarkerFile };
}

/** Wait (polling) until the marker file exists, or fail after timeoutMs. */
export async function waitForMarker(
  markerFile: string,
  timeoutMs = 90_000,
  pollMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(markerFile)) {
      return fs.readFileSync(markerFile, "utf-8");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`marker file not created within ${timeoutMs}ms: ${markerFile}`);
}
