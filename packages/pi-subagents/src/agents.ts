import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { SubagentError } from "./errors.js";
import {
  type AgentDefinitionSnapshot,
  type AgentTypeRegistry,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./types.js";

const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ALLOWED_FIELDS = new Set(["name", "description", "tools", "thinking"]);
const PACKAGE_AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));

function contentHash(definition: Omit<AgentDefinitionSnapshot, "source" | "contentHash">): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function parseDefinition(id: string, source: string, content: string): AgentDefinitionSnapshot {
  if (!AGENT_ID.test(id)) {
    throw new SubagentError("INVALID_AGENT_DEFINITION", `Invalid agent id '${id}' in ${source}`);
  }
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(content);
  } catch (error) {
    throw new SubagentError(
      "INVALID_AGENT_DEFINITION",
      `Invalid frontmatter in ${source}`,
      undefined,
      {
        cause: error,
      },
    );
  }
  const frontmatter = parsed.frontmatter;
  for (const field of Object.keys(frontmatter)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new SubagentError(
        "INVALID_AGENT_DEFINITION",
        `Unknown agent field '${field}' in ${source}`,
      );
    }
  }
  if (frontmatter.name !== undefined && frontmatter.name !== id) {
    throw new SubagentError(
      "INVALID_AGENT_DEFINITION",
      `Agent name '${String(frontmatter.name)}' must match filename '${id}' in ${source}`,
    );
  }
  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    throw new SubagentError(
      "INVALID_AGENT_DEFINITION",
      `description must be a string in ${source}`,
    );
  }
  let tools: string[] | undefined;
  if (frontmatter.tools !== undefined) {
    if (
      !Array.isArray(frontmatter.tools) ||
      frontmatter.tools.some((tool) => typeof tool !== "string" || !tool)
    ) {
      throw new SubagentError(
        "INVALID_AGENT_DEFINITION",
        `tools must be an array of non-empty strings in ${source}`,
      );
    }
    tools = [...new Set(frontmatter.tools as string[])];
  }
  let thinking: ThinkingLevel | undefined;
  if (frontmatter.thinking !== undefined) {
    if (
      typeof frontmatter.thinking !== "string" ||
      !THINKING_LEVELS.includes(frontmatter.thinking as ThinkingLevel)
    ) {
      throw new SubagentError(
        "INVALID_AGENT_DEFINITION",
        `Invalid thinking level '${String(frontmatter.thinking)}' in ${source}`,
      );
    }
    thinking = frontmatter.thinking as ThinkingLevel;
  }
  const normalized = {
    id,
    ...(frontmatter.description !== undefined
      ? { description: frontmatter.description as string }
      : {}),
    ...(tools ? { tools } : {}),
    ...(thinking ? { thinking } : {}),
    prompt: parsed.body.trim(),
  };
  return {
    ...normalized,
    source,
    contentHash: contentHash(normalized),
  };
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function loadDirectory(directory: string): Promise<AgentDefinitionSnapshot[]> {
  let canonicalDirectory: string;
  let entries: Dirent[];
  try {
    canonicalDirectory = await realpath(directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SubagentError(
      "INVALID_AGENT_DEFINITION",
      `Cannot read agent directory ${directory}`,
      undefined,
      {
        cause: error,
      },
    );
  }
  const definitions: AgentDefinitionSnapshot[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md")) continue;
    const requested = path.join(directory, entry.name);
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(requested);
      if (!isWithin(canonicalFile, canonicalDirectory)) {
        throw new SubagentError(
          "INVALID_AGENT_DEFINITION",
          `Agent symlink escapes its source directory: ${requested}`,
        );
      }
      if (!(await stat(canonicalFile)).isFile()) {
        throw new SubagentError("INVALID_AGENT_DEFINITION", `Agent is not a file: ${requested}`);
      }
      const id = path.basename(entry.name, ".md");
      definitions.push(parseDefinition(id, canonicalFile, await readFile(canonicalFile, "utf8")));
    } catch (error) {
      if (error instanceof SubagentError) throw error;
      throw new SubagentError(
        "INVALID_AGENT_DEFINITION",
        `Cannot load agent ${requested}`,
        undefined,
        {
          cause: error,
        },
      );
    }
  }
  return definitions;
}

export async function loadAgentTypeRegistry(
  agentDir: string,
  projectRoot: string,
): Promise<AgentTypeRegistry> {
  const registry: AgentTypeRegistry = new Map();
  const layers = [
    PACKAGE_AGENTS_DIR,
    path.join(agentDir, "agents"),
    path.join(projectRoot, ".pi", "agents"),
  ];
  for (const directory of layers) {
    for (const definition of await loadDirectory(directory)) {
      registry.set(definition.id, definition);
    }
  }
  for (const required of ["general", "explore"]) {
    if (!registry.has(required)) {
      throw new SubagentError(
        "INVALID_AGENT_DEFINITION",
        `Required built-in agent '${required}' is unavailable`,
      );
    }
  }
  return registry;
}

export function resolveAgentDefinition(
  registry: AgentTypeRegistry,
  requested = "general",
): AgentDefinitionSnapshot {
  const definition = registry.get(requested);
  if (!definition) {
    throw new SubagentError(
      "AGENT_TYPE_NOT_FOUND",
      `Unknown agent type '${requested}'. Available: ${[...registry.keys()].sort().join(", ")}`,
    );
  }
  return structuredClone(definition);
}
