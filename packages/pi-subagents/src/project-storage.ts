import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SubagentError } from "./errors.js";

const execFileAsync = promisify(execFile);
const PROJECT_DIRECTORY_PARTS = [".pi", "subagents"] as const;
const SESSIONS_DIRECTORY_NAME = "sessions";
const SETTINGS_FILE_NAME = "setting.json";
const GITIGNORE_CONTENT = "/sessions/\n";

export interface ProjectSubagentsStorage {
  projectRoot: string;
  directory: string;
  sessionsDirectory: string;
  settingsFile: string;
}

function storeError(message: string, cause?: unknown): SubagentError {
  return new SubagentError(
    "STORE_ERROR",
    message,
    undefined,
    cause instanceof Error ? { cause } : undefined,
  );
}

async function ensurePlainDirectory(directory: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw storeError(`Subagent storage path must be a non-symlink directory: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) throw storeError(`Subagent storage directory disappeared: ${directory}`, error);
    try {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw storeError(`Cannot create subagent storage directory: ${directory}`, mkdirError);
      }
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw storeError(`Subagent storage path must be a non-symlink directory: ${directory}`);
    }
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function assertContained(directory: string, projectRoot: string): Promise<void> {
  const [canonicalDirectory, canonicalProjectRoot] = await Promise.all([
    realpath(directory),
    realpath(projectRoot),
  ]);
  if (!isWithin(canonicalDirectory, canonicalProjectRoot)) {
    throw storeError(`Subagent storage escapes the project root: ${directory}`);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C" };
}

async function isGitWorkTree(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectRoot, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", env: gitEnvironment(), timeout: 5_000, windowsHide: true },
    );
    return stdout.trim() === "true";
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (typeof failure.stderr === "string" && failure.stderr.includes("not a git repository")) {
      return false;
    }
    throw storeError(`Cannot determine Git status for subagent storage: ${projectRoot}`, error);
  }
}

async function ensureLocalGitignore(storageDirectory: string): Promise<void> {
  const file = path.join(storageDirectory, ".gitignore");
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw storeError(`Subagent .gitignore must be a non-symlink file: ${file}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeFile(file, GITIGNORE_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw storeError(`Cannot create subagent .gitignore: ${file}`, error);
    }
  }
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw storeError(`Subagent .gitignore must be a non-symlink file: ${file}`);
  }
}

async function assertLocalGitignore(storageDirectory: string): Promise<void> {
  const file = path.join(storageDirectory, ".gitignore");
  let text: string;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw storeError(`Subagent .gitignore must be a non-symlink file: ${file}`);
    }
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof SubagentError) throw error;
    throw storeError(`Subagent .gitignore is unavailable: ${file}`, error);
  }
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (rules.at(-1) !== "/sessions/") {
    throw storeError(`Subagent .gitignore must end with the /sessions/ rule: ${file}`);
  }
}

async function assertGitSafe(projectRoot: string): Promise<void> {
  if (!(await isGitWorkTree(projectRoot))) return;
  const relativeSessions = ".pi/subagents/sessions";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectRoot, "ls-files", "-z", "--", relativeSessions],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        timeout: 5_000,
        windowsHide: true,
      },
    );
    if (stdout.trim()) {
      throw storeError(`Subagent session data is already tracked by Git: ${relativeSessions}`);
    }
  } catch (error) {
    if (error instanceof SubagentError) throw error;
    throw storeError(`Cannot inspect tracked subagent session data in ${projectRoot}`, error);
  }
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        projectRoot,
        "check-ignore",
        "-q",
        "--no-index",
        "--",
        `${relativeSessions}/.pi-subagents-ignore-probe`,
      ],
      { env: gitEnvironment(), timeout: 5_000, windowsHide: true },
    );
  } catch (error) {
    throw storeError(
      `Subagent session directory must be ignored by Git: ${path.join(projectRoot, relativeSessions)}`,
      error,
    );
  }
}

export async function getProjectSubagentsStorage(
  projectRootInput: string,
): Promise<ProjectSubagentsStorage> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectRootInput);
  } catch (error) {
    throw storeError(`Cannot resolve project root: ${projectRootInput}`, error);
  }
  const directory = path.join(projectRoot, ...PROJECT_DIRECTORY_PARTS);
  return {
    projectRoot,
    directory,
    sessionsDirectory: path.join(directory, SESSIONS_DIRECTORY_NAME),
    settingsFile: path.join(directory, SETTINGS_FILE_NAME),
  };
}

export async function initializeProjectSubagents(
  projectRootInput: string,
): Promise<ProjectSubagentsStorage> {
  const storage = await getProjectSubagentsStorage(projectRootInput);
  const { projectRoot, directory, sessionsDirectory } = storage;
  const piDirectory = path.join(projectRoot, PROJECT_DIRECTORY_PARTS[0]);
  try {
    await ensurePlainDirectory(piDirectory, true);
    await ensurePlainDirectory(directory, true);
    await assertContained(directory, projectRoot);
    await ensureLocalGitignore(directory);
    await assertLocalGitignore(directory);
    await ensurePlainDirectory(sessionsDirectory, true);
    await assertContained(sessionsDirectory, projectRoot);
    await assertGitSafe(projectRoot);
  } catch (error) {
    if (error instanceof SubagentError) throw error;
    throw storeError(`Cannot initialize project subagent storage: ${directory}`, error);
  }
  return storage;
}

export async function assertProjectStorageAvailable(
  projectRoot: string,
  storageDirectory: string,
): Promise<void> {
  const expectedDirectory = path.join(projectRoot, ...PROJECT_DIRECTORY_PARTS);
  if (path.resolve(storageDirectory) !== path.resolve(expectedDirectory)) {
    throw storeError(`Subagent storage must use the project-local path: ${expectedDirectory}`);
  }
  const sessionsDirectory = path.join(storageDirectory, SESSIONS_DIRECTORY_NAME);
  await ensurePlainDirectory(storageDirectory, false);
  await ensurePlainDirectory(sessionsDirectory, false);
  await assertContained(sessionsDirectory, projectRoot);
  await assertLocalGitignore(storageDirectory);
  await assertGitSafe(projectRoot);
}
