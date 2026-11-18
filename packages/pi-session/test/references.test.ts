import { resolve } from "node:path";
import type { AutocompleteProviderFactory, SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createReferenceProvider, expandReferences } from "../src/references.js";

type Provider = Parameters<AutocompleteProviderFactory>[0];
function session(id: string, name = "Design", cwd = "/project", modified = 0): SessionInfo {
  return {
    id,
    name,
    cwd,
    modified: new Date(modified),
    created: new Date(0),
    path: `/sessions/${id}`,
    firstMessage: "",
    allMessagesText: "",
    messageCount: 0,
  };
}
const options = () => ({ signal: new AbortController().signal });
function original(): Provider {
  return {
    getSuggestions: vi.fn(async (_lines, _line, col) => ({
      items: [
        { value: "file1", label: "file1" },
        { value: "file2", label: "file2" },
      ],
      prefix: `@${"x".repeat(col - 1)}`,
    })),
    applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
    shouldTriggerFileCompletion: vi.fn(() => false),
  };
}
const get = (p: Provider, input: string) => p.getSuggestions([input], 0, input.length, options());

describe("unified completion", () => {
  it("combines native files first with ranked global sessions and delegates file insertion", async () => {
    const native = original();
    const list = vi.fn(async () => [
      session("contains", "xdeploy", "/project", 9),
      session("remote", "deploy", "/else", 20),
      session("local", "Deploy", "/project", 1),
      session("prefix", "deploy notes"),
    ]);
    const p = createReferenceProvider(native, list, "/project");
    const result = await get(p, "@deploy");
    expect(result?.items.map((i) => i.label)).toEqual([
      "file1",
      "file2",
      "[session]Deploy",
      "[session else]deploy",
      "[session]deploy notes",
      "[session]xdeploy",
    ]);
    expect(result?.items[3].description).toContain("/else");
    expect(list).toHaveBeenCalledWith("all", expect.any(AbortSignal));
    p.applyCompletion(["@deploy"], 0, 7, result!.items[0], result!.prefix);
    expect(native.applyCompletion).toHaveBeenCalledWith(
      ["@deploy"],
      0,
      7,
      result!.items[0],
      "@xxxxxx",
    );
    expect(p.shouldTriggerFileCompletion?.(["@deploy"], 0, 7)).toBe(true);
    expect(p.shouldTriggerFileCompletion?.(["/help"], 0, 5)).toBe(false);
  });
  it("limits both lists, finds old sessions, and caches until leaving or selecting", async () => {
    const native = original();
    native.getSuggestions = vi.fn(async () => ({
      items: Array.from({ length: 25 }, (_, i) => ({ value: `${i}`, label: `${i}` })),
      prefix: "@",
    }));
    const list = vi.fn(async () => [
      session("old", "needle"),
      ...Array.from({ length: 25 }, (_, i) => session(`${i}`, "other", "/else", i + 1)),
    ]);
    const p = createReferenceProvider(native, list, "/project");
    const bare = await get(p, "@");
    expect(bare?.items).toHaveLength(40);
    expect(bare?.items[20].value).toContain("(24)");
    expect((await get(p, "@needle"))?.items.at(-1)?.value).toContain("(old)");
    expect(list).toHaveBeenCalledTimes(1);
    await get(p, "plain");
    await get(p, "@");
    expect(list).toHaveBeenCalledTimes(2);
    p.applyCompletion(["@"], 0, 1, bare!.items[20], "@");
  });
  it("uses summary and Untitled, escapes titles, replaces only token, refreshes on selection", async () => {
    const list = vi.fn(async () => [
      { ...session("id", ""), firstMessage: "A] \\ B\nline" },
      session("blank", ""),
    ]);
    const p = createReferenceProvider(original(), list, "/project");
    const result = await get(p, "@a]");
    const item = result!.items.at(-1)!;
    expect(item.value).toBe("@session[A\\] \\\\ B line](id)");
    expect(p.applyCompletion(["@a] rest"], 0, 3, item, "@a]").lines).toEqual([
      `${item.value} rest`,
    ]);
    expect((await get(p, "@untitled"))?.items.at(-1)?.label).toBe("[session]Untitled");
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("matches full labels after title ranks, including session and external project names", async () => {
    const native = original();
    const list = async () => [
      session("label", "Other", "/session-project", 50),
      session("contains", "Xsession", "/project", 3),
      session("prefix", "session notes", "/project", 2),
      session("exact", "SESSION", "/project", 1),
    ];
    const p = createReferenceProvider(native, list, "/project");
    const result = await get(p, "@session");
    expect(result?.items.map((item) => item.label)).toEqual([
      "file1",
      "file2",
      "[session]SESSION",
      "[session]session notes",
      "[session]Xsession",
      "[session session-project]Other",
    ]);
    expect((await get(p, "@PROJECT"))?.items.at(-1)?.label).toBe("[session session-project]Other");
    expect((await get(p, "@[session]ses"))?.items.map((item) => item.label)).toContain(
      "[session]SESSION",
    );
  });
  it("searches the full index and full titles but limits displayed and inserted title to 80 Unicode characters", async () => {
    const full = `${"😀".repeat(77)}]\\xyz hiddenkeyword`;
    const list = async () => [
      session("old-full-id", full, "/other", 0),
      ...Array.from({ length: 25 }, (_, i) => session(`${i}`, "other", "/project", i + 1)),
    ];
    const p = createReferenceProvider(original(), list, "/project");
    expect((await get(p, "@"))?.items.some((item) => item.value.includes("old-full-id"))).toBe(
      false,
    );
    const result = await get(p, "@hiddenkeyword");
    const item = result!.items.at(-1)!;
    const shown = `${"😀".repeat(77)}]\\…`;
    expect(Array.from(shown)).toHaveLength(80);
    expect(item.label).toBe(`[session other]${shown}`);
    expect(item.value).toBe(`@session[${"😀".repeat(77)}\\]\\\\…](old-full-id)`);
    expect(p.applyCompletion(["@hiddenkeyword"], 0, 14, item, "@hiddenkeyword").lines).toEqual([
      item.value,
    ]);
    const exact80 = "😀".repeat(80);
    const second = createReferenceProvider(
      original(),
      async () => [session("80", exact80)],
      "/project",
    );
    expect((await get(second, "@"))?.items.at(-1)?.label).toBe(`[session]${exact80}`);
  });
  it("retains native results when discovery fails and retries on the next request", async () => {
    const native = original();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue([session("id")]);
    const p = createReferenceProvider(native, list, "/project");
    const result = await get(p, "@design");
    expect(result?.items.map((item) => item.value)).toEqual(["file1", "file2"]);
    p.applyCompletion(["@design"], 0, 7, result!.items[0], result!.prefix);
    expect(native.applyCompletion).toHaveBeenCalledOnce();
    expect((await get(p, "@design"))?.items.at(-1)?.value).toContain("(id)");
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("preserves non-whitespace suffix following the cursor", async () => {
    const p = createReferenceProvider(original(), async () => [session("id")], "/project");
    const result = await get(p, "@des");
    const item = result!.items.at(-1)!;
    expect(p.applyCompletion(["@des,suffix"], 0, 4, item, "@des").lines).toEqual([
      `${item.value},suffix`,
    ]);
  });
  it("suppresses stale asynchronous results and delegates non-@", async () => {
    let finish!: (s: SessionInfo[]) => void;
    const list = vi.fn(
      () =>
        new Promise<SessionInfo[]>((r) => {
          finish = r;
        }),
    );
    const p = createReferenceProvider(original(), list, "/project");
    const old = get(p, "@");
    const latest = get(p, "@design");
    finish([session("id")]);
    expect(await old).toBeNull();
    expect((await latest)?.items.at(-1)?.value).toContain("(id)");
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("reference expansion", () => {
  it("uses full ID, current name or summary, and leaves old and unknown references unchanged", async () => {
    const text =
      "before @session[old\\] title](id) @session[anything](other) @session[x](missing) @s:id";
    const list = vi.fn(async () => [
      session("id", "Renamed"),
      { ...session("other", ""), firstMessage: "Summary" },
    ]);
    expect(await expandReferences(text, list)).toBe(
      `before Read or search Renamed ${resolve("/sessions/id")} if more context is needed. Read or search Summary ${resolve("/sessions/other")} if more context is needed. @session[x](missing) @s:id`,
    );
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("warns and preserves only ambiguous IDs", async () => {
    const warn = vi.fn();
    const text = "@session[x](same) @session[y](ok)";
    const result = await expandReferences(
      text,
      async () => [session("same"), { ...session("same"), path: "/different" }, session("ok")],
      undefined,
      warn,
    );
    expect(result).toContain("@session[x](same) Read or search Design");
    expect(warn).toHaveBeenCalledOnce();
  });
});
