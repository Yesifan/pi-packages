import fs from "node:fs";
import net from "node:net";
import { resolveDaemonSocket } from "../config/paths.js";
import type { ProjectBroadcastResult } from "../projects/types.js";
import type { CliPromptRequest, CliPromptResult } from "../sessions/cli-prompt.js";

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
 * socket is absent / connection refused (daemon down).
 */
export async function rpcCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  socketPath = resolveDaemonSocket(),
): Promise<T> {
  return callRpc<T>(method, params, socketPath, 15_000);
}

/** Wait for project broadcast completion without an overall RPC timeout or retries. */
export async function rpcBroadcast(
  params: { name: string; text: string },
  socketPath = resolveDaemonSocket(),
): Promise<ProjectBroadcastResult> {
  return callRpc<ProjectBroadcastResult>("project.broadcast", params, socketPath, 0);
}

export async function rpcPrompt(
  params: CliPromptRequest & { name: string },
  socketPath = resolveDaemonSocket(),
): Promise<CliPromptResult> {
  return callRpc<CliPromptResult>("project.prompt", { ...params }, socketPath, 0);
}

async function callRpc<T>(
  method: string,
  params: Record<string, unknown>,
  socketPath: string,
  timeoutMs: number,
): Promise<T> {
  if (!fs.existsSync(socketPath)) throw new DaemonNotRunningError();
  return new Promise<T>((resolve, reject) => {
    const socket = net.connect(socketPath);
    const id = nextId++;
    let settled = false;
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
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("end", () => {
      done(() => {
        let resp: RpcResponse;
        try {
          resp = JSON.parse(response) as RpcResponse;
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (resp.ok) resolve(resp.result as T);
        else reject(new Error(resp.error ?? "rpc failed"));
      });
    });
    socket.on("error", () => done(() => reject(new DaemonNotRunningError())));
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
  accounts: string[];
  cwd: string;
  error?: string;
}): string {
  const accounts = p.accounts.length > 0 ? p.accounts.join(",") : "-";
  const enabled = p.enabled ? "yes" : "no";
  const state = p.state;
  const err = p.error ? `  [${p.error}]` : "";
  return `${p.name.padEnd(12)}${state.padEnd(10)}${enabled.padEnd(9)}${accounts.padEnd(20)}${p.cwd}${err}`;
}
