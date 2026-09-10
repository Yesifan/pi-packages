import type { TurnContext } from "../weixin/types.js";

/**
 * Ports through which the Pi host reaches the weixin side.
 *
 * These are implemented by `src/weixin/` (`WeixinInteractionController`,
 * `WeixinFileSender`) and injected at composition time (daemon.ts). The Pi host
 * depends only on these interfaces, never on the weixin implementation or iLink
 * types.
 */

/** UI/dialog bridge between Pi extensions and the weixin message stream. */
export interface InteractionPort {
  /** Current turn origin (set while an agent run is active). */
  getCurrentTurn(): TurnContext | undefined;
  /** Enter UI-waiting state (dialog shown). */
  beginUiInteraction(): void;
  /** Exit UI-waiting state (dialog resolved/rejected). */
  endUiInteraction(): void;
  /** True while a dialog is open. */
  isUiInteractionActive(): boolean;
  /** Resolve a pending dialog for the turn origin, returning true when one matched. */
  tryResolveUi(turn: TurnContext, text: string): boolean;
  /**
   * Resolve with the next ordinary message from the turn origin.
   * Rejects on abort/timeout/signal.
   */
  waitForResponse(
    turn: TurnContext,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string>;
  /** Reject all pending dialogs (e.g. on /abort or turn teardown). */
  cancelUiWaiters(reason: string): void;
  /** Send a fire-and-forget text reply to a turn origin (dialog/notify). */
  sendText(turn: TurnContext, text: string): Promise<void>;
}

/** File sending bridge for the `weixin_send_file` tool. */
export interface FileSenderPort {
  sendFile(turn: TurnContext, path: string, caption?: string): Promise<void>;
}
