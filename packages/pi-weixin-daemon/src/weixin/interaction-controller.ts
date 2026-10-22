import type { InteractionPort } from "../pi/ports.js";
import { isCliTurn, type TurnOrigin } from "../sessions/turn-context.js";
import type { Logger } from "../util/logger.js";
import type { WeixinTransport } from "./types.js";

interface UiWaiter {
  origin: TurnOrigin;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

export interface WeixinInteractionControllerDeps {
  /** Current turn origin (owned by the session controller). */
  getCurrentTurn: () => TurnOrigin | undefined;
  onCliText?: (text: string) => void;
  onCliWaiting?: () => void;
  transport: WeixinTransport;
  logger: Logger;
}

/**
 * `InteractionPort` implementation over weixin (ADR-0004).
 *
 * Bridges extension UI dialogs (confirm/select/input) to the weixin message
 * stream. The session controller sets the current turn; this controller only
 * holds the pending dialog waiters and forwards dialog text over the transport.
 */
export class WeixinInteractionController implements InteractionPort {
  private uiWaiters: UiWaiter[] = [];

  constructor(private readonly deps: WeixinInteractionControllerDeps) {}

  getCurrentTurn(): TurnOrigin | undefined {
    return this.deps.getCurrentTurn();
  }

  /** No-op: dialog visibility is inferred from pending waiters. */
  beginUiInteraction(): void {}

  /** No-op: dialog visibility is inferred from pending waiters. */
  endUiInteraction(): void {}

  isUiInteractionActive(): boolean {
    return this.uiWaiters.length > 0;
  }

  tryResolveUi(turn: TurnOrigin, text: string): boolean {
    const waiter = this.uiWaiters.find((w) =>
      isCliTurn(turn)
        ? isCliTurn(w.origin)
        : !isCliTurn(w.origin) && w.origin.accountId === turn.accountId,
    );
    if (!waiter) return false;
    waiter.resolve(text);
    return true;
  }

  waitForResponse(
    turn: TurnOrigin,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: UiWaiter = {
        origin: turn,
        resolve: (text: string) => {
          cleanup();
          resolve(text);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
      };
      const cleanup = () => {
        this.uiWaiters = this.uiWaiters.filter((w) => w !== waiter);
        opts?.signal?.removeEventListener("abort", onAbort);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      const onAbort = () => waiter.reject(new Error("UI interaction aborted"));
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      let timeoutHandle: NodeJS.Timeout | undefined;
      if (opts?.timeoutMs) {
        timeoutHandle = setTimeout(
          () => waiter.reject(new Error("UI interaction timed out")),
          opts.timeoutMs,
        );
      }
      this.uiWaiters.push(waiter);
      if (isCliTurn(turn)) this.deps.onCliWaiting?.();
      if (opts?.signal?.aborted) onAbort();
    });
  }

  cancelUiWaiters(reason: string): void {
    for (const waiter of this.uiWaiters.splice(0)) {
      waiter.reject(new Error(reason));
    }
  }

  sendText(turn: TurnOrigin, text: string): Promise<void> {
    if (isCliTurn(turn)) {
      this.deps.onCliText?.(text);
      return Promise.resolve();
    }
    return this.deps.transport.sendText(turn, text);
  }
}
