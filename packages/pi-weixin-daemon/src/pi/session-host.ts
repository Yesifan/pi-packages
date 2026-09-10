import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { HostImage, HostPromptInput, SessionSwitchResult } from "./types.js";

/** Domain images -> SDK multimodal ImageContent[]. */
export function toImageContents(images?: HostImage[]): ImageContent[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((img) => ({
    type: "image",
    data: img.data,
    mimeType: img.mimeType,
  }));
}

/**
 * Operation facade over a built `AgentSessionRuntime` (ADR-0004).
 *
 * `AgentSessionRuntime` owns the current session plus its cwd-bound services;
 * `AgentSession` is the per-session surface (prompt/abort/compact/reload/…).
 */
export class PiSessionHost {
  constructor(private readonly runtime: AgentSessionRuntime) {}

  get session(): AgentSession {
    return this.runtime.session;
  }

  async prompt(input: HostPromptInput): Promise<void> {
    const images = toImageContents(input.images);
    await this.runtime.session.prompt(input.text, images ? { images } : undefined);
  }

  async abort(): Promise<void> {
    await this.runtime.session.abort();
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.runtime.session.compact(customInstructions);
  }

  async waitForIdle(): Promise<void> {
    await this.runtime.session.waitForIdle();
  }

  async navigateTree(targetId: string, options?: Parameters<AgentSession["navigateTree"]>[1]): Promise<SessionSwitchResult> {
    const r = await this.runtime.session.navigateTree(targetId, options);
    return { cancelled: r.cancelled };
  }

  async reload(): Promise<void> {
    await this.runtime.session.reload();
  }

  async newSession(options?: Parameters<AgentSessionRuntime["newSession"]>[0]): Promise<SessionSwitchResult> {
    const r = await this.runtime.newSession(options);
    return { cancelled: r.cancelled };
  }

  async fork(entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]): Promise<SessionSwitchResult> {
    const r = await this.runtime.fork(entryId, options);
    return { cancelled: r.cancelled };
  }

  async switchSession(sessionPath: string, options?: Parameters<AgentSessionRuntime["switchSession"]>[1]): Promise<SessionSwitchResult> {
    const r = await this.runtime.switchSession(sessionPath, options);
    return { cancelled: r.cancelled };
  }
}
