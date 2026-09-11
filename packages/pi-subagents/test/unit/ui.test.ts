import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { RootUiBroker } from "../../src/ui.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept;
    }),
    resolve,
  };
}

describe("RootUiBroker", () => {
  it("serializes blocking dialogs and cancellation advances the FIFO", async () => {
    const firstDialog = deferred<boolean>();
    const calls: string[] = [];
    const rootUi = {
      confirm: async (title: string) => {
        calls.push(title);
        if (title.includes("first")) return firstDialog.promise;
        return true;
      },
      setStatus: () => undefined,
    } as unknown as ExtensionUIContext;
    const broker = new RootUiBroker(rootUi, true, 1_000);
    const first = broker.proxy("sa_first", "first");
    const second = broker.proxy("sa_second", "second");

    const firstResult = first.confirm("confirm", "message");
    const secondResult = second.confirm("confirm", "message");
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    first.dispose();
    await expect(firstResult).resolves.toBe(false);
    await expect(secondResult).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    firstDialog.resolve(true);
    second.dispose();
    broker.shutdown();
  });

  it("uses deterministic fallbacks when no interactive UI exists", async () => {
    const rootUi = { setStatus: () => undefined } as unknown as ExtensionUIContext;
    const proxy = new RootUiBroker(rootUi, false, 100).proxy("sa", "worker");
    await expect(proxy.confirm("title", "message")).resolves.toBe(false);
    await expect(proxy.select("title", ["one"])).resolves.toBeUndefined();
    await expect(proxy.input("title")).resolves.toBeUndefined();
    await expect(proxy.editor()).resolves.toBeUndefined();
    await expect(proxy.custom()).rejects.toThrow(/not supported/);
  });
});
