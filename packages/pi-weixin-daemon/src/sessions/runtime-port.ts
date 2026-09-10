import type { PiHostEvent } from "../pi/events.js";
import type {
  HostModelOption,
  HostPromptInput,
  HostSessionOption,
  HostStatus,
  SessionSwitchResult,
} from "../pi/types.js";

/**
 * Abstraction over the Pi session runtime consumed by the business layer.
 *
 * Implemented by `PiSdkHost` (real SDK) and by `FakeAgentRuntime` (tests). It
 * lives in `src/sessions/` so that the session controller depends on a port, not
 * on the concrete SDK host (ADR-0004).
 */
export interface SessionRuntimePort {
  readonly cwd: string;
  /** Lazy start (no session yet). */
  start(): Promise<void>;
  /** Dispose the runtime and all bindings; `ensureSession`/`prompt` rebuild lazily. */
  stop(): Promise<void>;
  /** Build the runtime + session if absent. Fails closed on fatal diagnostics. */
  ensureSession(): Promise<void>;
  prompt(input: HostPromptInput): Promise<void>;
  abort(): Promise<void>;
  /** Wait until the active Pi run and its event handlers have fully settled. */
  waitForIdle(): Promise<void>;
  newSession(): Promise<SessionSwitchResult>;
  listModels(): Promise<HostModelOption[]>;
  setModel(provider: string, modelId: string, projectDefault: boolean): Promise<void>;
  getThinkingLevels(): Promise<string[]>;
  setThinkingLevel(level: string, projectDefault: boolean): Promise<string>;
  listSessions(): Promise<HostSessionOption[]>;
  resumeSession(path: string): Promise<SessionSwitchResult>;
  reload(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  onEvent(listener: (event: PiHostEvent) => void): () => void;
  hasSession(): boolean;
  getStatus(): HostStatus;
}
