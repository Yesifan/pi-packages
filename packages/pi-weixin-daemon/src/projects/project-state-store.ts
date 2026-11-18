import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../config/atomic-write.js";
import { resolveStateDir } from "../config/paths.js";
import type { ProjectConfig } from "./types.js";

const stateSchema = z.object({
  projects: z.record(z.string(), z.object({ cwd: z.string(), defaultSessionId: z.string() })),
});

/** Daemon-owned session state, separate from CLI-owned desired configuration. */
export class ProjectStateStore {
  constructor(readonly statePath = path.join(resolveStateDir(), "projects.json")) {}

  read(): z.infer<typeof stateSchema> {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
      throw error;
    }
    return stateSchema.parse(raw);
  }

  getDefaultSession(name: string, cwd: string): string | undefined {
    const state = this.read().projects[name];
    return state?.cwd === cwd ? state.defaultSessionId : undefined;
  }

  setDefaultSession(name: string, cwd: string, defaultSessionId: string): void {
    const state = this.read();
    state.projects[name] = { cwd, defaultSessionId };
    atomicWriteJson(this.statePath, state);
  }

  /** Discard observed deletions/recreations rather than reviving another cwd's session. */
  reconcile(projects: Record<string, ProjectConfig>): void {
    const state = this.read();
    let changed = false;
    for (const [name, saved] of Object.entries(state.projects)) {
      if (projects[name]?.cwd === saved.cwd) continue;
      delete state.projects[name];
      changed = true;
    }
    if (changed) atomicWriteJson(this.statePath, state);
  }
}
