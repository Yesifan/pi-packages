import type { PiHostEvent } from "../../src/pi/events.js";
import type {
  HostImage,
  HostModelOption,
  HostPromptInput,
  HostSessionOption,
  HostStatus,
  SessionSwitchResult,
} from "../../src/pi/types.js";
import type { SessionRuntimePort } from "../../src/sessions/runtime-port.js";

/**
 * Controllable SessionRuntimePort for bridge/session tests: prompt() suspends
 * until the test calls complete()/fail()/abort().
 */
export class FakeAgentRuntime implements SessionRuntimePort {
  readonly cwd: string;
  prompts: Array<{ text: string; images?: HostImage[] }> = [];
  newSessionCalls = 0;
  compactCalls = 0;
  ensureSessionCalls = 0;
  stopCalls = 0;
  activeSession = false;
  models: HostModelOption[] = [{ provider: "fake", id: "provider", name: "Fake" }];
  selectedModels: Array<{ provider: string; id: string; projectDefault: boolean }> = [];
  selectedThinking: Array<{ level: string; projectDefault: boolean }> = [];
  sessions: HostSessionOption[] = [];
  resumeCalls: string[] = [];
  reloadCalls = 0;
  private listeners = new Set<(event: PiHostEvent) => void>();
  private pending:
    | { resolve: () => void; reject: (err: Error) => void }
    | undefined;
  private idleWaiters: Array<() => void> = [];

  constructor(cwd = "/fake/project") {
    this.cwd = cwd;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.activeSession = false;
  }
  async ensureSession(): Promise<void> {
    this.ensureSessionCalls += 1;
    this.activeSession = true;
  }

  hasSession(): boolean {
    return this.activeSession;
  }

  async prompt(input: HostPromptInput): Promise<void> {
    this.prompts.push({ text: input.text, images: input.images });
    this.emit({ type: "assistant_started" });
    await new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /** Complete the current prompt: emit text deltas + final status + settled. */
  complete(reply: string): void {
    this.emitText(reply);
    this.emit({ type: "assistant_finished", stopReason: "stop" });
    this.settle();
  }

  completeWithError(message: string, partialText = ""): void {
    this.emitText(partialText);
    this.emit({ type: "assistant_finished", stopReason: "error", errorMessage: message });
    this.settle();
  }

  completeAborted(partialText = ""): void {
    this.emitText(partialText);
    this.emit({ type: "assistant_finished", stopReason: "aborted", errorMessage: "aborted" });
    this.settle();
  }

  failThenRetrySuccessfully(reply: string): void {
    this.emitText("failed partial");
    this.emit({ type: "assistant_finished", stopReason: "error", errorMessage: "temporary failure" });
    this.emit({ type: "assistant_started" });
    this.emitText(reply);
    this.emit({ type: "assistant_finished", stopReason: "stop" });
    this.settle();
  }

  /** Fail the current prompt with an exceptional rejection. */
  fail(err: Error): void {
    this.pending?.reject(err);
    this.pending = undefined;
    this.resolveIdleWaiters();
  }

  async abort(): Promise<void> {
    this.completeAborted();
  }

  async waitForIdle(): Promise<void> {
    if (!this.pending) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private emitText(text: string): void {
    const chunks = text.match(/.{1,10}/gs) ?? [];
    for (const delta of chunks) this.emit({ type: "text_delta", delta });
  }

  private settle(): void {
    this.emit({ type: "agent_settled" });
    this.pending?.resolve();
    this.pending = undefined;
    this.resolveIdleWaiters();
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  async newSession(): Promise<SessionSwitchResult> {
    this.newSessionCalls += 1;
    this.activeSession = true;
    return { cancelled: false };
  }

  async listModels(): Promise<HostModelOption[]> {
    return this.models;
  }
  async setModel(provider: string, id: string, projectDefault: boolean): Promise<void> {
    this.selectedModels.push({ provider, id, projectDefault });
  }
  async getThinkingLevels(): Promise<string[]> {
    return ["off", "medium", "high"];
  }
  async setThinkingLevel(level: string, projectDefault: boolean): Promise<string> {
    this.selectedThinking.push({ level, projectDefault });
    return level;
  }
  async listSessions(): Promise<HostSessionOption[]> {
    return this.sessions;
  }
  async resumeSession(path: string): Promise<SessionSwitchResult> {
    this.resumeCalls.push(path);
    this.activeSession = true;
    return { cancelled: false };
  }
  async reload(): Promise<void> {
    this.reloadCalls += 1;
  }

  async compact(): Promise<void> {
    this.compactCalls += 1;
  }

  onEvent(listener: (event: PiHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: PiHostEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  getStatus(): HostStatus {
    return {
      sessionFile: "/fake/session.jsonl",
      sessionId: "fake-session",
      cwd: this.cwd,
      model: "fake/provider",
      thinkingLevel: "medium",
      configuredTrust: true,
      activeSessionTrust: true,
    };
  }
}
