import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Domain event surface consumed outside the Pi SDK boundary. */
export type PiHostEvent =
  | { type: "text_delta"; delta: string }
  | { type: "assistant_started" }
  | { type: "assistant_finished"; stopReason: string; errorMessage?: string }
  | { type: "extension_error"; message: string; extensionPath?: string; event?: string }
  | { type: "agent_settled" }
  | { type: "other" };

/** Translate a raw SDK session event into the domain event surface. */
export function toPiHostEvent(event: AgentSessionEvent): PiHostEvent {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return { type: "text_delta", delta: event.assistantMessageEvent.delta };
  }
  if (event.type === "message_start" && event.message.role === "assistant") {
    return { type: "assistant_started" };
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    return {
      type: "assistant_finished",
      stopReason: event.message.stopReason,
      errorMessage: event.message.errorMessage,
    };
  }
  if (event.type === "agent_settled") {
    return { type: "agent_settled" };
  }
  return { type: "other" };
}

export function isTextDelta(event: PiHostEvent): event is { type: "text_delta"; delta: string } {
  return event.type === "text_delta";
}

export function isAgentSettled(event: PiHostEvent): event is { type: "agent_settled" } {
  return event.type === "agent_settled";
}
