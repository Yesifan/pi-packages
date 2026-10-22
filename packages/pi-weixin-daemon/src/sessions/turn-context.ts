import type { InboundMessage, TurnContext } from "../weixin/types.js";

export interface CliTurnOrigin {
  kind: "cli";
  messageId: string;
}

export type TurnOrigin = TurnContext | CliTurnOrigin;

export function isCliTurn(turn: TurnOrigin): turn is CliTurnOrigin {
  return "kind" in turn && turn.kind === "cli";
}

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
  private turn: TurnOrigin | undefined;

  set(turn: TurnOrigin | undefined): void {
    this.turn = turn;
  }

  get(): TurnOrigin | undefined {
    return this.turn;
  }
}
