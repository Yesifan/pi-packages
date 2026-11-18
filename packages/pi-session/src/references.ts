import { basename, resolve } from "node:path";
import type { AutocompleteProviderFactory, SessionInfo } from "@earendil-works/pi-coding-agent";

type AutocompleteProvider = Parameters<AutocompleteProviderFactory>[0];
type Item = Parameters<AutocompleteProvider["applyCompletion"]>[3];
export type SessionList = (scope: "current" | "all", signal: AbortSignal) => Promise<SessionInfo[]>;

function referenceAt(lines: string[], line: number, col: number) {
  const match = /(?:^|\s)(@[^\s]*)$/.exec(lines[line].slice(0, col));
  return match
    ? { prefix: match[1], query: match[1].slice(1), start: col - match[1].length }
    : null;
}

function title(session: SessionInfo): string {
  const summary = session.firstMessage === "(no messages)" ? "" : session.firstMessage?.trim();
  return (session.name?.trim() || summary || "Untitled").replace(/\r\n|\r|\n/g, " ");
}

export function createReferenceProvider(
  current: AutocompleteProvider,
  list: SessionList,
  cwd: string,
): AutocompleteProvider {
  let pending: AbortController | undefined;
  let cache:
    | { line: number; start: number; promise: Promise<SessionInfo[]>; controller: AbortController }
    | undefined;
  const ownItems = new WeakMap<Item, AbortSignal>();
  const reset = () => {
    cache?.controller.abort();
    cache = undefined;
  };
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const reference = referenceAt(lines, cursorLine, cursorCol);
      if (!reference) {
        reset();
        return current.getSuggestions(lines, cursorLine, cursorCol, { ...options, signal });
      }
      if (signal.aborted) return null;
      if (cache && (cache.line !== cursorLine || cache.start !== reference.start)) reset();
      if (!cache) {
        const indexController = new AbortController();
        const promise = list("all", indexController.signal);
        cache = { line: cursorLine, start: reference.start, promise, controller: indexController };
        promise.catch(() => {
          if (cache?.promise === promise) reset();
        });
      }
      const [files, sessions] = await Promise.all([
        current.getSuggestions(lines, cursorLine, cursorCol, { ...options, signal }),
        cache.promise.catch(() => [] as SessionInfo[]),
      ]);
      if (signal.aborted) return null;
      const query = reference.query.toLowerCase();
      const labelPrefix = (s: SessionInfo) =>
        s.cwd === cwd ? "[session]" : `[session ${basename(s.cwd)}]`;
      const displayTitle = (s: SessionInfo) => {
        const characters = Array.from(title(s));
        return characters.length > 80
          ? `${characters.slice(0, 79).join("")}…`
          : characters.join("");
      };
      const rank = (s: SessionInfo) => {
        const value = title(s).toLowerCase();
        if (value === query) return 0;
        if (value.startsWith(query)) return 1;
        if (value.includes(query)) return 2;
        const prefix = labelPrefix(s).toLowerCase();
        return (prefix + value).includes(query) ||
          (prefix + displayTitle(s).toLowerCase()).includes(query)
          ? 3
          : 4;
      };
      const items = sessions
        .filter((s) => rank(s) < 4)
        .sort(
          (a, b) =>
            (query ? rank(a) - rank(b) || Number(b.cwd === cwd) - Number(a.cwd === cwd) : 0) ||
            b.modified.getTime() - a.modified.getTime(),
        )
        .slice(0, 20)
        .map((s) => {
          const name = displayTitle(s);
          const escaped = name.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
          const item = {
            value: `@session[${escaped}](${s.id})`,
            label: `${labelPrefix(s)}${name}`,
            description: `${s.cwd} · ${s.modified.toISOString()} · ${s.id}`,
          };
          ownItems.set(item, signal);
          return item;
        });
      // A wrapper may return a different prefix; retain it for its own items.
      const fileItems = files?.items.slice(0, 20) ?? [];
      if (files) for (const item of fileItems) filePrefixes.set(item, files.prefix);
      if (!fileItems.length && !items.length) {
        reset();
        return null;
      }
      return { items: [...fileItems, ...items], prefix: reference.prefix };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!ownItems.has(item)) {
        reset();
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          filePrefixes.get(item) ?? prefix,
        );
      }
      if (
        ownItems.get(item)?.aborted ||
        referenceAt(lines, cursorLine, cursorCol)?.prefix !== prefix
      )
        return { lines, cursorLine, cursorCol };
      reset();
      const start = cursorCol - prefix.length;
      const updated = [...lines];
      updated[cursorLine] =
        lines[cursorLine].slice(0, start) + item.value + lines[cursorLine].slice(cursorCol);
      return { lines: updated, cursorLine, cursorCol: start + item.value.length };
    },
    ...(current.shouldTriggerFileCompletion
      ? {
          shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
            return referenceAt(lines, line, col)
              ? true
              : (current.shouldTriggerFileCompletion?.(lines, line, col) ?? false);
          },
        }
      : {}),
  };
}
const filePrefixes = new WeakMap<Item, string>();

export async function expandReferences(
  text: string,
  list: SessionList,
  signal: AbortSignal = new AbortController().signal,
  warn?: (message: string) => void,
): Promise<string> {
  const pattern = /@session\[((?:\\[\\\]]|[^\\\]\r\n])*)\]\(([^()\s]+)\)/g;
  if (!pattern.test(text) || signal.aborted) return text;
  pattern.lastIndex = 0;
  const sessions = await list("all", signal);
  if (signal.aborted) return text;
  return text.replace(pattern, (original, _title: string, id: string) => {
    const matches = sessions.filter((s) => s.id === id);
    if (new Set(matches.map((s) => resolve(s.path))).size > 1) {
      warn?.(`Session reference left unchanged: duplicate ID ${id}`);
      return original;
    }
    const session = matches[0];
    return session
      ? `Read or search ${title(session)} ${resolve(session.path)} if more context is needed.`
      : original;
  });
}
