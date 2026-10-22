import fs from "node:fs";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { isCliTurn, type TurnOrigin } from "../../sessions/turn-context.js";
import type { Logger } from "../../util/logger.js";
import { sanitizeFilename } from "../../util/sanitize.js";
import type { TurnContext } from "../../weixin/types.js";
import type { FileSenderPort } from "../ports.js";

export interface WeixinSendFileExtensionDeps {
  /** Sends the file to the current turn origin (implemented by weixin layer). */
  fileSender: FileSenderPort;
  /** Current turn origin (set by the session controller while a run is active). */
  getCurrentTurn: () => TurnOrigin | undefined;
  resolveRecipients?: (userId?: string) => TurnContext[];
  /** Project cwd; relative tool paths resolve against it. */
  cwd: string;
  logger: Logger;
}

const SendFileParamsSchema = Type.Object({
  userId: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional project Weixin user ID. Without it, Weixin turns send to their origin; CLI turns send to all project users.",
    }),
  ),
  path: Type.String({ description: "Absolute or cwd-relative path of the file to send" }),
  caption: Type.Optional(Type.String({ description: "Optional caption text shown with the file" })),
});

type SendFileParams = Static<typeof SendFileParamsSchema>;

export type PathValidationResult =
  | { ok: true; resolvedPath: string; basename: string }
  | { ok: false; error: string };

/**
 * Send-file policy (ADR-0003 D-G): **no path boundary**.
 *
 * Only existence + regular-file + filename sanitization are enforced. The
 * permission model is the agent process's own permissions — the same as its
 * bash/read/write tools — so no lexical sandbox is imposed here.
 */
export function validateSendFileParams(filePath: string, cwd: string): PathValidationResult {
  const resolved = path.resolve(cwd, filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `file does not exist: ${filePath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `not a regular file: ${filePath}` };
  }

  const basename = sanitizeFilename(path.basename(resolved));
  if (!basename) {
    return { ok: false, error: `invalid filename: ${filePath}` };
  }

  return { ok: true, resolvedPath: resolved, basename };
}

/**
 * Daemon-owned, in-memory weixin capability extension.
 *
 * - registered via `extensionFactories` on every session created by this daemon
 * - never written to <cwd>/.pi/extensions (invisible to plain `pi` / PI WEB)
 * - resolves the active origin and optional project user at call time; never accepts tokens/accounts
 */
export function createWeixinSendFileExtension(deps: WeixinSendFileExtensionDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "weixin_send_file",
      label: "Weixin Send File",
      description:
        "Send a native Weixin file attachment to a project user (userId). Without userId, send to the Weixin turn origin, or all project users for CLI/background turns. " +
        "The file must already exist on disk (created by other tools such as bash or write) " +
        "and be readable by the agent process. Optional caption text may accompany it.",
      parameters: SendFileParamsSchema,
      execute: async (_toolCallId, params: SendFileParams, _signal, _onUpdate) => {
        const turn = deps.getCurrentTurn();
        if (!turn && !deps.resolveRecipients) {
          deps.logger.warn("weixin_send_file called with no active turn");
          return {
            content: [
              { type: "text", text: "Error: no active Weixin conversation for this turn." },
            ],
            details: { error: "no active turn" },
          };
        }

        const validated = validateSendFileParams(params.path, deps.cwd);
        if (!validated.ok) {
          deps.logger.warn({ error: validated.error }, "weixin_send_file rejected");
          return {
            content: [{ type: "text", text: `Error: ${validated.error}` }],
            details: { error: validated.error },
          };
        }

        if (params.userId && !deps.resolveRecipients)
          throw new Error("Project recipient selection is unavailable");
        const recipients =
          params.userId || !turn || isCliTurn(turn)
            ? (deps.resolveRecipients?.(params.userId) ?? [])
            : [turn];
        if (!recipients.length) throw new Error("No project Weixin recipients");
        let succeeded = 0;
        let failed = 0;
        for (const recipient of recipients) {
          try {
            await deps.fileSender.sendFile(recipient, validated.resolvedPath, params.caption);
            succeeded++;
          } catch {
            failed++;
            deps.logger.warn({ accountId: recipient.accountId }, "file delivery failed or skipped");
          }
        }
        if (failed)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `File delivery incomplete: ${succeeded} succeeded, ${failed} failed or skipped.`,
              },
            ],
            details: { basename: validated.basename, succeeded, failed },
          };
        return {
          content: [
            {
              type: "text",
              text: `Sent file "${validated.basename}" to the Weixin conversation.`,
            },
          ],
          details: { basename: validated.basename, succeeded, failed },
        };
      },
    });
  };
}
