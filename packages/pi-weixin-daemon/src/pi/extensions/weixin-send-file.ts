import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../../util/logger.js";
import { sanitizeFilename } from "../../util/sanitize.js";
import type { TurnContext } from "../../weixin/types.js";
import type { FileSenderPort } from "../ports.js";

export interface WeixinSendFileExtensionDeps {
  /** Sends the file to the current turn origin (implemented by weixin layer). */
  fileSender: FileSenderPort;
  /** Current turn origin (set by the session controller while a run is active). */
  getCurrentTurn: () => TurnContext | undefined;
  /** Project cwd; relative tool paths resolve against it. */
  cwd: string;
  logger: Logger;
}

const SendFileParamsSchema = Type.Object({
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
 * - reads the active TurnContext at call time; no account/user params from the agent
 */
export function createWeixinSendFileExtension(deps: WeixinSendFileExtensionDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "weixin_send_file",
      label: "Weixin Send File",
      description:
        "Send a file to the current Weixin conversation as a native Weixin file attachment. " +
        "The file must already exist on disk (created by other tools such as bash or write) " +
        "and be readable by the agent process. Optional caption text may accompany it.",
      parameters: SendFileParamsSchema,
      execute: async (_toolCallId, params: SendFileParams, _signal, _onUpdate) => {
        const turn = deps.getCurrentTurn();
        if (!turn) {
          deps.logger.warn("weixin_send_file called with no active turn");
          return {
            content: [{ type: "text", text: "Error: no active Weixin conversation for this turn." }],
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

        deps.logger.info(
          { accountId: turn.accountId, file: validated.resolvedPath },
          "weixin_send_file",
        );
        await deps.fileSender.sendFile(turn, validated.resolvedPath, params.caption);
        return {
          content: [
            {
              type: "text",
              text: `Sent file "${validated.basename}" to the Weixin conversation.`,
            },
          ],
          details: { basename: validated.basename },
        };
      },
    });
  };
}
