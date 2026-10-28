# Changelog

## 0.6.1

### Patch Changes

- c12b055: Report accepted subagent cancellations and interruptions once to the original live caller, exclude commentary from final results, preserve nested processing barriers, and diagnose delivery failures or shutdown suppression without promising cross-restart delivery.
- e52a900: Replace runtime non-null assertions with explicit lifecycle invariant checks and retain the mounted session during prompt completion.

## 0.6.0

### Minor Changes

- c2de661: BREAKING: Subagent creation and ordinary asks return submitted after local persistence and SDK submission, rather than a synchronous started handshake. Steering uses public steer with skill/template expansion and extension-command rejection; queued does not guarantee consumption or cancellation rollback. Agents remain busy through outstanding calls and cleanup. History restoration follows SDK defaults/fallback instead of requiring an exact historical model/thinking selection.

  During root shutdown, abort captured sessions again if an ordinary prompt resumes from an input hook and starts a run; retain the writer lock until pending calls and cleanup finish.

  Use Pi 1.4.0 official session services and lifecycle APIs while retaining history identity, ownership, trust, and role tool policies. Upgrade the daemon's embedded Pi runtime to 1.4.0 and use public UI types without changing Weixin routing or delivery behavior.

### Patch Changes

- 9ed9768: Allow multiple windows on the same root to share subagents across idle handoffs. Acquire the whole-tree lock only for execution, refresh saved state on acquisition, and release after all work, reports, and cleanup finish. Cross-window contention rejects only the current request; no IPC or automatic task forwarding is introduced.

## 0.5.2

### Patch Changes

- 073f6d3: Load SDK Codemode, tool search, and MCP built-ins in child sessions, honoring target configuration, disable selectors, third-party replacements, and role tool policies. Pass tool selections directly to the SDK without rejecting unknown or not-yet-discovered tool names during child creation.

## 0.5.1

### Patch Changes

- dbf7bdb: Add repository metadata required for npm provenance verification during publishing.

## 0.5.0

### Minor Changes

- 9b13a02: Upgrade the workspace Pi SDK baseline from 1.0.0 to 1.1.0.

  BREAKING: Require Node.js 22.19.0 or newer consistently across the workspace, including pi-system-prompt. Pi 1.1.0 renames the Azure provider from `azure-openai-responses` to `azure`; users of that provider must update their authentication and model/settings configuration. Existing subagent histories using the old provider can fail to resume rather than silently fall back.

  ### Azure configuration migration

  Before starting Pi or restarting pi-weixin-daemon:

  1. Back up the affected Pi configuration files. In the active agent directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`), rename the provider key `azure-openai-responses` to `azure` in `auth.json`, or run `/login` in Pi again for Azure.
  2. Rename the provider key in `models.json`. In user and project `settings.json` files, update `defaultProvider`, provider prefixes in `enabledModels` patterns, and provider prefixes in `modelThinkingLevels` keys from `azure-openai-responses` to `azure` where present.
  3. Keep existing `AZURE_OPENAI_*` environment variables unchanged; the provider rename does not require renaming them.
  4. Restart Pi and pi-weixin-daemon after updating configuration, then verify the selected provider/model before sending a prompt.

  Old Azure sessions may fall back to another model when resumed, and their prompt cache is not reused. pi-subagents rejects an unavailable historical model or SDK fallback, so updating configuration alone does not guarantee old Azure child histories can be asked again. This upgrade does not rewrite or migrate persisted session histories. Start new sessions/subagents using the `azure` provider when necessary.

  BREAKING: The upgraded SDK changes tool filtering: non-empty allowlists without a tool name starting with `mcp__` can retain MCP tools, and `*` in excluded tool names is interpreted as a wildcard. Role tool selection intentionally follows these SDK defaults. MCP tools must already be connected and registered in the target session; enabling codemode does not itself connect MCP servers. An empty allowlist excludes every tool, while explicitly including a name starting with `mcp__` filters the MCP tool set. Naming only a resource helper such as `list_mcp_resources` does not trigger this filtering. Exclusions take precedence, including across dynamic registration. The package still checks allowlist entries for exact-name availability before creating the session and does not promise wildcard allowlists.

## 0.4.0

### Minor Changes

- c643500: **BREAKING:** Address subagents by their exact parent-local names instead of generated agent/run IDs. Store minimal direct-child metadata per parent session in the global agent directory, with new native Pi child conversation histories in the private `<getAgentDir()>/subagents/histories` directory, outside default discovery/picker/continue. Explicit file opening and custom-directory discovery remain allowed; existing Spec 0002 histories are left at their saved paths and remain recoverable without relocation or migration. Replace business run/mount/report identities and root epochs with in-memory execution/scope ownership and online report-processing barriers. Restore saved roles and historical model/thinking without parent overrides; unfinished tasks become interrupted and old reports are not replayed. Old project-local and legacy subagent stores are not migrated or loaded, and their agents cannot be asked after upgrading; old files are left untouched. Reports include saved roles and validated complete-conversation paths.

## 0.3.1

### Patch Changes

- List every direct subagent in status snapshots and reports without omitting entries. Improve report formatting and follow-up guidance, shorten tool-result instructions, and recommend reusing an idle subagent for related work.
- 9bbd900: Add mutually exclusive `disallowedTools` role denylists that filter built-in and extension tools, including dynamic re-registration, while preserving saved role policies across asks and recovery. Change the built-in `explore` role to exclude `edit`, `write`, and `bash` instead of allowlisting only built-in search tools; available extension tools remain usable, so this is not a strict read-only guarantee.

## 0.3.0

### Minor Changes

- a0111da: **BREAKING:** `thinking` now accepts only `off`, `low`, `medium`, `high`, and `max`, both as the `subagent` tool parameter and in `agents/*.md` frontmatter. `minimal` and `xhigh` are rejected with `INVALID_AGENT_DEFINITION` for agent files. Stored role snapshots and inherited parent thinking levels are unchanged, so existing subagent history keeps working.

### Patch Changes

- 4235c5b: Show running, completed, and interrupted direct subagents in Markdown status lists, and remind the parent in every report that it can reuse the reporting subagent with `ask_subagent` for related follow-up work. Preserve an earlier interrupted status when an unaccepted follow-up run is discarded. Tool results also explain how to steer an active run with `ask_subagent` to adjust its direction or add context.

All notable changes to this package are documented here. The format follows Keep a Changelog.

## [0.2.5] - 2026-09-28

### Changed

- Renamed the npm package from `@BYKWP/pi-subagents` to `@yesifan/pi-subagents`; install using the new name.
- Automatic subagent reports now use the `subagent-report` custom message type instead of `bykwp-subagent-report`.

## [0.2.4] - 2026-09-26

### Fixed

- Keep child `ctx.ui` methods available to extensions after Pi SDK wraps the UI proxy, preventing `session_start` failures such as `ctx.ui.onTerminalInput is not a function`.

### Changed

- Align Pi SDK development dependencies with the workspace catalog (0.87.1).

## [0.2.3] - 2026-09-14

### Added

- Model-visible snapshots of active direct subagents and shared live usage in successful delegation results, busy/limit errors, and automatic reports.

### Changed

- Clarified asynchronous parallel delegation, non-overlapping task ownership, automatic reporting, and interim-only responses while relevant reports remain pending.
- Kept tool descriptions fixed during execution while deriving their configured live-agent limit when each session registers its tools.
- Removed run IDs from model-visible startup and report text while retaining them in structured details and persistent records.

### Fixed

- Corrected the explicit `cwd` parameter description and replaced the incomplete normal-ask and steering result guidance.
- Prevented a tool abort observed after Pi's successful preflight from rolling back an accepted start or reporting accepted steering as failed.

## [0.2.2] - 2026-09-14

### Fixed

- Atomically reserve idle subagents and the shared live-agent budget before asynchronous normal-ask initialization, preventing concurrent `ask_subagent` calls from accepting duplicate or over-limit runs.

## [0.2.1] - 2026-09-11

### Added

- A root-owned native Pi widget showing the latest activity and current-run model call count for each active subagent.

## [0.2.0] - 2026-09-11

### Changed

- **BREAKING:** Moved configuration to `<projectRoot>/.pi/subagents/setting.json`; the former global and project extension config paths are no longer read.
- **BREAKING:** Moved the authoritative root store to `<rootProject>/.pi/subagents/sessions/<rootKey>/` without migrating or falling back to legacy agent-dir data.
- Stored child history as a root-scope-relative path and validate its agent ownership, file identity, and containment before resume.

### Added

- Trust-gated project storage initialization with a local `/sessions/` Git ignore rule.
- Fail-closed checks for tracked or unignored session data, unsafe symlinks, path escapes, missing runtime scopes, and root identity mismatches.
- Private `0600` child Pi session creation and project-local storage requirements/ADR documentation.

## [0.1.0] - 2026-09-11

### Added

- Background `subagent` and persistent `ask_subagent` tools.
- Session-local agent registries and exact external cwd authorization.
- Agent definition snapshots, nested delegation, cycle/depth/live limits, automatic reports, and steering.
- File-backed logical metadata, child Pi session history, and root writer locking.
- Shared FIFO proxy for supported Pi UI capabilities.
- Domain model documentation covering identities, ownership, run semantics, lifecycle, and persistence.
