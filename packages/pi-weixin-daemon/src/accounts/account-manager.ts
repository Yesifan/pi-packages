import type { InboundMessage, WeixinTransport } from "../weixin/types.js";
import type { Logger } from "../util/logger.js";
import type { AccountInfo, AccountStatus } from "../projects/types.js";

export interface ManagedAccount {
  accountId: string;
  transport: WeixinTransport;
  status: AccountStatus;
  userId?: string;
  error?: string;
}

export interface AccountManagerOptions {
  logger: Logger;
}

/**
 * Owns the Weixin transport per account and its lifecycle/status. Independent of
 * projects: an account may exist here without being bound to any project (its
 * monitor still runs, inbound messages are dropped at the dispatch layer).
 *
 * Inbound subscription: the daemon registers one handler here that routes
 * accountId -> project (and drops unbound/disabled messages). This is the single
 * inbound path into the Pi layer.
 */
export class AccountManager {
  private accounts = new Map<string, ManagedAccount>();
  private inboundHandlers: Array<(message: InboundMessage) => Promise<void>> = [];
  private unsubscribes = new Map<string, () => void>();

  constructor(private readonly opts: AccountManagerOptions) {}

  /** Register a transport for an account (start its monitor if not already). */
  async register(accountId: string, transport: WeixinTransport, userId?: string): Promise<void> {
    if (this.accounts.has(accountId)) {
      throw new Error(`account already registered: ${accountId}`);
    }
    await transport.start();
    const unsub = transport.onMessage((msg) => this.forward(msg));
    this.accounts.set(accountId, {
      accountId,
      transport,
      status: "online",
      userId,
    });
    this.unsubscribes.set(accountId, unsub);
    this.opts.logger.info({ account: accountId }, "account registered");
  }

  async remove(accountId: string): Promise<void> {
    const mgd = this.accounts.get(accountId);
    if (!mgd) return;
    this.unsubscribes.get(accountId)?.();
    this.unsubscribes.delete(accountId);
    this.accounts.delete(accountId);
    await mgd.transport.stop().catch((err: unknown) =>
      this.opts.logger.warn({ err, account: accountId }, "account transport stop error"),
    );
  }

  has(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  getTransport(accountId: string): WeixinTransport | undefined {
    return this.accounts.get(accountId)?.transport;
  }

  setStatus(accountId: string, status: AccountStatus, error?: string): void {
    const mgd = this.accounts.get(accountId);
    if (!mgd) return;
    mgd.status = status;
    mgd.error = error;
  }

  listAccounts(options?: {
    userId?: (accountId: string) => string | undefined;
    projectId?: (accountId: string) => string | undefined;
    name?: (accountId: string) => string | undefined;
    since?: (accountId: string) => string | undefined;
  }): AccountInfo[] {
    return [...this.accounts.values()].map((mgd) => ({
      accountId: mgd.accountId,
      name: options?.name?.(mgd.accountId),
      status: mgd.status,
      userId: mgd.userId ?? options?.userId?.(mgd.accountId),
      projectId: options?.projectId?.(mgd.accountId),
      since: options?.since?.(mgd.accountId),
      error: mgd.error,
    }));
  }

  /** Subscribe to all inbound messages (single dispatch point). */
  onInbound(handler: (message: InboundMessage) => Promise<void>): () => void {
    this.inboundHandlers.push(handler);
    return () => {
      this.inboundHandlers = this.inboundHandlers.filter((h) => h !== handler);
    };
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.unsubscribes.keys()]) {
      await this.remove(id).catch(() => {});
    }
  }

  private async forward(message: InboundMessage): Promise<void> {
    for (const handler of [...this.inboundHandlers]) {
      await handler(message);
    }
  }
}
