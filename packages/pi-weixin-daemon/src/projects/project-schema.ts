import fs from "node:fs";
import { z } from "zod";
import { listIndexedWeixinAccountIds } from "../weixin/auth/accounts.js";
import type { ProjectConfig, ProjectStoreData } from "./types.js";

export const CONFIG_VERSION = 2;

/** Shape validation (zod). Semantic checks (cwd/account-existence/uniqueness) live below. */
export const ProjectConfigSchema = z.object({
  cwd: z.string().min(1, "cwd must not be empty"),
  accounts: z.array(z.string().min(1, "account id must not be empty")).default([]),
  enabled: z.boolean().default(false),
});

export const ProjectStoreDataSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  projects: z.record(z.string(), ProjectConfigSchema),
});

export interface ProjectStoreValidationResult {
  ok: boolean;
  errors: string[];
  data?: ProjectStoreData;
}

/**
 * Validate a full config file: shape + semantic checks.
 * Semantic: cwd exists + is dir, every account is registered, and no account is
 * shared across two projects. Malformed config must surface loudly, never reset.
 */
export function validateProjectStoreData(raw: unknown): ProjectStoreValidationResult {
  const errors: string[] = [];

  const shape = ProjectStoreDataSchema.safeParse(raw);
  if (!shape.success) {
    for (const issue of shape.error.issues) {
      errors.push(`config: ${issue.path.join(".")}: ${issue.message}`);
    }
    return { ok: false, errors };
  }
  const data = shape.data;

  // --- semantic: cwd exists ---
  for (const [name, proj] of Object.entries(data.projects)) {
    try {
      if (!fs.existsSync(proj.cwd) || !fs.statSync(proj.cwd).isDirectory()) {
        errors.push(`project "${name}": cwd does not exist or is not a directory: ${proj.cwd}`);
      }
    } catch {
      errors.push(`project "${name}": unable to stat cwd: ${proj.cwd}`);
    }
  }

  // --- semantic: account registered + unique across projects ---
  const registered = new Set(listIndexedWeixinAccountIds());
  const owner = new Map<string, string>();
  for (const [name, proj] of Object.entries(data.projects)) {
    for (const acc of proj.accounts) {
      if (!registered.has(acc)) {
        errors.push(`project "${name}": account "${acc}" is not registered (run \`pi-wx login\` first)`);
      }
      const existing = owner.get(acc);
      if (existing && existing !== name) {
        errors.push(`account "${acc}" is already assigned to project "${existing}"`);
      }
      owner.set(acc, name);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], data };
}

/**
 * Validate a single project's *delta* against the existing config during
 * add/set. Only the target project's constraints are re-checked; existing
 * projects are assumed valid (they passed read-time validation).
 */
export function validateProjectForInsert(
  data: ProjectStoreData,
  name: string,
  proj: ProjectConfig,
): string[] {
  const errors: string[] = [];
  try {
    if (!fs.existsSync(proj.cwd) || !fs.statSync(proj.cwd).isDirectory()) {
      errors.push(`cwd does not exist or is not a directory: ${proj.cwd}`);
    }
  } catch {
    errors.push(`unable to stat cwd: ${proj.cwd}`);
  }

  const registered = new Set(listIndexedWeixinAccountIds());
  for (const acc of proj.accounts) {
    if (!registered.has(acc)) {
      errors.push(`account "${acc}" is not registered (run \`pi-wx login\` first)`);
    }
    for (const [pid, other] of Object.entries(data.projects)) {
      if (pid !== name && other.accounts.includes(acc)) {
        errors.push(`account "${acc}" is already assigned to project "${pid}"`);
      }
    }
  }
  return errors;
}
