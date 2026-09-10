import type { InboundMessage } from "../weixin/types.js";

/** A participant in a project: a real weixin sender reached via one account. */
export interface Participant {
  accountId: string;
  senderId: string;
  contextToken?: string;
  lastSeenAt: number;
}

function participantKey(accountId: string, senderId: string): string {
  return `${accountId}:${senderId}`;
}

/**
 * Tracks which `(accountId, senderId)` actually sent a message (observed), and
 * intersects that with the project's currently-configured accounts when fanning
 * out broadcasts/notices. Intersecting again even after a restart cleared the
 * observed set keeps an unbound account from ever receiving a broadcast
 * (ADR-0003 D-B).
 */
export class ParticipantRegistry {
  private observed = new Map<string, Participant>();

  register(msg: InboundMessage): void {
    this.observed.set(participantKey(msg.accountId, msg.senderId), {
      accountId: msg.accountId,
      senderId: msg.senderId,
      contextToken: msg.contextToken,
      lastSeenAt: Date.now(),
    });
  }

  /** `observed ∩ configuredAccounts` — the authorized broadcast targets. */
  getBroadcastTargets(configuredAccounts: string[]): Participant[] {
    const configured = new Set(configuredAccounts);
    return [...this.observed.values()].filter((p) => configured.has(p.accountId));
  }
}
