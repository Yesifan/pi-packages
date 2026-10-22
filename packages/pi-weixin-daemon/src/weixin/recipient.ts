import { loadWeixinAccount } from "./auth/accounts.js";
import { getContextToken } from "./storage/context-token.js";
import type { TurnContext } from "./types.js";

export type ResolveRecipientAccount = (accountId: string) => {
  userId?: string;
  contextToken?: string;
} | null;

/** Login identity and its exact persisted token; never an observed-sender fallback. */
export const resolveRecipientAccount: ResolveRecipientAccount = (accountId) => {
  const account = loadWeixinAccount(accountId);
  if (!account) return null;
  return {
    userId: account.userId,
    contextToken: account.userId ? getContextToken(accountId, account.userId) : undefined,
  };
};

export class RecipientUnavailableError extends Error {
  constructor(
    readonly reason:
      | "missing-account"
      | "missing-user"
      | "missing-context-token"
      | "missing-transport",
    readonly userId?: string,
  ) {
    super(`Weixin recipient unavailable: ${reason}`);
    this.name = "RecipientUnavailableError";
  }
}

/** Resolve a delivery copy while preserving the original inbound/turn identity. */
export function resolveRecipient(
  origin: TurnContext,
  resolveAccount: ResolveRecipientAccount = resolveRecipientAccount,
): TurnContext {
  const account = resolveAccount(origin.accountId);
  if (!account) throw new RecipientUnavailableError("missing-account");
  if (!account.userId) throw new RecipientUnavailableError("missing-user");
  const contextToken =
    (origin.senderId === account.userId ? origin.contextToken : undefined) || account.contextToken;
  if (!contextToken) throw new RecipientUnavailableError("missing-context-token", account.userId);
  return { ...origin, senderId: account.userId, contextToken };
}
