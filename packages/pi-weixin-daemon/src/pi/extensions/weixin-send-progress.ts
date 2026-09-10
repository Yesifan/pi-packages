import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../../util/logger.js";
import type { InteractionPort } from "../ports.js";

const MAX_PROGRESS_LENGTH = 200;

const SendProgressParamsSchema = Type.Object({
  update: Type.String({
    description: "Concise progress update for the current user",
    minLength: 1,
    maxLength: MAX_PROGRESS_LENGTH,
  }),
});

type SendProgressParams = Static<typeof SendProgressParamsSchema>;
interface SendProgressDetails {
  sent: boolean;
  error?: string;
}

export interface WeixinSendProgressExtensionDeps {
  /** Current turn lookup and origin-only text delivery. */
  interaction: InteractionPort;
  logger: Logger;
}

/** Remove unsafe formatting and enforce a small transport-side size limit. */
export function sanitizeProgressUpdate(update: string): string {
  return update
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROGRESS_LENGTH)
    .trim();
}

/**
 * Daemon-owned progress capability. Updates always go to the active turn
 * origin; account/user routing is deliberately not exposed to the agent.
 */
export function createWeixinSendProgressExtension(
  deps: WeixinSendProgressExtensionDeps,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "weixin_send_progress",
      label: "Weixin Send Progress",
      description:
        "For especially longer tasks requiring many tool calls or multiple planned steps, " +
        "send progress updates to the current Weixin user at reasonable intervals. Each update " +
        "must be one or two concise sentences, no more than 8-10 words long, recapping progress " +
        "so far in plain language and stating what comes next. Do not use for short tasks or the final answer.",
      parameters: SendProgressParamsSchema,
      execute: async (_toolCallId, params: SendProgressParams): Promise<AgentToolResult<SendProgressDetails>> => {
        const turn = deps.interaction.getCurrentTurn();
        if (!turn) {
          deps.logger.warn("weixin_send_progress called with no active turn");
          return {
            content: [{ type: "text", text: "Error: no active Weixin conversation for this turn." }],
            details: { sent: false, error: "no active turn" } satisfies SendProgressDetails,
          };
        }

        const update = sanitizeProgressUpdate(params.update);
        if (!update) {
          deps.logger.warn("weixin_send_progress rejected an empty update");
          return {
            content: [{ type: "text", text: "Error: progress update is empty." }],
            details: { sent: false, error: "empty update" } satisfies SendProgressDetails,
          };
        }

        deps.logger.info({ accountId: turn.accountId }, "weixin_send_progress");
        await deps.interaction.sendText(turn, update);
        return {
          content: [{ type: "text", text: "Progress update sent. Continue the task." }],
          details: { sent: true } satisfies SendProgressDetails,
        };
      },
    });
  };
}
