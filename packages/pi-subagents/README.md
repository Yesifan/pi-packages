# @yesifan/pi-subagents

Persistent, in-process background subagents for [Pi](https://pi.dev).

## Install

```bash
pi install npm:@yesifan/pi-subagents
# local checkout
pi install -l ./packages/pi-subagents
```

Restart Pi or run `/reload` after installation.

## Tools

### `subagent`

Submits a background logical subagent and returns `status: "submitted"` once local preparation is persisted and `session.prompt()` has been called with background completion handling attached. This does not guarantee that the SDK has started a run or called a model. Independent `subagent` calls emitted in the same assistant turn run in parallel, subject to the root project's shared `max_live_agents` limit.

```json
{
  "name": "reviewer",
  "prompt": "Review the authentication flow and report concrete findings.",
  "agent_type": "general",
  "thinking": "medium",
  "cwd": "/absolute/path/to/project"
}
```

`thinking` is optional and accepts `off`, `low`, `medium`, `high`, or `max`. Omitted values fall back to the agent definition, then the parent's current thinking level. Agent definition frontmatter accepts the same five levels.

`cwd` is optional and defaults to the caller's current cwd. An explicit value must be an absolute path that resolves exactly to the current cwd or one configured external cwd. Relative paths, `~`, `$HOME`, and `${HOME}` are rejected in tool input.

Names are trimmed, case-sensitive, and unique among one parent's direct children. Completed and interrupted children retain their names; duplicate creation returns `SUBAGENT_NAME_EXISTS` and suggests `ask_subagent`. Different parents may reuse the same name. Display labels may be shortened, but structured results preserve the full name for exact asks. Names never become file paths.

### `ask_subagent`

Starts another run on a directly owned idle logical subagent. Prefer reusing one for related follow-up work; create a new subagent when independent context or parallel work is needed:

```json
{ "name": "reviewer", "prompt": "Now check the tests." }
```

The subagent remains busy until captured prompt/steer calls and session cleanup finish, even if model streaming has ended. A normal ask against a busy subagent immediately returns `SUBAGENT_BUSY`; requests are not queued. `ask_subagent` is not a status or result-polling tool.

To steer an actively streaming run without creating a new run:

```json
{ "name": "reviewer", "prompt": "Focus on the authorization boundary.", "isSteer": true }
```

Steering can adjust the direction of an actively streaming run or add new context. Both `subagent` and `ask_subagent` tool results remind the caller of this option. Public `session.steer()` returns `queued` or `handled`: `status: "steered"` means queued, not guaranteed consumption. Input hooks may outlive the original run; no new run is started to consume late steering. Handled input does not enqueue steering or abort the original task. Skills and prompt templates expand according to the SDK, and extension commands are rejected. Cancellation before the call prevents submission; cancellation during a hook cannot guarantee zero enqueueing, and already queued input cannot be retracted. It does not create a separate report. Idle, released, finalizing, or waiting-for-children agents are not steerable.

See [the delegation examples](examples/delegation.md) for parallel tasks, exact-name follow-ups, and active steering.

## Agent types

Each session with delegation tools builds its own registry in this order:

1. package built-ins (`general`, `explore`);
2. `<getAgentDir()>/agents/*.md`;
3. the current session project's `.pi/agents/*.md`.

A later same-name file fully replaces the earlier definition. The caller selects the child role from the caller's registry; the selected definition is snapshotted for future asks. An external child uses its own cwd registry only when creating further descendants.

```md
---
name: security-review
description: Review authentication and trust boundaries
tools: [read, grep, find, ls]
thinking: high
---

Report concrete evidence and file locations. Do not modify files.
```

Roles accept either `tools` (SDK tool selection) or `disallowedTools` (exclusion patterns), never both—even when one is empty. Both are arrays of non-empty strings; duplicate entries are removed. `tools: []` allows no tools, while `disallowedTools: []` adds no restrictions. Omitting both preserves the normal target session's tools.

Tool policy follows Pi SDK 1.4.0 semantics:

- A non-empty `tools` list selects built-in and extension tools, but **is not a strict allowlist across all tools**: if it contains no tool names starting with `mcp__`, already registered MCP tools remain available. Including a name starting with `mcp__` filters MCP tools to those selections; naming only a resource helper such as `list_mcp_resources` does not trigger this filtering; `tools: []` excludes all tools, including MCP.
- `tools` selections are passed directly to the SDK, including its supported patterns. This package does not prevalidate tool existence: unknown or misspelled selections match no tools instead of failing child creation with `TOOL_UNAVAILABLE`. Explicit MCP selections can match tools registered later; actual calls to unavailable tools still fail through the SDK. Check role spelling when expected tools are missing.
- `disallowedTools` is passed to SDK `excludeTools`, where `*` is a wildcard (for example, `mcp_*`). Unknown exclusions are harmless and also apply to matching tools registered later. Exclusions take precedence over tool selections.
- MCP tools must actually be registered in the target session. Enabling codemode alone does not connect MCP services or register their tools.

For example, to keep discovered extension tools while excluding selected tools:

```md
---
name: researcher
description: Explore using available search tools
disallowedTools: [edit, write, bash, destructive_custom_tool]
---

Explore without modifying files. Report evidence and file locations.
```

The built-in `explore` uses `disallowedTools: [edit, write, bash]`, preserving its exploration prompt and other available built-in/extension tools. This does **not guarantee strict read-only execution**: other tools (including `powershell`, if enabled), extension code, and further delegation may have side effects. Use explicit `tools` selections of trusted tools when tighter selection is needed, accounting for the MCP retention rule above; neither policy is a filesystem sandbox.

Policies apply to the SDK registry, not only the initial active tools. Dynamic extension registration/re-registration and `setActiveTools()` cannot re-enable tools matched by exclusions. Runtime delegation restrictions still apply: same-cwd and depth-limited children exclude `subagent`/`ask_subagent`; denylisting `subagent` disables descendant delegation, while denylisting only `ask_subagent` leaves creation available.

The selected policy is included in the saved role snapshot and content hash. Later role file changes affect newly created logical subagents only, not subsequent asks or root recovery.

## Codemode and MCP

Children load the SDK 1.4.0 built-in `codemode`, `tool_search`, and `mcp` extensions using their own target cwd, agentDir, and settings. No adapter or duplicate MCP configuration is needed. Parent tool instances, connections, and temporary CLI overrides are not copied.

Loading does not unconditionally activate tools. For codemode without MCP, set `"defaultTools": ["+codemode"]` in Pi settings. Enabled MCP servers can activate codemode or tool search according to SDK configuration. MCP configuration is read from `<agentDir>/mcp.json` and trusted project `.pi/mcp.json`.

The default MCP exposure is `codemode`: tools are discovered and called from scripts, not declared directly to the model. SDK `deferred`, `direct`, and `hidden` exposure behavior is preserved. Role selections and exclusions govern actual calls, including calls from codemode; codemode cannot bypass delegation restrictions.

Disable built-ins through Pi settings, for example `"extensions": ["-builtin:mcp"]`. Disabling MCP prevents its built-in connections; disabling codemode alone does not disable other MCP exposure modes. Third-party extensions registering the same codemode/tool-search tool or `/mcp` command replace the corresponding built-in using SDK semantics, without duplicate registration or built-in MCP connections.

## Configuration and storage

Each project uses one optional configuration file:

```text
<projectRoot>/.pi/subagents/setting.json
```

```json
{
  "external_directory": [
    "/workspace/backend",
    "~/projects/frontend",
    "$HOME/projects/shared"
  ],
  "max_depth": 4,
  "max_live_agents": 8,
  "ui_timeout_ms": 120000
}
```

A missing file uses built-in defaults. There is no global configuration layer. `external_directory` comes from the current caller's project; `max_depth`, `max_live_agents`, and `ui_timeout_ms` come from the root project and govern the entire tree. Descendant projects' root-only fields apply only when those projects later host their own root sessions.

`external_directory` entries may expand `~`, `$HOME`, or `${HOME}`, but must then be absolute, existing directories. Each entry grants only that exact canonical directory—not its descendants.

Delegation authorization is session-local. If A permits B and B permits C, `A → B → C` is allowed even when A does not mention C. A never preloads B's agents or C configuration. Same-cwd children are leaves; external children may delegate when depth, role tools, and runtime policy permit it. Canonical cwd ancestor repetition, such as `A → B → A`, is rejected.

Configuration loading does not create project session directories or `.gitignore`. Metadata and histories use:

```text
<getAgentDir()>/subagents/
  sessions/<parent-session-key>.json
  locks/<root-session-key>/
  histories/<actual-SDK-session-file>.jsonl
```

Each parent JSON contains only its directly owned children, with each child's actual Pi session identity/path, full creation-time role snapshot, and latest state. For `A → B → C`, A's JSON stores B and B's JSON stores C. An optional branch marker diagnoses missing previously initialized owner files. There are no separate run records, result copies, or delivery records. The whole tree shares one root writer lock; owner updates are serialized and atomically replaced. New metadata is private (0600 files, 0700 directories on POSIX). Unsafe paths, damaged owner headers, permission failures, and lock conflicts fail closed with no legacy-store fallback.

New child history uses public `SessionManager.create(cwd, privateDir)`, with `privateDir` at `<getAgentDir()>/subagents/histories`, outside Pi's ordinary session discovery directories. It deliberately **does not** honor or inherit CLI `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or global/project `sessionDir` settings. Root history is not relocated. Child files are privately initialized as native JSONL with valid headers and 0600 permissions; newly created directories use 0700 on POSIX.

Default native discovery, picker, and continue do not select these new histories. Explicit file opening/resume and explicit discovery with a custom session directory pointing at the private directory remain allowed; this is not an access-control boundary. Existing default-directory histories referenced by the current metadata stay at their saved paths, remain recoverable, and may still appear in ordinary discovery. No existing files are migrated, relocated, or deleted. The tree writer lock does not coordinate independent manual edits to child history. See [Spec 0002](docs/specs/0002-prompt-and-session-storage.md) and [ADR-0003](docs/adr/0003-sdk-sessions-and-parent-metadata.md).

## Multiple windows on the same root

Multiple Pi windows may open the exact same persistent root session without reserving its subagent tree. The first `subagent` or ordinary `ask_subagent` call acquires the whole-tree writer lock and rebuilds the tree from the latest saved metadata before checking names, ownership, or limits. Recovery is deferred until this acquisition; an idle window never marks another window's work interrupted.

While one window owns the tree, its own tasks and descendants can run in parallel within the existing limits. Other windows immediately receive `ROOT_SCOPE_IN_USE` for create, ask, and steer—even for an idle sibling. That failure affects only that call: after all work, report dependencies, SDK calls, and cleanup finish, the lock is released and either window can explicitly try again without reload or restart. Requests are not queued or forwarded. Idle steering does not start an execution or recover old work; it returns `SUBAGENT_NOT_STEERABLE` when no other window owns the tree.

Results stay with the executing window's captured direct-parent report chain. Closing that window stops its work; another window does not take over or receive old reports. Root report submission is not a receipt that the root model consumed it. A non-cooperative hook can delay cleanup and lock release. This lock does **not** coordinate the root Pi history itself or independent manual child-history writes. See [Spec 0005](docs/specs/0005-execution-scoped-root-lock.md) and [ADR-0005](docs/adr/0005-execution-scoped-root-lock.md).

## Background lifecycle

Local preparation, including `running`, is persisted before calling the SDK. Here `running` means this package has assumed background-task responsibility, not that the SDK is streaming. A preparation failure does not call the SDK; after submission, failures retain identity/history and use background cleanup. Handled ordinary input remains submitted, without inventing a started run or reusing an old answer. Cancelling the originating tool does not retract submitted background work.

- Final responses are reported automatically to the direct parent as Pi custom messages (`customType: "subagent-report"`). Older histories may contain `bykwp-subagent-report` messages; the extension does not rewrite them.
- Tool results list the caller's direct subagents as running, done, or interrupted, alongside current shared live usage. `SUBAGENT_BUSY` and `LIVE_AGENT_LIMIT` results include the same snapshot. Lists include every direct subagent and its saved creation-time role (`agentType`); names are shortened when long. Role-file changes do not change existing subagents' displayed roles.
- Automatic reports include the validated absolute JSONL path on a `Complete conversation: ...` line before the result, without a separate `Full session` heading. Missing, unsafe, malformed, or identity-mismatched history is explicitly marked unavailable; reports do not expand the file contents. This is persisted conversation history, not a complete system-prompt/tool-definition snapshot.
- Automatic reports show the direct parent's subagent statuses (including the reporting agent as done) and remind the direct parent that it can use `ask_subagent` with any idle subagent listed above for related follow-up work. While relevant reports are pending, the caller is instructed to provide only a brief progress update and defer its final answer.
- An idle parent waiting for children remains loaded; it is not cold-released.
- Stopping only the root model response does not stop accepted background work.
- Quitting, replacing, forking, or reloading the root session uses public `abort()` for active descendants, cancels proxied UI, and disposes child SDK sessions before releasing the writer lock. Non-cooperative input hooks can delay cleanup and lock release.
- Completed logical identities and histories remain available when the exact persistent root session is resumed.
- Interrupted work is not automatically replayed.

Cross-restart recovery requires the exact file-backed root identity (Pi ID plus normalized absolute file path). A new, forked, cloned, or imported root cannot take ownership of another root's children. After acquiring ownership for the next explicit create or ordinary ask, recovery loads identities and saved roles, marks unfinished accepted work interrupted, and clears prepared opening state to idle; it does not mount children, replay tasks, or redeliver old reports. Completed results that were not delivered before shutdown remain available only in child history. Deleting a project's directory does not delete global metadata/history, but missing or moved cwd values cause follow-up asks to fail rather than relocate automatically.

Ordinary asks validate the child's history identity and cwd, then let the SDK restore model selection, thinking, and conversation without parent/settings overrides. Missing historical selections or unavailable models/authentication follow SDK defaults, fallback, and thinking clamp. Public fallback diagnostics are shown when available; preserving the original model or successful fallback is not guaranteed. No available model or later execution failures still fail normally. Target tools/resources/configuration are rebuilt, while the saved role remains unchanged. Reports carry persisted conversation paths, not complete system-prompt or tool-definition snapshots.

**Earlier Spec 0002 BREAKING storage change:** `ask_subagent.id` and public agent/run IDs were removed. Agents in the old project-local store or legacy agentDir store are not loaded, migrated, or used as a fallback; they cannot be asked under the Spec 0002 storage layout. Old files remain untouched; names from those legacy stores may be reused to create independent histories. The Pi 1.4 upgrade does not clear current-schema identities or histories and introduces no new storage migration.

## UI support

All descendants share one FIFO for blocking UI:

| Capability | Behavior |
| --- | --- |
| `confirm`, `select`, `input` | Forwarded to root UI with source label, cancellation, and timeout |
| `notify`, `setStatus` | Forwarded; status keys are namespaced and cleaned up |
| Background progress | Root-owned native string widget below the editor |
| theme reads | Forwarded read-only |
| `editor` | Returns `undefined` |
| `custom` | Rejected as unsupported |
| widgets/header/footer/editor mutation/raw terminal input | Not forwarded |

The progress widget shows one latest line per active subagent, such as
`worker[3]：bash pnpm test`. The number counts model calls in the current logical run. Thinking
content and tool output are not copied into the widget, and the widget is cleared when no runs remain.
Child extensions still cannot create or mutate root widgets.

## Security and compatibility

`external_directory` is cwd admission, not a filesystem sandbox. Bash, extension code, and third-party tools can access paths outside cwd unless their own policy prevents it. External project configuration and resources are not read until Pi project trust succeeds.

Global subagent metadata and Pi JSONL histories contain potentially sensitive prompts, replies, tool results, and role snapshots. Private file modes do not replace backup policy, filesystem access control, or disk encryption. Global storage and SDK history directories must be writable; project configuration reading does not require generating project storage.

Children run in the same Node.js process. This package keeps its own state session-scoped, but cannot isolate third-party extensions that use process-global singletons, mutate environment variables, or terminate the process.

## Development

The development baseline is Pi SDK 1.4.0. See [ADR-0004](docs/adr/0004-official-sdk-lifecycle.md) for the submitted, steering, restoration, and cleanup decisions.

```bash
pnpm install
pnpm --filter @yesifan/pi-subagents typecheck
pnpm --filter @yesifan/pi-subagents test
pnpm --filter @yesifan/pi-subagents build
pnpm --filter @yesifan/pi-subagents pack --pack-destination /tmp
```

See [`docs/domain-model.md`](docs/domain-model.md) for the terminology and lifecycle model, and [`docs/specs/yesifan-pi-subagents-spec.md`](docs/specs/yesifan-pi-subagents-spec.md) for the implementation specification.
