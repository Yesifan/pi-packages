import fs from "node:fs";
import path from "node:path";
import { AccountManager } from "./accounts/account-manager.js";
import {
  acquireInstanceLock,
  SerialOperations,
  storageIdentity,
  withControlLock,
} from "./config/control-lock.js";
import { RpcServer } from "./daemon/rpc-server.js";
import { createWeixinSendFileExtension } from "./pi/extensions/weixin-send-file.js";
import { createWeixinSendProgressExtension } from "./pi/extensions/weixin-send-progress.js";
import { PiSdkHost } from "./pi/sdk-host.js";
import { WeixinUIContext } from "./pi/ui-context.js";
import type {
  ProjectHostFactory,
  ProjectHostFactoryContext,
} from "./projects/project-controller.js";
import { ProjectManager } from "./projects/project-manager.js";
import { ProjectStateStore } from "./projects/project-state-store.js";
import { ProjectStore } from "./projects/project-store.js";
import type { AccountInfo, ProjectStoreData } from "./projects/types.js";
import type { CliPromptRequest } from "./sessions/cli-prompt.js";
import type { Logger } from "./util/logger.js";
import { VERSION } from "./version.js";
import { clearSessionPause } from "./weixin/api/session-guard.js";
import {
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  resolveWeixinAccountName,
} from "./weixin/auth/accounts.js";
import { WeixinFileSender } from "./weixin/file-sender.js";
import { resolveRecipientAccount } from "./weixin/recipient.js";
import { clearContextTokensForAccount } from "./weixin/storage/context-token.js";
import { ILinkWeixinTransport } from "./weixin/transport.js";
import type { WeixinTransport } from "./weixin/types.js";

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
        resolveRecipients: ctx.resolveFileRecipients,
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
 * Reads CLI-owned config (ProjectStore) -> AccountManager (per-account transports) ->
 * ProjectManager (ProjectController per project) -> account->project dispatch.
 * Graceful shutdown cancels receivers before stopping project runtimes.
 */
export class Daemon {
  private stopped = false;
  private readonly lifecycle = new SerialOperations();
  private releaseInstance: (() => void) | undefined;
  private credentials = new Map<string, string>();
  private applicationError: string | undefined;
  readonly identity: string;
  private keepAlive: NodeJS.Timeout | undefined;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private config!: ProjectStoreData;
  private readonly accountManager: AccountManager;
  private readonly projectManager: ProjectManager;
  private readonly store: ProjectStore;
  private readonly sessionState = new ProjectStateStore();
  private accountTransport: (
    accountId: string,
    token?: string,
    baseUrl?: string,
  ) => Promise<WeixinTransport>;

  private rpcServer: RpcServer | undefined;

  constructor(private readonly deps: DaemonDeps) {
    this.store = deps.store ?? new ProjectStore();
    this.identity = storageIdentity(this.store.configPath);
    const logger = deps.logger;
    this.accountManager = new AccountManager({ logger });
    this.projectManager = new ProjectManager({
      saveDefaultSession: (projectId, sessionId) => {
        const project = this.config.projects[projectId];
        const cwd = this.projectManager.getRuntime(projectId)?.config.cwd;
        if (!project || cwd !== project.cwd) throw new Error("Project configuration changed");
        this.sessionState.setDefaultSession(projectId, cwd, sessionId);
        project.defaultSessionId = sessionId;
      },
      getTransport: (id) => this.accountManager.getTransport(id),
      resolveBroadcastAccount: resolveRecipientAccount,
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
    return this.lifecycle.run(async () => {
      if (this.stopped || this.releaseInstance)
        throw new Error("daemon already started or stopped");
      this.releaseInstance = await acquireInstanceLock();
      if (!this.releaseInstance) throw new Error("A daemon already owns this data instance");
      this.keepAlive = setInterval(() => {}, 1 << 30);
      this.accountManager.onInbound((msg) => this.projectManager.dispatch(msg.accountId, msg));
      try {
        await withControlLock(() => this.reconcile());
      } catch (error) {
        // Keep management access and healthy projects when another project fails.
        // Reconcile failed (and status says so); starting the daemon is not an apply ack.
        if (!(error instanceof AggregateError)) throw error;
        this.deps.logger.error(
          { err: error },
          "daemon started with configuration application errors",
        );
      }
      if (this.deps.startRpc) {
        this.rpcServer = new RpcServer(this, this.deps.logger, this.deps.rpcSocketPath);
        await this.rpcServer.start();
      }
      this.deps.logger.info("daemon started");
    });
  }

  async stop(): Promise<void> {
    return this.lifecycle.run(async () => {
      if (this.stopped) return;
      await withControlLock(async () => {
        await this.accountManager.stopAll();
        await this.projectManager.stopAll();
      });
      await this.rpcServer?.stop();
      this.rpcServer = undefined;
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.releaseInstance?.();
      this.releaseInstance = undefined;
      this.stopped = true;
      this.resolveShutdown();
    });
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  /** Read fresh desired state under the shared lock, then apply before releasing. */
  async reload(): Promise<void> {
    return this.lifecycle.run(() =>
      withControlLock(async () => {
        if (this.stopped || !this.releaseInstance) throw new Error("daemon is not running");
        await this.reconcile();
      }),
    );
  }

  async reloadAccounts(): Promise<void> {
    await this.reload();
  }

  private async reconcile(): Promise<void> {
    try {
      await this.applySnapshot();
      this.applicationError = undefined;
    } catch (error) {
      this.applicationError =
        error instanceof Error ? error.message : "Configuration application failed";
      throw error;
    }
  }

  private async applySnapshot(): Promise<void> {
    // Finish every control read/validation before touching the current runtime.
    const config = this.store.read();
    this.sessionState.read();
    const desired = new Map(listIndexedWeixinAccountIds().map((id) => [id, loadWeixinAccount(id)]));
    if (!this.config) {
      for (const [accountId, account] of desired) {
        if (!account?.token)
          this.deps.logger.warn({ account: accountId }, "account has no token, skipping monitor");
      }
    }
    const fingerprint = (data: ReturnType<typeof loadWeixinAccount>) =>
      JSON.stringify([data?.token, data?.baseUrl, data?.userId]);
    for (const live of this.accountManager.listAccounts()) {
      const account = desired.get(live.accountId);
      if (!account?.token || this.credentials.get(live.accountId) !== fingerprint(account)) {
        await this.accountManager.remove(live.accountId);
        // Removed accounts: disk is CLI cleanup's responsibility. Credential replacement
        // invalidates runtime tokens before restore/start, including their persisted cache.
        clearContextTokensForAccount(live.accountId, !account?.token);
        clearSessionPause(live.accountId);
        this.credentials.delete(live.accountId);
      }
    }
    // Receivers above may finish an in-flight activation while stopping. Clean after
    // that wait, then publish the new snapshot without an intervening async gap.
    this.sessionState.reconcile(config.projects);
    this.config = config;
    for (const [id, account] of desired) {
      if (!account?.token || this.accountManager.has(id)) continue;
      const transport = await this.accountTransport(id, account.token, account.baseUrl);
      await this.accountManager.register(id, transport, account.userId);
      this.credentials.set(id, fingerprint(account));
    }
    await this.projectManager.sync(this.configList());
  }

  async promptProject(name: string, input: CliPromptRequest) {
    return this.projectManager.prompt(name, input);
  }

  async broadcastProject(name: string, text: string) {
    return this.projectManager.broadcast(name, text);
  }

  async restartProject(name: string): Promise<void> {
    return this.lifecycle.run(() =>
      withControlLock(async () => {
        if (this.stopped || !this.releaseInstance) throw new Error("daemon is not running");
        await this.reconcile();
        await this.projectManager.restart(name);
      }),
    );
  }

  /** Read-only identity + actual receivers; also usable while a CLI holds the control lock. */
  getControlStatus() {
    return {
      identity: this.identity,
      runningAccountIds: this.accountManager.listAccounts().map((a) => a.accountId),
    };
  }

  /** Full status snapshot for `daemon.status` / diagnostics. */
  getStatus() {
    return {
      version: VERSION,
      ...this.getControlStatus(),
      applicationError: this.applicationError,
      projects: this.getProjectStatuses(),
      accounts: this.getAccountStatuses(),
    };
  }

  private configList() {
    return Object.entries(this.config.projects).map(([name, config]) => ({
      name,
      config: {
        ...config,
        defaultSessionId:
          this.sessionState.getDefaultSession(name, config.cwd) ?? config.defaultSessionId,
      },
    }));
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

  getAccountStatuses(): AccountInfo[] {
    const live = new Map(
      this.accountManager.listAccounts().map((account) => [account.accountId, account]),
    );
    // Show desired registration separately, retaining receivers whose stop failed.
    const projects = this.store.list();
    const registered = new Set(listIndexedWeixinAccountIds());
    return [...new Set([...registered, ...live.keys()])].map((accountId) => {
      const account = loadWeixinAccount(accountId);
      const monitor = live.get(accountId);
      return {
        accountId,
        registered: registered.has(accountId),
        name: account?.name?.trim() || undefined,
        status: monitor?.status ?? "stopped",
        userId: monitor?.userId ?? account?.userId,
        projectId: projects.find(({ config }) => config.accounts.includes(accountId))?.name,
        since: account?.savedAt,
        error: monitor?.error,
      };
    });
  }
}
