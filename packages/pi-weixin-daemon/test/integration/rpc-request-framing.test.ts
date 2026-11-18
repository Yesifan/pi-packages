import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcServer } from "../../src/daemon/rpc-server.js";
import type { Daemon } from "../../src/daemon.js";
import { createLogger } from "../../src/util/logger.js";

describe("RPC request framing", () => {
  let directory: string;
  let server: RpcServer;
  let client: net.Socket;
  let peer: net.Socket;
  let response: Promise<string>;
  const broadcast = vi.fn();
  const frame = (text = "项目🙂\n通知") =>
    Buffer.from(
      `${JSON.stringify({ id: 1, method: "project.broadcast", params: { name: "demo", text } })}\n`,
    );

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "wx-request-"));
    vi.stubEnv("XDG_RUNTIME_DIR", directory);
    broadcast.mockReset().mockResolvedValue({ succeeded: 1 });
    const create = vi.spyOn(net, "createServer");
    server = new RpcServer(
      { broadcastProject: broadcast } as unknown as Daemon,
      createLogger({ level: "silent" }),
      path.join(directory, "rpc.sock"),
    );
    await server.start();
    const listener = create.mock.results[0]!.value as net.Server;
    const connection = once(listener, "connection");
    client = net.connect(path.join(directory, "rpc.sock"));
    response = new Promise((resolve) => {
      const chunks: Buffer[] = [];
      client.on("data", (chunk) => chunks.push(chunk));
      client.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    [peer] = (await connection) as [net.Socket];
  });

  afterEach(async () => {
    client?.destroy();
    peer?.destroy();
    await server.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function send(chunk: Buffer | string) {
    const received = once(peer, "data");
    client.write(chunk);
    await received;
  }

  it("buffers split JSON and UTF-8 until newline, dispatching once", async () => {
    const bytes = frame();
    const a = bytes.indexOf(Buffer.from("项")) + 1;
    const b = bytes.indexOf(Buffer.from("🙂")) + 2;
    await send(bytes.subarray(0, a));
    expect(broadcast).not.toHaveBeenCalled();
    await send(bytes.subarray(a, b));
    await send(bytes.subarray(b, -1));
    expect(broadcast).not.toHaveBeenCalled();
    await send("\n");
    expect(JSON.parse(await response)).toEqual({ id: 1, ok: true, result: { succeeded: 1 } });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith("demo", "项目🙂\n通知");
  });

  it("ignores additional frames and data while a long broadcast is pending", async () => {
    let finish!: () => void;
    broadcast.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await send(Buffer.concat([frame(), frame("ignored")]));
    expect(broadcast).toHaveBeenCalledOnce();
    expect(peer.timeout).toBe(0);
    await send(frame("also ignored"));
    expect(broadcast).toHaveBeenCalledOnce();
    finish();
    expect(JSON.parse(await response).ok).toBe(true);
  });

  it.each(["{", "not JSON", "null", "[]"])(
    "rejects invalid JSON %s at newline",
    async (payload) => {
      await send(`${payload}\n`);
      expect(JSON.parse(await response)).toEqual({ id: 0, ok: false, error: "invalid JSON" });
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it.each(["{", "complete"])(
    "does not dispatch an unterminated request at EOF: %s",
    async (kind) => {
      client.end(kind === "complete" ? frame().subarray(0, -1) : "{");
      await response;
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("closes an incomplete request on read timeout", async () => {
    await send(frame().subarray(0, -1));
    expect(peer.timeout).toBe(15_000);
    const closed = once(peer, "close");
    peer.setTimeout(10);
    await closed;
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("finishes a dispatched operation after the caller disconnects without redispatch", async () => {
    let finish!: () => void;
    broadcast.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await send(frame());
    const closed = once(peer, "close");
    client.destroy();
    await closed;
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it("does not dispatch after disconnecting mid-frame", async () => {
    await send("{");
    const closed = once(peer, "close");
    client.destroy();
    await closed;
    expect(broadcast).not.toHaveBeenCalled();
  });
});
