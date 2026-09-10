/** Project-level types: the first-class persisted entity + runtime state. */

/**
 * Persistent project entity (the value of `projects.<name>`). The project name
 * is the record key, not a field — it never needs to be duplicated inside the
 * config value. Runtime state lives separately in `ProjectRuntimeState`.
 */
export interface ProjectConfig {
  cwd: string;
  /** 0..N accounts; an account may belong to at most one project. */
  accounts: string[];
  /** Persisted desired state. true = daemon should maintain this ProjectController. */
  enabled: boolean;
}

/** The persisted config file shape. */
export interface ProjectStoreData {
  version: number;
  projects: Record<string, ProjectConfig>;
}

/** Runtime lifecycle state for a ProjectController (not persisted). */
export type ProjectRuntimeState = "starting" | "idle" | "busy" | "stopping" | "error";

/** Observable project status exposed over RPC / `project list`. */
export interface ProjectStatus {
  name: string;
  cwd: string;
  accounts: string[];
  enabled: boolean;
  /** Runtime state, or a marker when the runtime is not running. */
  state: ProjectRuntimeState | "off";
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  /** Live project-trust decision (W7). */
  configuredTrust?: boolean;
  /** Trust snapshot locked when the session was created (W7). */
  activeSessionTrust?: boolean;
  error?: string;
}

/** Account status exposed over RPC / `accounts`. */
export type AccountStatus =
  | "offline"
  | "connecting"
  | "online"
  | "reauth-required"
  | "error";

export interface AccountInfo {
  /** ilink_bot_id (the routing key). */
  accountId: string;
  /** User-chosen label (globally unique). */
  name?: string;
  status: AccountStatus;
  userId?: string;
  /** The project this account is bound to, if any. */
  projectId?: string;
  /** Login time (savedAt ISO string). */
  since?: string;
  error?: string;
}
