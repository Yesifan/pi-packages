import { resolve } from "node:path";
import type { AutocompleteProviderFactory, SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createReferenceProvider, expandReferences } from "../src/references.js";

type Provider = Parameters<AutocompleteProviderFactory>[0];
function session(id: string, name: string | undefined = "Design notes", modified = 0): SessionInfo {
  return {
    id,
    name,
    path: `sessions/${id} with spaces.jsonl`,
    cwd: "/project",
    created: new Date(0),
    modified: new Date(modified),
    messageCount: 0,
    firstMessage: "",
    allMessagesText: "",
  };
}
function original(): Provider {
  return {
    triggerCharacters: ["/"],
    getSuggestions: vi.fn(async () => ({ items: [{ value: "file", label: "file" }], prefix: "@" })),
    applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
    shouldTriggerFileCompletion: vi.fn(() => true),
  };
}
const options = () => ({ signal: new AbortController().signal });

// Pi 1.1.0 Editor.requestAutocomplete gates forced Tab requests before enumeration.
async function pressTab(provider: Provider, text: string) {
  const lines = [text];
  if (
    provider.shouldTriggerFileCompletion &&
    !provider.shouldTriggerFileCompletion(lines, 0, text.length)
  )
    return null;
  return provider.getSuggestions(lines, 0, text.length, { ...options(), force: true });
}

describe("reference provider", () => {
  it("matches names case-insensitively, orders recent first, limits to 20 and excludes unnamed sessions", async () => {
    const list = vi.fn(async () => [
      ...Array.from({ length: 25 }, (_, i) => session(`${i}`, "Design notes", i)),
      session("unnamed", ""),
      { ...session("missing"), name: undefined },
    ]);
    const provider = createReferenceProvider(original(), list);
    const result = await provider.getSuggestions(["@s:SiGN"], 0, 7, options());
    expect(list).toHaveBeenCalledWith("current", expect.any(AbortSignal));
    expect(result?.items).toHaveLength(20);
    expect(result?.items[0]).toMatchObject({ value: "@s:24", label: "Design notes" });
    expect(result?.items[0]?.description).toContain("/project");
  });
  it("reserves empty results for automatic and forced queries, and refreshes lists", async () => {
    const current = original();
    const list = vi.fn(async () => [] as SessionInfo[]);
    const provider = createReferenceProvider(current, list);
    for (const force of [false, true]) {
      expect(await provider.getSuggestions(["@as:none"], 0, 8, { ...options(), force })).toEqual({
        items: [],
        prefix: "@as:none",
      });
    }
    expect(current.getSuggestions).not.toHaveBeenCalled();
    expect(provider.shouldTriggerFileCompletion?.(["@as:"], 0, 4)).toBe(true);
    list.mockResolvedValue([session("new")]);
    expect((await provider.getSuggestions(["@as:"], 0, 4, options()))?.items[0]?.value).toBe(
      "@as:new",
    );
    expect(list).toHaveBeenCalledWith("all", expect.any(AbortSignal));
  });
  it("allows Tab after paste or Escape while keeping empty session results out of file search", async () => {
    const current = original();
    current.shouldTriggerFileCompletion = vi.fn(() => false);
    const list = vi.fn(async () => [session("id")]);
    const provider = createReferenceProvider(current, list);
    for (const prefix of ["@s:", "@as:"]) {
      // Pasted text has no active completion menu; Tab must start a new request.
      expect((await pressTab(provider, prefix))?.items[0]?.value).toBe(`${prefix}id`);
      const controller = new AbortController();
      await provider.getSuggestions([prefix], 0, prefix.length, { signal: controller.signal });
      controller.abort(); // Escape dismisses the previous request/menu.
      expect((await pressTab(provider, prefix))?.items[0]?.value).toBe(`${prefix}id`);
      expect(await pressTab(provider, `${prefix}missing`)).toEqual({
        items: [],
        prefix: `${prefix}missing`,
      });
    }
    expect(current.shouldTriggerFileCompletion).not.toHaveBeenCalled();
    expect(await pressTab(provider, "@file")).toBeNull();
    expect(current.shouldTriggerFileCompletion).toHaveBeenCalledWith(["@file"], 0, 5);
    expect(current.getSuggestions).not.toHaveBeenCalled();
  });
  it("preserves the default Tab behavior when the wrapped provider has no optional gate", async () => {
    const current = original();
    delete current.shouldTriggerFileCompletion;
    const provider = createReferenceProvider(current, async () => [session("id")]);
    expect((await pressTab(provider, "@s:"))?.items[0]?.value).toBe("@s:id");
    expect(await pressTab(provider, "@as:missing")).toEqual({ items: [], prefix: "@as:missing" });
    expect(current.getSuggestions).not.toHaveBeenCalled();
    expect((await pressTab(provider, "@file"))?.items[0]?.value).toBe("file");
    expect(current.getSuggestions).toHaveBeenCalledWith(["@file"], 0, 5, {
      signal: expect.any(AbortSignal),
      force: true,
    });
  });
  it("delegates other inputs, item application and optional file trigger with receiver intact", async () => {
    const current = original();
    const provider = createReferenceProvider(current, async () => []);
    for (const input of ["/help", "@file", "@s: query", "x@s:query", "@as:query "]) {
      await provider.getSuggestions([input], 0, input.length, options());
      expect(provider.shouldTriggerFileCompletion?.([input], 0, input.length)).toBe(true);
    }
    expect(current.getSuggestions).toHaveBeenCalledTimes(5);
    const item = { value: "file", label: "file" };
    provider.applyCompletion(["@"], 0, 1, item, "@");
    expect(current.applyCompletion).toHaveBeenCalledWith(["@"], 0, 1, item, "@");
    delete current.shouldTriggerFileCompletion;
    expect(
      createReferenceProvider(current, async () => []).shouldTriggerFileCompletion,
    ).toBeUndefined();
  });
  it("inserts only the full ID at a middle cursor, retaining both sides and other lines", async () => {
    const provider = createReferenceProvider(original(), async () => [session("full-id")]);
    const lines = ["earlier", "before @s:Des after @as:other", "later"];
    const result = await provider.getSuggestions(lines, 1, 13, options());
    expect(result?.items).toHaveLength(1);
    const applied = provider.applyCompletion(lines, 1, 13, result!.items[0], result!.prefix);
    expect(applied).toEqual({
      lines: ["earlier", "before @s:full-id after @as:other", "later"],
      cursorLine: 1,
      cursorCol: 17,
    });
    expect(lines[1]).toBe("before @s:Des after @as:other");
  });
  it("replaces the whole reference token at a middle cursor and refuses cancelled selections", async () => {
    const provider = createReferenceProvider(original(), async () => [session("id")]);
    const lines = ["before @s:Design after"];
    const controller = new AbortController();
    const result = await provider.getSuggestions(lines, 0, 13, { signal: controller.signal });
    expect(provider.applyCompletion(lines, 0, 13, result!.items[0], result!.prefix).lines).toEqual([
      "before @s:id after",
    ]);
    controller.abort();
    expect(provider.applyCompletion(lines, 0, 13, result!.items[0], result!.prefix).lines).toEqual(
      lines,
    );
  });
  it("suppresses stale and cancelled results even when enumeration ignores abort", async () => {
    let finish!: (sessions: SessionInfo[]) => void;
    const list = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SessionInfo[]>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([session("new")]);
    const provider = createReferenceProvider(original(), list);
    const old = provider.getSuggestions(["@s:"], 0, 3, options());
    const latest = await provider.getSuggestions(["@as:"], 0, 4, options());
    finish([session("old")]);
    expect(await old).toBeNull();
    expect(latest?.items[0]?.value).toBe("@as:new");
    expect(list.mock.calls[0][1].aborted).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(await provider.getSuggestions(["@s:"], 0, 3, { signal: controller.signal })).toBeNull();
  });
});

describe("input reference expansion", () => {
  it("expands multiple scoped full IDs, with names and absolute paths including spaces", async () => {
    const list = vi.fn(async (scope: "current" | "all") => [
      session(scope === "all" ? "global-id" : "local-id"),
    ]);
    const text = "before @s:local-id\n@as:global-id after @s:local-id";
    const sentence = (id: string) =>
      `Read or search Design notes ${resolve(`sessions/${id} with spaces.jsonl`)} if more context is needed.`;
    expect(await expandReferences(text, list)).toBe(
      `before ${sentence("local-id")}\n${sentence("global-id")} after ${sentence("local-id")}`,
    );
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("keeps unknown IDs, partial IDs, names, unnamed sessions and invalid boundaries unchanged", async () => {
    const text = "@s:full @s:Design @s:missing @s:blank @s: full-id x@s:full-id";
    expect(
      await expandReferences(text, async () => [session("full-id"), session("blank", "")]),
    ).toBe(text);
  });
  it("does not enumerate ordinary input or cancelled transforms", async () => {
    const list = vi.fn(async () => []);
    expect(await expandReferences("plain text", list)).toBe("plain text");
    const controller = new AbortController();
    controller.abort();
    expect(await expandReferences("@s:id", list, controller.signal)).toBe("@s:id");
    expect(list).not.toHaveBeenCalled();
  });
});
