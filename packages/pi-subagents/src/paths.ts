import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SubagentError } from "./errors.js";
import type { DelegationContext } from "./types.js";

const execFileAsync = promisify(execFile);

export async function canonicalizeDirectory(
  input: string,
  codes: { missing: string; notDirectory: string },
): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(input);
  } catch (error) {
    throw new SubagentError(codes.missing, `Directory does not exist: ${input}`, undefined, {
      cause: error,
    });
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new SubagentError(codes.notDirectory, `Path is not a directory: ${input}`);
  }
  return path.normalize(canonical);
}

export async function resolveToolCwd(
  input: string | undefined,
  caller: DelegationContext,
): Promise<{ cwd: string; kind: "same" | "external" }> {
  if (input === undefined) return { cwd: caller.cwd, kind: "same" };
  if (!path.isAbsolute(input)) {
    throw new SubagentError(
      "INVALID_ARGUMENT",
      "cwd must be an absolute path; relative paths, ~, $HOME and $" + "{HOME} are not accepted",
    );
  }
  const cwd = await canonicalizeDirectory(input, {
    missing: "CWD_NOT_FOUND",
    notDirectory: "CWD_NOT_DIRECTORY",
  });
  if (cwd === caller.cwd) return { cwd, kind: "same" };
  if (caller.externalDirectories.includes(cwd)) return { cwd, kind: "external" };
  throw new SubagentError(
    "CWD_NOT_ALLOWED",
    `cwd must exactly match ${caller.cwd} or an available external cwd: ${cwd}`,
  );
}

export function assertNoDelegationCycle(targetCwd: string, ancestorCwds: readonly string[]): void {
  if (ancestorCwds.includes(targetCwd)) {
    throw new SubagentError("DELEGATION_CYCLE", `Delegation cycle detected for cwd: ${targetCwd}`);
  }
}

export async function findProjectRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const candidate = stdout.trim();
    if (candidate) {
      return canonicalizeDirectory(candidate, {
        missing: "INVALID_CONFIG",
        notDirectory: "INVALID_CONFIG",
      });
    }
  } catch {
    // A non-Git directory is its own project root for this package's resources.
  }
  return cwd;
}
