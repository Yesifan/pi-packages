# pi-session

Pi terminal extension for session references, history search and lightweight background conversations. Requires Node.js 22.19+ and Pi 1.1.0+; development baseline: Pi 1.4.0.

## Install

```bash
pi install npm:@yesifan/pi-session
# From this repository:
pi install -l ./packages/pi-session
```

Reload extensions or start a new Pi session. The completion UI and tools are installed only in terminal (TUI) mode, not RPC, JSON or print mode.

## Reference a session

Type `@` to see native file candidates followed by recent sessions in the current project and authorized external projects. Type a keyword to search session titles as well as files. Current-project sessions appear as `[session]title`; external sessions appear as `[session project-name]title`, using the directory name. Candidates also provide cwd, activity time and ID. A session without a custom title uses its first-message summary, or `Untitled` if none is available.

Matching ignores case and searches full session titles and displayed labels, including `session` and external project names. Exact, prefix, then substring title matches rank ahead of label-only matches. Within a match category, current-project sessions come first, then the most recently updated. Displayed and inserted titles are limited to 80 Unicode characters including a trailing `…` when truncated; the complete title remains searchable and the full ID is preserved. Bare `@` shows the 20 most recently updated sessions in scope; a keyword searches all sessions in scope before selecting up to 20. File candidates are separately limited to 20 and retain native search, order and insertion behavior. A continuous completion reuses its session index; selection, leaving the `@` context or moving to a different reference refreshes it on the next query. Pi does not notify extensions when the menu is dismissed, so reopening it at the same position after Escape may reuse stale results.

Selecting a session inserts **`@session[title](full-ID)`** into the editor. A `]` or backslash in the title is backslash-escaped, and newlines are replaced with spaces. Selection does not send anything. You can edit/delete it or add more text and references. On submission, each valid reference is resolved by full ID and transformed into:

```text
Read or search <session name> <absolute path> if more context is needed.
```

The model and persisted user message receive this sentence, not the ID token. After reopening the session, recalled input history therefore contains the expanded sentence. Unknown IDs remain unchanged; duplicate IDs among SDK-returned sessions and enumeration errors reported by the SDK leave affected input unchanged with a warning. The SDK can silently skip unreadable directories or session files, so discovery may be incomplete and duplicate IDs in skipped sessions cannot be detected. No referenced conversation body is automatically injected. The old `@s:` and `@as:` reference formats are no longer expanded; they are ordinary text.

## Authorize another cwd

Both tools default to the caller's cwd when `cwd` is omitted or empty. Session completion and reference resolution also use the current cwd and authorized external directories. To allow another directory, create **`<caller-cwd>/.pi/pi-session/setting.json`**:

```json
{
  "externalDirectories": ["/absolute/path/to/other-project"]
}
```

Paths are canonicalized with realpath and must match exactly: authorizing a directory does **not** authorize its children. Configuration paths can use `~` or `$HOME`; tool arguments must be absolute paths. Configuration is read on each external-cwd call and when the session completion index is refreshed. If a configured directory is invalid or unavailable, session discovery fails closed: file completion still works, but references remain unchanged with a warning until the configuration is fixed.

This is a cwd admission rule, **not a filesystem sandbox**. Session completion and reference resolution are limited to these authorized directories.

## Tools

### `search-session`

Parameters: `query` (required, nonblank), `cwd` (optional).

Searches SDK-provided user/assistant aggregate text using a case-insensitive substring. Returns session name (if present), full ID, cwd, absolute file path, activity time and matching newline-delimited text segments. No line numbers or message boundaries are promised: the SDK joins separate messages with spaces and preserves internal newlines. Tool output and thinking are not included in this search.

Results are ordered by recent activity, limited to 20 sessions, 5 matching segments per session and 2,000 characters per segment. `truncated` flags identify omitted content. Read the session file when more context is needed. No independent index or custom JSONL parser is maintained.

### `ask-session`

Parameters: `id` (required **full session ID**), `prompt` (required, nonblank), `cwd` (optional), `steer` (optional boolean).

Looks up the ID only in the selected authorized cwd. Names, partial IDs and paths are not accepted as target identifiers. The caller's own session is rejected.

An ordinary ask returns acceptance immediately, then continues the **original session**, writing the question, answer and normal execution records there. It does not fork or switch the caller's editor. It uses the target cwd's default SDK environment, stored model/history and default active branch; caller-specific overrides are not copied. This is SDK-default loading, not a promise to reproduce all CLI-only built-ins such as codemode/MCP.

Completion or failure is automatically reported to the caller. Do not poll or repeat accepted work: give a brief progress update and end the turn while awaiting reports. Ask again after completion for a follow-up.

While an ID is active in this extension, ordinary ask returns busy. `steer: true` adjusts that execution through the SDK and does not produce a separate completion report. Missing, still-loading or non-streaming tasks cannot be steered.

**No external-instance occupancy checks or locks are performed.** Concurrently opening the same session in another terminal can produce divergent branches and stale context; this risk is accepted, not prevented. Steer cannot control another terminal's execution.

Only active tasks are kept in memory; completed instances are disposed. Switching the caller session, reloading or exiting closes its tasks and suppresses late reports. There is no restart recovery, persistent queue or replay. Once accepted, a task is independent of the initiating tool call's cancellation; shutting down its caller lifecycle closes it.

## Development

```bash
pnpm --filter @yesifan/pi-session typecheck
pnpm --filter @yesifan/pi-session test
pnpm --filter @yesifan/pi-session lint
pnpm --filter @yesifan/pi-session pack --pack-destination /tmp
```

Tests use temporary SDK storage and model/runtime substitutes, not real user sessions or paid model calls. TypeScript source is published directly; no build step is required.
