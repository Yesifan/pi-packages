import { SessionManager } from "@earendil-works/pi-coding-agent";
import { persistSessionIdentity } from "../../src/pi/session-persistence.js";
import type { HostPromptInput, HostStatus } from "../../src/pi/types.js";
import { FakeAgentRuntime } from "./fake-runtime.js";

/** Real Pi JSONL persistence with deterministic, offline model execution. */
export class HistoryRuntime extends FakeAgentRuntime {
  manager?: SessionManager;

  private bind(manager: SessionManager): void {
    persistSessionIdentity(manager);
    this.manager = manager;
    this.activeSession = true;
    this.emit({
      type: "session_bound",
      generation: this.newSessionCalls + this.resumeCalls.length,
    });
  }

  override async ensureSession(): Promise<void> {
    if (this.manager) return;
    this.ensureSessionCalls++;
    this.bind(SessionManager.create(this.cwd));
  }

  override async newSession() {
    this.newSessionCalls++;
    this.bind(SessionManager.create(this.cwd));
    return { cancelled: false };
  }

  override async resumeSession(file: string) {
    this.resumeCalls.push(file);
    this.bind(SessionManager.open(file));
    return { cancelled: false };
  }

  override async listSessions() {
    return (await SessionManager.list(this.cwd))
      .filter((s) => s.cwd === this.cwd)
      .map((s) => ({
        id: s.id,
        path: s.path,
        name: s.name,
        firstMessage: s.firstMessage,
        modifiedAt: s.modified.getTime(),
      }));
  }

  override async prompt(input: HostPromptInput) {
    this.manager?.appendMessage({ role: "user", content: input.text, timestamp: Date.now() });
    await super.prompt(input);
  }

  override async stop(): Promise<void> {
    await super.stop();
    this.manager = undefined;
  }

  override getStatus(): HostStatus {
    return {
      ...super.getStatus(),
      sessionId: this.manager?.getSessionId(),
      sessionFile: this.manager?.getSessionFile(),
    };
  }
}
