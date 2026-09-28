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
  it("keeps the full UI API when the SDK spreads the child proxy", async () => {
    const calls: string[] = [];
    const rootUi = {
      theme: {},
      confirm: async (title: string) => {
        calls.push(title);
        return true;
      },
      setWidget: () => calls.push("root widget changed"),
    } as unknown as ExtensionUIContext;
    const proxy = new RootUiBroker(rootUi, true, 100).proxy("sa", "worker");
    const wrapped = { ...proxy } as ExtensionUIContext;
    const methods: (keyof ExtensionUIContext)[] = [
      "select",
      "confirm",
      "input",
      "notify",
      "onTerminalInput",
      "setStatus",
      "setWorkingMessage",
      "setWorkingVisible",
      "setWorkingIndicator",
      "setHiddenThinkingLabel",
      "setWidget",
      "setFooter",
      "setHeader",
      "setTitle",
      "custom",
      "pasteToEditor",
      "setEditorText",
      "getEditorText",
      "editor",
      "addAutocompleteProvider",
      "setEditorComponent",
      "getEditorComponent",
      "getAllThemes",
      "getTheme",
      "setTheme",
      "getToolsExpanded",
      "setToolsExpanded",
    ];
    for (const method of methods) expect(typeof wrapped[method]).toBe("function");
    expect(wrapped.onTerminalInput(() => undefined)).toBeTypeOf("function");
    expect(wrapped.getEditorText()).toBe("");
    await expect(wrapped.confirm("Allow?", "message")).resolves.toBe(true);
    wrapped.setWidget("child-widget", ["not forwarded"]);
    expect(calls).toEqual(["[subagent: worker / sa] Allow?"]);
    expect(Object.keys(wrapped)).not.toContain("rootUi");
    expect(Object.keys(wrapped)).not.toContain("broker");
  });
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

  it("updates and clears the root native progress widget", () => {
    const widgetCalls: Array<{
      key: string;
      lines: string[] | undefined;
      placement: string | undefined;
    }> = [];
    const rootUi = {
      setWidget: (key: string, lines: string[] | undefined, options?: { placement?: string }) =>
        widgetCalls.push({ key, lines, placement: options?.placement }),
    } as unknown as ExtensionUIContext;
    const broker = new RootUiBroker(rootUi, true, 1_000);

    broker.setProgressWidget(["worker[2]：bash pnpm test", "reviewer[1]：thinking"]);
    broker.setProgressWidget([]);

    expect(widgetCalls).toEqual([
      {
        key: "pi-subagents-progress",
        lines: ["worker[2]：bash pnpm test", "reviewer[1]：thinking"],
        placement: "belowEditor",
      },
      { key: "pi-subagents-progress", lines: undefined, placement: "belowEditor" },
    ]);
    broker.shutdown();
    expect(widgetCalls).toHaveLength(2);
  });

  it("uses deterministic fallbacks when no interactive UI exists", async () => {
    const rootUi = { setStatus: () => undefined } as unknown as ExtensionUIContext;
    const broker = new RootUiBroker(rootUi, false, 100);
    broker.setProgressWidget(["worker[1]：thinking"]);
    const proxy = broker.proxy("sa", "worker");
    await expect(proxy.confirm("title", "message")).resolves.toBe(false);
    await expect(proxy.select("title", ["one"])).resolves.toBeUndefined();
    await expect(proxy.input("title")).resolves.toBeUndefined();
    await expect(proxy.editor()).resolves.toBeUndefined();
    await expect(proxy.custom()).rejects.toThrow(/not supported/);
  });
});
