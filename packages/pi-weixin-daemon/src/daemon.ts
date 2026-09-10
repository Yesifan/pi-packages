import fs from "node:fs";
import path from "node:path";
import { PiSdkHost } from "./pi/sdk-host.js";
import { createWeixinSendFileExtension } from "./pi/extensions/weixin-send-file.js";
import { createWeixinSendProgressExtension } from "./pi/extensions/weixin-send-progress.js";
import { WeixinUIContext } from "./pi/ui-context.js";
import { AccountManager } from "./accounts/account-manager.js";
import type { WeixinTransport } from "./weixin/types.js";
import { migrateLegacyAccounts } from "./config/paths.js";
import { ProjectManager } from "./projects/project-manager.js";
import type {
  ProjectHostFactory,
  ProjectHostFactoryContext,
} from "./projects/project-controller.js";
import { WeixinFileSender } from "./weixin/file-sender.js";
import { ProjectStore } from "./projects/project-store.js";
import type { ProjectConfig, ProjectStoreData } from "./projects/types.js";
import {
  clearWeixinAccount,
  loadWeixinAccount,
  listIndexedWeixinAccountIds,
  resolveWeixinAccountIdByName,
  resolveWeixinAccountName,
  unregisterWeixinAccountId,
} from "./weixin/auth/accounts.js";
import { ILinkWeixinTransport } from "./weixin/transport.js";
import { RpcServer } from "./daemon/rpc-server.js";
import { VERSION } from "./version.js";
import type { Logger } from "./util/logger.js";

export interface DaemonDeps {
  logger: Logger;
  /** Inject for tests; default reads from ProjectStore. */
  store?: ProjectStore;
  /** Inject for tests; default builds a real ILinkWeixinTransport per account. */
  getAccountTransport?: (
    accountId: string,
    token?: string,
    baseUrl?: string,
  ) => Promise<WeixinTransport>;
  /** Inject for tests; default builds a real PiSdkHost bound to the project cwd. */
  projectPiFactory?: ProjectHostFactory;
  /** Start the UDS RPC server (default false; `serve` enables it). */
  startRpc?: boolean;
  rpcSocketPath?: string;
}

/** Default project Pi factory: weixin tool + UI context wired to the project interaction port. */
async function createProjectPiRuntime(ctx: ProjectHostFactoryContext): Promise<PiSdkHost> {
  const { cwd, transport, interaction, logger } = ctx;
  const inboxDir = path.join(cwd, ".pi-weixin", "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  return new PiSdkHost({
    cwd,
    logger,
    extensionFactories: [
      createWeixinSendFileExtension({
        fileSender: new WeixinFileSender(transport),
        getCurrentTurn: () => interaction.getCurrentTurn(),
        cwd,
        logger,
      }),
      createWeixinSendProgressExtension({ interaction, logger }),
    ],
    uiContext: new WeixinUIContext({ interaction, logger }),
  });
}

const defaultProjectPiFactory: ProjectHostFactory = (ctx) => createProjectPiRuntime(ctx);

function envDuration(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * pi-weixin-daemon composition root (one long-running daemon, many projects).
 *
 * Owns: config (ProjectStore) -> AccountManager (per-account transports) ->
 * ProjectManager (ProjectController per project) -> account->project dispatch.
 * Graceful shutdown stops projects first, then account monitors.
 */
export class Daemon {
  private stopped = false;
  private keepAlive: NodeJS.Timeout | undefined;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private config!: ProjectStoreData;
  private readonly accountManager: AccountManager;
  private readonly projectManager: ProjectManager;
  private readonly store: ProjectStore;
  private accountTransport: (
    accountId: string,
    token?: string,
    baseUrl?: string,
  ) => Promise<WeixinTransport>;

  private rpcServer: RpcServer | undefined;

  constructor(private readonly deps: DaemonDeps) {
    this.store = deps.store ?? new ProjectStore();
    const logger = deps.logger;
    this.accountManager = new AccountManager({ logger });
    this.projectManager = new ProjectManager({
      getTransport: (id) => this.accountManager.getTransport(id),
      factory: deps.projectPiFactory ?? defaultProjectPiFactory,
      logger,
      resolveSenderName: (id) => resolveWeixinAccountName(id) ?? id,
      turnTimeoutMs: envDuration("PI_WEIXIN_TURN_TIMEOUT_MS"),
      abortGraceMs: envDuration("PI_WEIXIN_ABORT_GRACE_MS"),
    });
    this.accountTransport =
      deps.getAccountTransport ??
      ((accountId, token, baseUrl) =>
        Promise.resolve(
          new ILinkWeixinTransport({
            accountId,
            token,
            baseUrl,
            resolveInboxDir: (id) => this.resolveInboxDir(id),
            logger,
          }),
        ));
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  /** The live project statuses (for RPC / project list). account ids -> labels for display. */
  getProjectStatuses() {
    return this.projectManager.listStatuses().map((p) => ({
      ...p,
      accounts: p.accounts.map((id) => resolveWeixinAccountName(id) ?? id),
    }));
  }

  async start(): Promise<void> {
    const { logger } = this.deps;
    migrateLegacyAccounts();
    this.config = this.store.read();
    logger.info({ projects: Object.keys(this.config.projects).length }, "daemon starting");

    // Keep the event loop alive until stop().
    this.keepAlive = setInterval(() => {}, 1 << 30);

    // --- Account monitors: one per registered account, independent of project ---
    for (const accountId of listIndexedWeixinAccountIds()) {
      const account = loadWeixinAccount(accountId);
      if (!account?.token) {
        logger.warn({ account: accountId }, "account has no token, skipping monitor");
        continue;
      }
      const transport = await this.accountTransport(accountId, account.token, account.baseUrl);
      await this.accountManager.register(accountId, transport, account.userId);
    }

    // --- Project runtimes: reconcile desired state (enabled) from config ---
    await this.projectManager.sync(this.configList());

    // --- Inbound dispatch: account -> project -> runtime ---
    this.accountManager.onInbound((msg) => this.projectManager.dispatch(msg.accountId, msg));

    // --- UDS RPC (control plane) ---
    if (this.deps.startRpc) {
      this.rpcServer = new RpcServer(this, logger, this.deps.rpcSocketPath);
      await this.rpcServer.start();
    }

    logger.info(
      { accounts: this.accountManager.listAccounts().length, projects: this.getProjectStatuses().length },
      "daemon started",
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const { logger } = this.deps;
    logger.info("daemon stopping");

    await this.projectManager.stopAll().catch((err: unknown) =>
      logger.warn({ err }, "projectManager stop error"),
    );
    await this.accountManager.stopAll().catch((err: unknown) =>
      logger.warn({ err }, "accountManager stop error"),
    );

    await this.rpcServer?.stop().catch((err: unknown) =>
      logger.warn({ err }, "rpc server stop error"),
    );
    this.rpcServer = undefined;

    if (this.keepAlive) clearInterval(this.keepAlive);
    logger.info("daemon stopped");
    this.resolveShutdown();
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  /** Reconcile projects + rebuild the account inbox routing after config change. */
  async reload(): Promise<void> {
    this.config = this.store.read();
    await this.projectManager.sync(this.configList());
  }

  // --- RPC mutation entry points (daemon is the sole config writer) ---

  /** Create a project (accounts=[], enabled=false). `cwd` is fixed after creation. */
  async createProject(name: string, cwd: string): Promise<void> {
    this.store.upsert(name, { cwd, accounts: [], enabled: false });
    await this.reload();
  }

  /** Add accounts to a project. `accounts` values are account *labels* (resolved to ilink_bot_id). */
  async addProjectAccounts(name: string, labels: string[]): Promise<void> {
    const ids: string[] = [];
    for (const label of labels) {
      const id = resolveWeixinAccountIdByName(label);
      if (!id) throw new Error(`account "${label}" is not registered (run \`pi-wx login --name ${label}\` first)`);
      ids.push(id);
    }
    this.store.addAccounts(name, ids);
    await this.reload();
  }

  /** Remove accounts from a project. `accounts` values are account *labels*. */
  async removeProjectAccounts(name: string, labels: string[]): Promise<void> {
    const ids = labels.map((label) => {
      const id = resolveWeixinAccountIdByName(label);
      if (!id) throw new Error(`account "${label}" is not registered`);
      return id;
    });
    this.store.removeAccounts(name, ids);
    await this.reload();
  }

  async setProjectEnabled(name: string, enabled: boolean): Promise<void> {
    this.store.setEnabled(name, enabled);
    await this.reload();
  }

  async restartProject(name: string): Promise<void> {
    await this.projectManager.restart(name);
  }

  async removeProject(name: string): Promise<void> {
    this.store.remove(name);
    await this.reload();
  }

  /** Re-read the account index and register any newly logged-in accounts. */
  async reloadAccounts(): Promise<void> {
    // Reconcile: stop transports for accounts no longer registered.
    const index = new Set(listIndexedWeixinAccountIds());
    for (const info of this.accountManager.listAccounts()) {
      if (!index.has(info.accountId)) {
        await this.accountManager.remove(info.accountId).catch((err: unknown) =>
          this.deps.logger.warn({ err, account: info.accountId }, "account stop error"),
        );
        this.deps.logger.info({ account: info.accountId }, "account monitor stopped (logged out)");
      }
    }
    // Start monitors for newly-logged-in accounts.
    for (const accountId of index) {
      if (this.accountManager.has(accountId)) continue;
      const account = loadWeixinAccount(accountId);
      if (!account?.token) continue;
      const transport = await this.accountTransport(accountId, account.token, account.baseUrl);
      await this.accountManager.register(accountId, transport, account.userId);
    }
  }

  /** Log out an account: clear credentials, unbind from projects, stop its monitor. */
  async logoutAccount(accountId: string): Promise<void> {
    // 1. Remove the account from any project config first (config stays valid).
    for (const { name, config } of this.store.list()) {
      if (config.accounts.includes(accountId)) {
        this.store.removeAccounts(name, [accountId]);
        this.deps.logger.info({ project: name, account: accountId }, "removed account from project");
      }
    }
    // 2. Stop its monitor first so it can't rewrite the sync/context-token files.
    if (this.accountManager.has(accountId)) {
      await this.accountManager.remove(accountId).catch((err: unknown) =>
        this.deps.logger.warn({ err, account: accountId }, "account stop error"),
      );
    }
    // 3. Clear credentials + index.
    clearWeixinAccount(accountId);
    unregisterWeixinAccountId(accountId);
    // 4. Reconcile projects + routes.
    await this.reload();
  }

  /** Full status snapshot for `daemon.status` / diagnostics. */
  getStatus() {
    return {
      version: VERSION,
      projects: this.getProjectStatuses(),
      accounts: this.getAccountStatuses(),
    };
  }

  private configList() {
    return Object.entries(this.config.projects).map(([name, config]) => ({ name, config }));
  }

  /** Gate + inbox resolution for an account: its project's inbox (and gate reason). */
  private resolveInboxDir(accountId: string): { dir?: string; reason?: "unbound" | "disabled" } {
    const projectId = this.projectManager.getProjectIdForAccount(accountId);
    if (!projectId) return { dir: undefined, reason: "unbound" };
    const cfg = this.config.projects[projectId];
    if (!cfg || !cfg.enabled) return { dir: undefined, reason: "disabled" };
    return { dir: path.join(cfg.cwd, ".pi-weixin", "inbox") };
  }

  /** Single project status (for RPC project.get). */
  getProjectStatus(name: string) {
    const st = this.getProjectStatuses().find((s) => s.name === name);
    if (!st) throw new Error(`project "${name}" does not exist`);
    return st;
  }

  getAccountStatuses() {
    return this.accountManager.listAccounts({
      userId: (id) => this.accountUser(id),
      projectId: (id) => this.projectManager.getProjectIdForAccount(id),
      name: (id) => resolveWeixinAccountName(id),
      since: (id) => loadWeixinAccount(id)?.savedAt,
    });
  }

  private accountUser(accountId: string): string | undefined {
    return loadWeixinAccount(accountId)?.userId;
  }
}
