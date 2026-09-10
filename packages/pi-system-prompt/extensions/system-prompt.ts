/**
 * pi-system-prompt
 *
 * Registers a `/system-prompt` slash command that prints everything Pi sends to
 * the model BEFORE the user message:
 *
 *   1. The SYSTEM MESSAGE TEXT  (the assembled preamble string).
 *   2. The TOOLS ARRAY          (the full tool definitions, `payload.tools`).
 *
 * How it captures the real values:
 *  - `before_agent_start`      -> captures `event.systemPrompt` (the fully
 *    assembled system prompt string for the turn).
 *  - `before_provider_request` -> captures `event.payload`, from which the exact
 *    `tools` array (and, if needed, the serialized `system`) is read.
 *
 * Nothing else is printed: no meta block, no prompt-inputs list, no tool
 * registry reference dump.
 *
 * Usage:
 *   /system-prompt
 *
 * Opens the dump in the editor (TUI/RPC) or prints it (print/JSON mode).
 * No file is written.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Captured per-turn so /system-prompt reflects the LAST real prompt sent.
let lastSystemPrompt: string | undefined;
let lastRawPayload: unknown | undefined;

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o, null, 2);
  } catch {
    return String(o);
  }
}

// Extract the tool definitions array from a provider payload
// (OpenAI / Anthropic `tools`, plus legacy OpenAI `functions`).
function extractTools(payload: any): unknown[] | undefined {
  if (!payload) return undefined;
  if (Array.isArray(payload.tools)) return payload.tools;
  if (Array.isArray(payload.functions)) return payload.functions;
  return undefined;
}

export default function (pi: ExtensionAPI) {
  // Capture the fully assembled system prompt for each turn.
  pi.on("before_agent_start", (event) => {
    lastSystemPrompt = event.systemPrompt;
  });

  // Capture the exact serialized request sent to the provider.
  pi.on("before_provider_request", (event) => {
    lastRawPayload = event.payload;
  });

  pi.registerCommand("system-prompt", {
    description: "Print everything Pi sends before the user message (system text + tools)",
    handler: async (_args, ctx) => {
      const systemText = lastSystemPrompt ?? ctx.getSystemPrompt();
      const tools = extractTools(lastRawPayload);

      const s: string[] = [];
      s.push("### SYSTEM PROMPT (system message text)");
      s.push("");
      s.push(systemText ?? "(unavailable - no turn captured yet)");
      s.push("");
      s.push("### TOOLS (tools array sent to the model)");
      s.push("");
      if (tools) {
        s.push("```json");
        s.push(safeStringify(tools));
        s.push("```");
      } else {
        s.push("_(no provider request captured yet in this session. Run `/system-prompt` after a turn to capture the tools array.)_");
      }

      const dump = s.join("\n");

      if (ctx.hasUI) {
        await ctx.ui.editor("System Prompt (system text + tools)", dump);
      } else {
        console.log(dump);
      }
    },
  });
}
