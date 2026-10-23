import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonNotRunningError, rpcBroadcast, rpcCall } from "../../src/cli/rpc-client.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  write = vi.fn((_data: string) => true);
  setTimeout = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("close");
  });
}

describe("RPC client error boundary", () => {
  let socket: FakeSocket;

  beforeEach(() => {
    socket = new FakeSocket();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(net, "connect").mockReturnValue(socket as unknown as net.Socket);
  });

  afterEach(() => vi.restoreAllMocks());

  function respond(value: unknown) {
    socket.emit("connect");
    const request = JSON.parse(socket.write.mock.calls[0]![0] as string);
    socket.emit("data", Buffer.from(JSON.stringify({ id: request.id, ...Object(value) })));
  }

  it.each(["ENOENT", "ECONNREFUSED"])("maps pre-connect %s to daemon unavailable", async (code) => {
    const pending = rpcCall("status");
    socket.emit("error", Object.assign(new Error(code), { code }));
    await expect(pending).rejects.toBeInstanceOf(DaemonNotRunningError);
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("does not use an existence precheck that can hide permission errors", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const pending = rpcCall("status");
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    if (vi.mocked(net.connect).mock.calls.length) socket.emit("error", error);
    await expect(pending).rejects.toBe(error);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "EMFILE", "ECONNRESET", undefined])(
    "preserves pre-connect %s",
    async (code) => {
      const pending = rpcCall("status");
      const error = Object.assign(new Error("socket failed"), { code });
      socket.emit("error", error);
      await expect(pending).rejects.toBe(error);
    },
  );

  it.each(["ENOENT", "ECONNREFUSED", "ECONNRESET"])("preserves post-connect %s", async (code) => {
    const pending = rpcCall("status");
    socket.emit("connect");
    const error = Object.assign(new Error("connected socket failed"), { code });
    socket.emit("error", error);
    await expect(pending).rejects.toBe(error);
  });

  it("rejects timeout without classifying the daemon as down", async () => {
    const pending = rpcCall("status");
    expect(socket.setTimeout).toHaveBeenCalledWith(15_000);
    socket.emit("timeout");
    await expect(pending).rejects.toThrow("rpc timeout");
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("keeps broadcast timeout disabled", async () => {
    const pending = rpcBroadcast({ name: "demo", text: "hello" });
    expect(socket.setTimeout).toHaveBeenCalledWith(0);
    const result = { succeeded: 1, skipped: 0, failed: 0 };
    respond({ ok: true, result });
    await expect(pending).resolves.toEqual(result);
  });

  it("preserves daemon RPC errors", async () => {
    const pending = rpcCall("status");
    respond({ ok: false, error: "unknown project" });
    await expect(pending).rejects.toThrow("unknown project");
  });

  it.each(["{", "null", "[]", "42", '"text"', "{}", '{"ok":true}', '{"id":0,"ok":true}'])(
    "rejects invalid response %s without throwing from the event handler",
    async (response) => {
      const pending = rpcCall("status");
      expect(() => socket.emit("data", Buffer.from(response))).not.toThrow();
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(socket.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "true", 1, null])("rejects non-boolean ok: %s", async (ok) => {
    const pending = rpcCall("status");
    respond({ ok });
    await expect(pending).rejects.toThrow("Invalid RPC response");
  });

  it("rejects malformed error payloads without throwing from the event handler", async () => {
    const pending = rpcCall("status");
    expect(() => respond({ ok: false, error: { toString: null } })).not.toThrow();
    await expect(pending).rejects.toThrow("Invalid RPC response");
  });

  it("rejects close before a response", async () => {
    const pending = rpcCall("status");
    socket.emit("close");
    await expect(pending).rejects.toThrow("rpc connection closed");
  });
});
