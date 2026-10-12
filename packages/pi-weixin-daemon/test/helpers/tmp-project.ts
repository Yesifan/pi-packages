import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TmpProject {
  dir: string;
  cleanup(): void;
}

/** An empty workspace: daemon tests inject only their own inline extensions. */
export function createTmpProject(name: string): TmpProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-wx-${name}-`));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
