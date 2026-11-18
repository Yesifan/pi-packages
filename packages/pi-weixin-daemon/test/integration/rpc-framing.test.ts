import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonNotRunningError, rpcCall } from "../../src/cli/rpc-client.js";

describe("RPC response EOF framing over real UDS", () => {
  let directory: string;
  let socketPath: string;
  let server: net.Server;
  let client: net.Socket;
  let peer: net.Socket;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "wx-framing-"));
    socketPath = path.join(directory, "rpc.sock");
    server = net.createServer();
    server.listen(socketPath);
    await once(server, "listening");
    const connect = net.connect;
    vi.spyOn(net, "connect").mockImplementation(((address: string) => {
      client = connect(address);
      return client;
    }) as typeof net.connect);
  });

  afterEach(async () => {
    client?.destroy();
    peer?.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function request() {
    const connection = once(server, "connection");
    const pending = rpcCall("status", {}, socketPath);
    // Attach immediately: failures during deliberately fragmented writes are expected on old code.
    void pending.catch(() => {});
    [peer] = (await connection) as [net.Socket];
    const [data] = await once(peer, "data");
    const { id, method, params } = JSON.parse(data.toString());
    expect({ method, params }).toEqual({ method: "status", params: {} });
    return { pending, id };
  }

  async function writeChunk(chunk: Buffer) {
    const received = once(client, "data");
    peer.write(chunk);
    await received;
  }

  it.each([true, false])("decodes split multibyte response (ok=%s) only at EOF", async (ok) => {
    const { pending, id } = await request();
    const message = "项目完成🙂";
    const response = Buffer.from(JSON.stringify({ id, ok, result: message, error: message }));
    // Split inside both a three-byte Chinese character and a four-byte emoji.
    const first = response.indexOf(Buffer.from("项")) + 1;
    const second = response.indexOf(Buffer.from("🙂")) + 2;
    await writeChunk(response.subarray(0, first));
    expect(client.destroyed).toBe(false);
    await writeChunk(response.subarray(first, second));
    expect(client.destroyed).toBe(false);
    await writeChunk(response.subarray(second));
    expect(client.destroyed).toBe(false);
    peer.end();
    if (ok) await expect(pending).resolves.toBe(message);
    else await expect(pending).rejects.toThrow(message);
    expect(net.connect).toHaveBeenCalledOnce();
  });

  it.each(["truncated", "invalid", "empty"])("rejects %s response at EOF", async (kind) => {
    const { pending, id } = await request();
    const payload =
      kind === "empty" ? "" : kind === "invalid" ? "not JSON" : `{"id":${id},"ok":true`;
    peer.end(payload);
    const error = await pending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DaemonNotRunningError);
    if (kind === "empty") expect((error as Error).message).toBe("Empty RPC response");
    expect(net.connect).toHaveBeenCalledOnce();
  });

  it.each(["close", "timeout"])(
    "rejects %s without EOF after receiving complete JSON",
    async (event) => {
      const { pending, id } = await request();
      await writeChunk(Buffer.from(JSON.stringify({ id, ok: true, result: "unfinished" })));
      // A real peer shutdown normally emits end; simulate the distinct local close/timeout paths.
      if (event === "close") client.destroy();
      else client.emit("timeout");
      await expect(pending).rejects.toThrow(
        event === "close" ? "rpc connection closed" : "rpc timeout",
      );
      expect(net.connect).toHaveBeenCalledOnce();
    },
  );
});
