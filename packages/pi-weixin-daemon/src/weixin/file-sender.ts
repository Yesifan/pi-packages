import type { FileSenderPort } from "../pi/ports.js";
import type { TurnContext, WeixinTransport } from "./types.js";

/**
 * `FileSenderPort` implementation over the per-project weixin transport.
 *
 * No path boundary is imposed here (ADR-0003 D-G): the permission model is the
 * agent process's own permissions, matching its bash/read/write tools. The
 * `weixin_send_file` tool adapter only checks existence + regular-file +
 * sanitized filename before delegating here.
 */
export class WeixinFileSender implements FileSenderPort {
  constructor(private readonly transport: Pick<WeixinTransport, "sendFile">) {}

  sendFile(turn: TurnContext, path: string, caption?: string): Promise<void> {
    return this.transport.sendFile(turn, path, caption);
  }
}
