import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentError } from "./errors.js";
import { canonicalizeDirectory, findProjectRoot } from "./paths.js";
import {
  assertProjectStorageAvailable,
  getProjectSubagentsStorage,
  initializeProjectSubagents,
} from "./project-storage.js";
import type { SubagentsConfig } from "./types.js";

const DEFAULTS = {
  external_directory: [] as string[],
  max_depth: 4,
  max_live_agents: 8,
  ui_timeout_ms: 120_000,
};

interface RawConfig {
  external_directory?: string[];
  max_depth?: number;
  max_live_agents?: number;
  ui_timeout_ms?: number;
}

const BRACED_HOME = "$" + "{HOME}";

const CONFIG_KEYS = new Set([
  "external_directory",
  "max_depth",
  "max_live_agents",
  "ui_timeout_ms",
]);

async function readConfigFile(file: string): Promise<RawConfig | undefined> {
  let text: string;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new SubagentError("INVALID_CONFIG", `Config must be a non-symlink file: ${file}`);
    }
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SubagentError) throw error;
    throw new SubagentError("INVALID_CONFIG", `Cannot read config ${file}`, undefined, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SubagentError("INVALID_CONFIG", `Invalid JSON in ${file}`, undefined, {
      cause: error,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubagentError("INVALID_CONFIG", `Config must be a JSON object: ${file}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new SubagentError("INVALID_CONFIG", `Unknown config key '${key}' in ${file}`);
    }
  }
  if (
    record.external_directory !== undefined &&
    (!Array.isArray(record.external_directory) ||
      record.external_directory.some((entry) => typeof entry !== "string" || !entry.trim()))
  ) {
    throw new SubagentError(
      "INVALID_CONFIG",
      `external_directory must be an array of non-empty strings: ${file}`,
    );
  }
  for (const key of ["max_depth", "max_live_agents", "ui_timeout_ms"] as const) {
    const number = record[key];
    if (number !== undefined && (!Number.isInteger(number) || (number as number) <= 0)) {
      throw new SubagentError("INVALID_CONFIG", `${key} must be a positive integer: ${file}`);
    }
  }
  return record as RawConfig;
}

export function expandConfiguredHome(input: string, home = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2));
  if (input === "$HOME" || input === BRACED_HOME) return home;
  if (input.startsWith("$HOME/") || input.startsWith("$HOME\\")) {
    return path.join(home, input.slice(6));
  }
  if (input.startsWith(`${BRACED_HOME}/`) || input.startsWith(`${BRACED_HOME}\\`)) {
    return path.join(home, input.slice(8));
  }
  return input;
}

async function normalizeExternalDirectories(values: readonly string[]): Promise<string[]> {
  const normalized: string[] = [];
  for (const raw of values) {
    const expanded = expandConfiguredHome(raw);
    if (!path.isAbsolute(expanded)) {
      throw new SubagentError(
        "INVALID_CONFIG",
        `external_directory must expand to an absolute path: ${raw}`,
      );
    }
    const canonical = await canonicalizeDirectory(expanded, {
      missing: "INVALID_CONFIG",
      notDirectory: "INVALID_CONFIG",
    });
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return normalized;
}

export async function loadSubagentsConfig(
  cwdInput: string,
  options: { initializeStorage?: boolean } = {},
): Promise<SubagentsConfig> {
  const cwd = await canonicalizeDirectory(cwdInput, {
    missing: "CWD_NOT_FOUND",
    notDirectory: "CWD_NOT_DIRECTORY",
  });
  const projectRoot = await findProjectRoot(cwd);
  const storage =
    options.initializeStorage === false
      ? await getProjectSubagentsStorage(projectRoot)
      : await initializeProjectSubagents(projectRoot);
  if (options.initializeStorage === false) {
    await assertProjectStorageAvailable(storage.projectRoot, storage.directory);
  }
  const projectConfig = (await readConfigFile(storage.settingsFile)) ?? {};
  const effective: Required<RawConfig> = {
    external_directory: projectConfig.external_directory ?? DEFAULTS.external_directory,
    max_depth: projectConfig.max_depth ?? DEFAULTS.max_depth,
    max_live_agents: projectConfig.max_live_agents ?? DEFAULTS.max_live_agents,
    ui_timeout_ms: projectConfig.ui_timeout_ms ?? DEFAULTS.ui_timeout_ms,
  };
  return {
    externalDirectories: await normalizeExternalDirectories(effective.external_directory),
    maxDepth: effective.max_depth,
    maxLiveAgents: effective.max_live_agents,
    uiTimeoutMs: effective.ui_timeout_ms,
    projectRoot: storage.projectRoot,
    storageDirectory: storage.directory,
  };
}
