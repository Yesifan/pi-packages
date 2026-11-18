import fs from "node:fs";
import net from "node:net";
import { resolveDaemonSocket, resolveRuntimeDir } from "../config/paths.js";
import type { Daemon } from "../daemon.js";
import type { Logger } from "../util/logger.js";

interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Unix Domain Socket RPC server (typed JSON). No TCP/HTTP — local control plane only.
 * Socket perms 0600. Stale socket file is removed on start when not in use.
 */
export class RpcServer {
  private server: net.Server | undefined;
  private socketPath: string;
  private sockets = new Set<net.Socket>();

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
        await new Promise<void>((resolve, reject) => {
          const probe = net.connect(this.socketPath);
          probe.once("connect", () => {
            probe.destroy();
            reject(new Error("Socket already has a listener"));
          });
          probe.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
            else reject(error);
          });
        });
        fs.unlinkSync(this.socketPath);
      }
    } catch (err) {
      this.logger.warn(
        { err, socket: this.socketPath },
        "refusing occupied or inaccessible socket",
      );
      throw err;
    }

    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      const chunks: Buffer[] = [];
      let reading = true;
      const finishReading = () => {
        reading = false;
        chunks.length = 0;
        socket.setTimeout(0);
      };
      // Requests use newline framing; responses still end at EOF. One request per connection.
      socket.setTimeout(15_000);
      socket.on("timeout", () => {
        if (reading) {
          finishReading();
          socket.destroy();
        }
      });
      socket.on("data", (buf: Buffer) => {
        if (!reading) return;
        const newline = buf.indexOf(0x0a);
        if (newline === -1) {
          chunks.push(buf);
          return;
        }
        chunks.push(buf.subarray(0, newline));
        const request = Buffer.concat(chunks);
        finishReading(); // Long broadcasts must not inherit the request-read timeout.
        this.handleConnection(socket, request);
      });
      socket.on("end", () => {
        if (reading) {
          finishReading();
          socket.destroy();
        }
      });
      socket.on("close", finishReading);
      socket.on("error", (err) => this.logger.warn({ err }, "rpc socket error"));
    });
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.off("error", onError);
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
    const server = this.server;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          throw new Error("request must be an object");
        }
      } catch (err) {
        this.logger.warn({ err }, "rpc: invalid JSON request");
        socket.end(JSON.stringify({ id: 0, ok: false, error: "invalid JSON" }));
        return;
      }
      try {
        const result = await this.dispatch(data.method, data.params ?? {});
        if (!socket.destroyed) socket.end(JSON.stringify({ id: data.id, ok: true, result }));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.warn({ method: data.method, error }, "rpc method failed");
        if (!socket.destroyed) socket.end(JSON.stringify({ id: data.id, ok: false, error }));
      }
    })();
  }

  private requireIdentity(params: Record<string, unknown>): void {
    if (params.identity !== this.daemon.identity)
      throw new Error("Storage identity mismatch; refusing another configuration/data instance");
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
      case "project.account.add":
      case "project.account.remove":
      case "project.enable":
      case "project.disable":
      case "project.remove":
      case "account.logout":
        throw new Error("Control writes moved to CLI; upgrade CLI and daemon together");
      case "project.prompt":
        if (typeof params.name !== "string" || !params.name.trim())
          throw new Error("prompt project name must not be blank");
        return this.daemon.promptProject(params.name, {
          text: params.text as string,
          sessionId: params.sessionId as string | undefined,
          newSession: params.newSession as boolean | undefined,
          reply: params.reply as string[] | undefined,
        });
      case "project.broadcast":
        if (typeof params.name !== "string" || !params.name.trim()) {
          throw new Error("broadcast project name must be a non-empty string");
        }
        if (typeof params.text !== "string" || !params.text.trim()) {
          throw new Error("broadcast text must be a non-blank string");
        }
        return this.daemon.broadcastProject(params.name, params.text);
      case "project.restart":
        this.requireIdentity(params);
        await this.daemon.restartProject(params.name as string);
        return this.daemon.getProjectStatuses();
      case "account.list":
        return this.daemon.getAccountStatuses();
      case "control.status":
        this.requireIdentity(params);
        return this.daemon.getControlStatus();
      case "account.reload":
      case "control.sync":
        this.requireIdentity(params);
        await this.daemon.reload();
        return this.daemon.getControlStatus();
      default:
        throw new Error(`unknown rpc method: ${method}`);
    }
  }
}
