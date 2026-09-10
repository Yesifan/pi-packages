import { DAEMON_COMMANDS, type DaemonCommand } from "../sessions/commands.js";

export type RoutedInput =
  | { kind: "daemon-command"; command: DaemonCommand; args: string }
  | { kind: "prompt"; text: string }
  | { kind: "unknown-command"; text: string }
  | { kind: "message"; text: string };

/** Pure classifier; unknown slash input is never implicitly forwarded to Pi. */
export class CommandRouter {
  classify(text: string | undefined): RoutedInput {
    if (!text) return { kind: "message", text: text ?? "" };
    const trimmed = text.trim();
    const prompt = /^\/p:(.*)$/is.exec(trimmed);
    if (prompt) return { kind: "prompt", text: prompt[1] ?? "" };
    const m = /^\/([a-z][a-z0-9-]*)\s*(.*)$/is.exec(trimmed);
    if (!m) return { kind: "message", text };
    const name = m[1]!.toLowerCase();
    if ((DAEMON_COMMANDS as readonly string[]).includes(name)) {
      return { kind: "daemon-command", command: name as DaemonCommand, args: m[2] ?? "" };
    }
    return { kind: "unknown-command", text: name };
  }
}
