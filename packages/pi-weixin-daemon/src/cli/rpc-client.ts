import net from "node:net";
import { resolveDaemonSocket } from "../config/paths.js";

export class DaemonNotRunningError extends Error {
  constructor() {
    super("Daemon is not running.\nStart it with:\n  pi-wx start");
    this.name = "DaemonNotRunningError";
  }
}

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let nextId = 1;

/**
 * Call a daemon RPC method over the UDS. Throws DaemonNotRunningError when the
 * socket is absent / connection refused. This alone does not prove receivers stopped.
 */
export async function rpcCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  socketPath = resolveDaemonSocket(),
): Promise<T> {
  return callRpc<T>(method, params, socketPath, 15_000);
}

export interface BroadcastResult {
  succeeded: number;
  skipped: number;
  failed: number;
}

/** Wait for project broadcast completion without an overall RPC timeout or retries. */
export async function rpcBroadcast(
  params: { name: string; text: string },
  socketPath = resolveDaemonSocket(),
): Promise<BroadcastResult> {
  return callRpc<BroadcastResult>("project.broadcast", params, socketPath, 0);
}

async function callRpc<T>(
  method: string,
  params: Record<string, unknown>,
  socketPath: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = net.connect(socketPath);
    const id = nextId++;
    let settled = false;
    let connected = false;
    const chunks: Buffer[] = [];
    const close = () => {
      if (!socket.destroyed) socket.destroy();
    };
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        fn();
      } finally {
        close();
      }
    };
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (buf: Buffer) => {
      if (!settled) chunks.push(buf);
    });
    // The server ends the socket after its response; data events are not message boundaries.
    socket.on("end", () => {
      done(() => {
        let resp: RpcResponse;
        try {
          const response = Buffer.concat(chunks);
          if (response.length === 0) throw new Error("Empty RPC response");
          resp = JSON.parse(response.toString("utf-8")) as RpcResponse;
          if (
            resp === null ||
            typeof resp !== "object" ||
            Array.isArray(resp) ||
            resp.id !== id ||
            typeof resp.ok !== "boolean" ||
            (resp.error !== undefined && typeof resp.error !== "string")
          ) {
            throw new Error("Invalid RPC response");
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (resp.ok) resolve(resp.result as T);
        else reject(new Error(resp.error ?? "rpc failed"));
      });
    });
    socket.on("error", (err: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          !connected && (err.code === "ENOENT" || err.code === "ECONNREFUSED")
            ? new DaemonNotRunningError()
            : err,
        ),
      ),
    );
    socket.on("timeout", () => done(() => reject(new Error("rpc timeout"))));
    socket.on("close", () => done(() => reject(new Error("rpc connection closed"))));
    socket.setTimeout(timeoutMs);
  });
}

/** Format a project status list as a table (for `project list`). */
export function formatProjectRow(p: {
  name: string;
  state: string;
  enabled: boolean;
  configured?: boolean;
  accounts: string[];
  cwd: string;
  error?: string;
}): string {
  const accounts = p.accounts.length > 0 ? p.accounts.join(",") : "-";
  const enabled = p.enabled ? "yes" : "no";
  const state = p.state;
  const err = p.error ? `  [${p.error}]` : "";
  return `${p.name.padEnd(12)}${(p.configured === false ? "no" : "yes").padEnd(11)}${state.padEnd(10)}${enabled.padEnd(9)}${accounts.padEnd(20)}${p.cwd}${err}`;
}
