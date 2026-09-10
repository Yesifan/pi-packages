import type { InboundMessage, TurnContext } from "../weixin/types.js";

/** Convert an inbound message into the reply origin (TurnContext) for it. */
export function toTurnContext(msg: InboundMessage): TurnContext {
  return {
    accountId: msg.accountId,
    senderId: msg.senderId,
    messageId: msg.messageId,
    contextToken: msg.contextToken,
  };
}

/**
 * Holds the origin of the current agent turn. Set for the whole run; every
 * reply, file send and UI prompt must go back to this origin only.
 */
export class CurrentTurn {
  private turn: TurnContext | undefined;

  set(turn: TurnContext | undefined): void {
    this.turn = turn;
  }

  get(): TurnContext | undefined {
    return this.turn;
  }
}
