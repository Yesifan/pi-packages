import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { resolveDaemonSocket, resolveRuntimeDir } from "../config/paths.js";
import type { Logger } from "../util/logger.js";
import type { Daemon } from "../daemon.js";

interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface StatusResult {
  version: string;
  projects: unknown[];
  accounts: unknown[];
}

/**
 * Unix Domain Socket RPC server (typed JSON). No TCP/HTTP — local control plane only.
 * Socket perms 0600. Stale socket file is removed on start when not in use.
 */
export class RpcServer {
  private server: net.Server | undefined;
  private socketPath: string;

  constructor(
    private readonly daemon: Daemon,
    private readonly logger: Logger,
    socketPath = resolveDaemonSocket(),
  ) {
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    fs.mkdirSync(resolveRuntimeDir(), { recursive: true, mode: 0o700 });
    // Remove a stale socket file if present but no daemon listening.
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch (err) {
      this.logger.warn({ err, socket: this.socketPath }, "failed to remove stale socket");
    }

    this.server = net.createServer((socket) => {
      socket.on("data", (buf: Buffer) => this.handleConnection(socket, buf));
      socket.on("error", (err) => this.logger.warn({ err }, "rpc socket error"));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", onError);
        resolve();
      });
    });
    try {
      fs.chmodSync(this.socketPath, 0o600);
    } catch (err) {
      this.logger.warn({ err }, "failed to chmod socket 0600");
    }
    this.logger.info({ socket: this.socketPath }, "rpc server listening");
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    } catch (err) {
      this.logger.warn({ err }, "failed to remove socket on stop");
    }
  }

  private handleConnection(socket: net.Socket, buf: Buffer): void {
    void (async () => {
      let data: RpcRequest;
      try {
        data = JSON.parse(buf.toString("utf-8")) as RpcRequest;
      } catch (err) {
        this.logger.warn({ err }, "rpc: invalid JSON request");
        socket.end(JSON.stringify({ id: 0, ok: false, error: "invalid JSON" }));
        return;
      }
      try {
        const result = await this.dispatch(data.method, data.params ?? {});
        socket.end(JSON.stringify({ id: data.id, ok: true, result }));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.warn({ method: data.method, error }, "rpc method failed");
        socket.end(JSON.stringify({ id: data.id, ok: false, error }));
      }
    })();
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "daemon.status":
        return this.daemon.getStatus();
      case "project.list":
        return this.daemon.getProjectStatuses();
      case "project.get":
        return this.daemon.getProjectStatus(params.name as string);
      case "project.create":
        await this.daemon.createProject(params.name as string, params.cwd as string);
        return this.daemon.getProjectStatuses();
      case "project.account.add":
        await this.daemon.addProjectAccounts(
          params.name as string,
          (params.accounts ?? []) as string[],
        );
        return this.daemon.getProjectStatuses();
      case "project.account.remove":
        await this.daemon.removeProjectAccounts(
          params.name as string,
          (params.accounts ?? []) as string[],
        );
        return this.daemon.getProjectStatuses();
      case "project.enable":
        await this.daemon.setProjectEnabled(params.name as string, true);
        return this.daemon.getProjectStatuses();
      case "project.disable":
        await this.daemon.setProjectEnabled(params.name as string, false);
        return this.daemon.getProjectStatuses();
      case "project.restart":
        await this.daemon.restartProject(params.name as string);
        return this.daemon.getProjectStatuses();
      case "project.remove":
        await this.daemon.removeProject(params.name as string);
        return this.daemon.getProjectStatuses();
      case "account.list":
        return this.daemon.getAccountStatuses();
      case "account.reload":
        await this.daemon.reloadAccounts();
        return this.daemon.getAccountStatuses();
      case "account.logout":
        await this.daemon.logoutAccount(params.accountId as string);
        return this.daemon.getAccountStatuses();
      default:
        throw new Error(`unknown rpc method: ${method}`);
    }
  }
}
