import { resolve } from "node:path";
import type { AutocompleteProviderFactory, SessionInfo } from "@earendil-works/pi-coding-agent";

type AutocompleteProvider = Parameters<AutocompleteProviderFactory>[0];
type Item = Parameters<AutocompleteProvider["applyCompletion"]>[3];
export type SessionList = (scope: "current" | "all", signal: AbortSignal) => Promise<SessionInfo[]>;

function referenceAt(lines: string[], line: number, col: number) {
  const match = /(?:^|\s)(@(as|s):([^\s]*))$/.exec(lines[line].slice(0, col));
  return match
    ? {
        prefix: match[1],
        query: match[3],
        scope: match[2] === "as" ? ("all" as const) : ("current" as const),
      }
    : null;
}

export function createReferenceProvider(
  current: AutocompleteProvider,
  list: SessionList,
): AutocompleteProvider {
  let pending: AbortController | undefined;
  const ownItems = new WeakMap<Item, AbortSignal>();
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const reference = referenceAt(lines, cursorLine, cursorCol);
      if (signal.aborted) return null;
      try {
        if (!reference) {
          const result = await current.getSuggestions(lines, cursorLine, cursorCol, {
            ...options,
            signal,
          });
          return signal.aborted ? null : result;
        }
        const sessions = await list(reference.scope, signal);
        if (signal.aborted) return null;
        const items = sessions
          .filter(
            (session) =>
              session.name?.trim() &&
              session.name.toLowerCase().includes(reference.query.toLowerCase()),
          )
          .sort((a, b) => b.modified.getTime() - a.modified.getTime())
          .slice(0, 20)
          .map((session) => {
            const item = {
              value: `${reference.scope === "all" ? "@as:" : "@s:"}${session.id}`,
              label: session.name as string,
              description: `${session.cwd} · ${session.modified.toISOString()} · ${session.id}`,
            };
            ownItems.set(item, signal);
            return item;
          });
        return { items, prefix: reference.prefix };
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!ownItems.has(item)) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      if (
        ownItems.get(item)?.aborted ||
        referenceAt(lines, cursorLine, cursorCol)?.prefix !== prefix
      ) {
        return { lines, cursorLine, cursorCol };
      }
      const start = cursorCol - prefix.length;
      const end = cursorCol + (lines[cursorLine].slice(cursorCol).match(/^\S*/)?.[0].length ?? 0);
      const updated = [...lines];
      updated[cursorLine] =
        lines[cursorLine].slice(0, start) + item.value + lines[cursorLine].slice(end);
      return { lines: updated, cursorLine, cursorCol: start + item.value.length };
    },
    ...(current.shouldTriggerFileCompletion
      ? {
          shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
            // This gates all forced Tab requests, not just built-in file search.
            return referenceAt(lines, line, col)
              ? true
              : (current.shouldTriggerFileCompletion?.(lines, line, col) ?? false);
          },
        }
      : {}),
  };
}

export async function expandReferences(
  text: string,
  list: SessionList,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const pattern = /(^|\s)@(as|s):([^\s]+)/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0 || signal.aborted) return text;
  const scopes = new Set(
    matches.map((match) => (match[2] === "as" ? ("all" as const) : ("current" as const))),
  );
  const sessions = new Map(
    await Promise.all(
      [...scopes].map(async (scope) => [scope, await list(scope, signal)] as const),
    ),
  );
  if (signal.aborted) return text;
  return text.replace(pattern, (original, space: string, scope: string, id: string) => {
    const session = sessions
      .get(scope === "as" ? "all" : "current")
      ?.find((session) => session.id === id);
    return session?.name?.trim()
      ? `${space}Read or search ${session.name} ${resolve(session.path)} if more context is needed.`
      : original;
  });
}
