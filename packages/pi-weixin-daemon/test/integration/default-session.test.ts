import { describe, expect, it, vi } from "vitest";
import type { HostStatus } from "../../src/pi/types.js";
import { SessionController } from "../../src/sessions/session-controller.js";
import { CurrentTurn } from "../../src/sessions/turn-context.js";
import { createLogger } from "../../src/util/logger.js";
import { WeixinInteractionController } from "../../src/weixin/interaction-controller.js";
import { FakeAgentRuntime } from "../helpers/fake-runtime.js";
import { FakeWeixinTransport, makeInboundMessage } from "../helpers/fake-transport.js";

class HistoryRuntime extends FakeAgentRuntime {
  id: string | undefined;
  sequence = 0;
  override async ensureSession() {
    await super.ensureSession();
    this.id = `session-${++this.sequence}`;
    this.sessions.push({
      id: this.id,
      path: `/${this.id}`,
      name: this.id,
      firstMessage: "",
      modifiedAt: 0,
    });
  }
  override async newSession() {
    await this.ensureSession();
    return { cancelled: false };
  }
  override async resumeSession(path: string) {
    const session = this.sessions.find((item) => item.path === path);
    if (!session) throw new Error("missing history");
    this.id = session.id;
    return super.resumeSession(path);
  }
  override getStatus(): HostStatus {
    return {
      ...super.getStatus(),
      sessionId: this.activeSession ? this.id : undefined,
      sessionFile: this.activeSession ? `/${this.id}` : undefined,
    };
  }
}

const logger = createLogger({ level: "silent" });
const message = (text: string) => makeInboundMessage({ accountId: "a", senderId: "u", text });
function setup(defaultSessionId?: string) {
  const runtime = new HistoryRuntime();
  const transport = new FakeWeixinTransport();
  const currentTurn = new CurrentTurn();
  const interaction = new WeixinInteractionController({
    getCurrentTurn: () => currentTurn.get(),
    transport,
    logger,
  });
  const saved: string[] = [];
  const notices: string[] = [];
  const broadcast = vi.fn(async (text: string) => {
    notices.push(text);
  });
  const controller = new SessionController({
    projectId: "foo",
    defaultSessionId,
    saveDefaultSession: (id) => {
      saved.push(id);
    },
    host: runtime,
    transport,
    currentTurn,
    interaction,
    logger,
    resolveRecipientUserId: () => "u",
    broadcastText: broadcast,
  });
  return { runtime, controller, transport, saved, notices, broadcast };
}

describe("project default session", () => {
  it("holds the project gate until resume notifications finish and preserves the next turn's busy state", async () => {
    const h = setup();
    await h.controller.handleCommand("new", "", message("/new"));
    await h.controller.handleCommand("new", "", message("/new"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.broadcast.mockImplementationOnce(async () => blocked);
    const switching = h.controller.handleCommand(
      "resume",
      "session-1",
      message("/resume session-1"),
    );
    await vi.waitFor(() => expect(h.runtime.id).toBe("session-1"));
    await h.controller.handleUserMessage(message("during notification"));
    expect(h.runtime.prompts).toHaveLength(0);
    expect(h.controller.getState()).toBe("replacing");
    await h.controller.handleCommand("compact", "", message("/compact"));
    expect(h.runtime.compactCalls).toBe(0);
    expect(h.controller.getState()).toBe("replacing");
    release();
    await switching;
    const pending = h.controller.handleUserMessage(message("after notification"));
    await vi.waitFor(() => expect(h.runtime.prompts).toHaveLength(1));
    expect(h.controller.getState()).toBe("busy");
    await h.controller.handleCommand("new", "", message("/new"));
    expect(h.runtime.id).toBe("session-1");
    h.runtime.complete("done");
    await pending;
    await h.controller.stop();
  });

  it("does not clear faulted after SDK replacement destroys the previous session", async () => {
    const h = setup();
    await h.controller.handleCommand("new", "", message("/new"));
    await h.controller.handleCommand("new", "", message("/new"));
    vi.spyOn(h.runtime, "resumeSession").mockImplementation(async () => {
      // A stale host reference may still claim a session after SDK disposal.
      throw new Error("replacement failed after disposal");
    });
    await h.controller.handleCommand("resume", "session-1", message("/resume session-1"));
    expect(h.controller.getState()).toBe("faulted");
    await h.controller.handleUserMessage(message("must not prompt disposed session"));
    expect(h.runtime.prompts).toHaveLength(0);
    await h.controller.stop();
  });

  it("notification failure never rolls back a successful activation", async () => {
    const h = setup();
    h.broadcast.mockRejectedValueOnce(new Error("transport failed"));
    await h.controller.handleCommand("new", "", message("/new"));
    expect(h.runtime.id).toBe("session-1");
    expect(h.saved).toEqual(["session-1"]);
    expect(h.controller.getState()).toBe("ready");
    await h.controller.stop();
  });

  it("creates inactive /new, preserves the first default and only /default changes it", async () => {
    const h = setup();
    await h.controller.handleCommand("new", "", message("/new"));
    expect(h.saved).toEqual(["session-1"]);
    expect(h.notices).toEqual(["当前会话已切换为「session-1」"]);
    await h.controller.handleCommand("new", "", message("/new"));
    expect(h.saved).toEqual(["session-1"]);
    await h.controller.handleCommand("default", "session-1", message("/default session-1"));
    expect(h.runtime.id).toBe("session-2");
    expect(h.notices).toHaveLength(2);
    await h.controller.handleCommand("resume", "default", message("/resume default"));
    expect(h.runtime.id).toBe("session-1");
    expect(h.notices).toHaveLength(3);
    await h.controller.handleCommand("resume", "session-1", message("/resume session-1"));
    expect(h.notices).toHaveLength(3);
    await h.controller.stop();
  });

  it("restores recorded default after runtime release without switch notification", async () => {
    const h = setup();
    await h.controller.handleCommand("new", "", message("/new"));
    await h.controller.handleCommand("new", "", message("/new"));
    await h.controller.stop();
    await h.controller.start();
    h.notices.length = 0;
    const pending = h.controller.handleUserMessage(message("continue"));
    await vi.waitFor(() => expect(h.runtime.prompts).toHaveLength(1));
    expect(h.runtime.id).toBe("session-1");
    h.runtime.complete("done");
    await pending;
    expect(h.notices).toEqual(["done"]);
    await h.controller.stop();
  });

  it("fails on missing default but explicit new and default repair it", async () => {
    const h = setup("missing");
    await h.controller.handleUserMessage(message("continue"));
    expect(h.runtime.prompts).toHaveLength(0);
    expect(h.runtime.ensureSessionCalls).toBe(0);
    expect(h.transport.sentTexts.at(-1)?.text).toContain("missing");
    await h.controller.handleCommand("new", "", message("/new"));
    expect(h.controller.getStatus().defaultSessionId).toBe("missing");
    await h.controller.handleCommand("default", "", message("/default"));
    expect(h.saved).toEqual(["session-1"]);
    await h.controller.stop();
  });

  it("rejects session changes while a prompt is running", async () => {
    const h = setup();
    const pending = h.controller.handleUserMessage(message("work"));
    await vi.waitFor(() => expect(h.runtime.prompts).toHaveLength(1));
    await h.controller.handleCommand("resume", "different", message("/resume different"));
    expect(h.runtime.resumeCalls).toEqual([]);
    expect(h.transport.sentTexts.at(-1)?.text).toContain("忙");
    h.runtime.complete("done");
    await pending;
    await h.controller.stop();
  });
});
