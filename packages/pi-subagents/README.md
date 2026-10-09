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

Starts a background logical subagent and returns as soon as Pi accepts its prompt. Independent `subagent` calls emitted in the same assistant turn run in parallel, subject to the root project's shared `max_live_agents` limit.

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

A normal ask against a busy subagent immediately returns `SUBAGENT_BUSY`; requests are not queued. `ask_subagent` is not a status or result-polling tool.

To steer an actively streaming run without creating a new run:

```json
{ "name": "reviewer", "prompt": "Focus on the authorization boundary.", "isSteer": true }
```

Steering can adjust the direction of an actively streaming run or add new context. Both `subagent` and `ask_subagent` tool results remind the caller of this option. Steering returns the same name with `status: "steered"`. It does not create a separate report. Idle, released, finalizing, or waiting-for-children agents are not steerable.

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

Roles accept either `tools` (an allowlist) or `disallowedTools` (a denylist), never both—even when one is empty. Both are arrays of non-empty tool-name strings; duplicate names are removed. `tools: []` allows no tools, while `disallowedTools: []` adds no restrictions. Omitting both preserves the normal target session's tools. Unknown allowlisted names fail with `TOOL_UNAVAILABLE`; unknown denylisted names are harmless and remain excluded if an extension registers them later.

For example, to keep discovered extension tools while excluding selected tools:

```md
---
name: researcher
description: Explore using available search tools
disallowedTools: [edit, write, bash, destructive_custom_tool]
---

Explore without modifying files. Report evidence and file locations.
```

The built-in `explore` uses `disallowedTools: [edit, write, bash]`, preserving its exploration prompt and other available built-in/extension tools. This does **not guarantee strict read-only execution**: other tools (including `powershell`, if enabled), extension code, and further delegation may have side effects. Use an explicit `tools` allowlist of trusted tools when tighter tool selection is needed; neither policy is a filesystem sandbox.

Policies apply by exact tool name to the SDK registry, not only the initial active tools. Dynamic extension registration/re-registration and `setActiveTools()` cannot re-enable excluded names. Runtime delegation restrictions still apply: same-cwd and depth-limited children exclude `subagent`/`ask_subagent`; denylisting `subagent` disables descendant delegation, while denylisting only `ask_subagent` leaves creation available.

The selected policy is included in the saved role snapshot and content hash. Later role file changes affect newly created logical subagents only, not subsequent asks or root recovery.

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
<Pi SDK default cwd-grouped session directory>/<actual-session-file>.jsonl
```

Each parent JSON contains only its directly owned children, with each child's actual Pi session identity/path, full creation-time role snapshot, and latest state. For `A → B → C`, A's JSON stores B and B's JSON stores C. An optional branch marker diagnoses missing previously initialized owner files. There are no separate run records, result copies, or delivery records. The whole tree shares one root writer lock; owner updates are serialized and atomically replaced. New metadata is private (0600 files, 0700 directories on POSIX). Unsafe paths, damaged owner headers, permission failures, and lock conflicts fail closed with no legacy-store fallback.

Child history uses the directory allocated by public `SessionManager.create(cwd)`, under the SDK's current agentDir. It deliberately **does not** honor or inherit CLI `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or global/project `sessionDir` settings. Root history is not relocated. Child files are privately initialized with valid headers before their identity is saved. Native Pi discovery can list these histories; independently opening a child is allowed, but the tree writer lock does not coordinate independent manual edits to its history.

## Background lifecycle

- Final responses are reported automatically to the direct parent as Pi custom messages (`customType: "subagent-report"`). Older histories may contain `bykwp-subagent-report` messages; the extension does not rewrite them.
- Tool results list the caller's direct subagents as running, done, or interrupted, alongside current shared live usage. `SUBAGENT_BUSY` and `LIVE_AGENT_LIMIT` results include the same snapshot. Lists include every direct subagent and its saved creation-time role (`agentType`); names are shortened when long. Role-file changes do not change existing subagents' displayed roles.
- Automatic reports include the validated absolute JSONL path on a `Complete conversation: ...` line before the result, without a separate `Full session` heading. Missing, unsafe, malformed, or identity-mismatched history is explicitly marked unavailable; reports do not expand the file contents. This is persisted conversation history, not a complete system-prompt/tool-definition snapshot.
- Automatic reports show the direct parent's subagent statuses (including the reporting agent as done) and remind the direct parent that it can use `ask_subagent` with any idle subagent listed above for related follow-up work. While relevant reports are pending, the caller is instructed to provide only a brief progress update and defer its final answer.
- An idle parent waiting for children remains loaded; it is not cold-released.
- Stopping only the root model response does not stop accepted background work.
- Quitting, replacing, forking, or reloading the root session aborts active descendants, cancels proxied UI, and disposes child SDK sessions.
- Completed logical identities and histories remain available when the exact persistent root session is resumed.
- Interrupted work is not automatically replayed.

Cross-restart recovery requires the exact file-backed root identity (Pi ID plus normalized absolute file path). A new, forked, cloned, or imported root cannot take ownership of another root's children. Recovery loads identities and saved roles, marks unfinished accepted work interrupted, and clears prepared opening state to idle; it does not mount children, replay tasks, or redeliver old reports. Completed results that were not delivered before shutdown remain available only in child history. Deleting a project's directory does not delete global metadata/history, but missing or moved cwd values cause follow-up asks to fail rather than relocate automatically.

Ordinary asks derive cwd, model selection, thinking, and conversation from the child's validated Pi history; current parent settings never replace the historical selection. Header-only history, missing historical selection/thinking, unavailable model/authentication, and SDK fallback produce explicit errors. Target tools/resources/configuration are rebuilt, while the saved role remains unchanged. Reports carry persisted conversation paths, not complete system-prompt or tool-definition snapshots.

**BREAKING upgrade:** `ask_subagent.id` and public agent/run IDs are removed. Existing agents in the old project-local store or legacy agentDir store are not loaded, migrated, or used as a fallback; they cannot be asked after this upgrade. Old files are left untouched. Names may be reused in the new empty registry, creating independent histories.

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

```bash
pnpm install
pnpm --filter @yesifan/pi-subagents typecheck
pnpm --filter @yesifan/pi-subagents test
pnpm --filter @yesifan/pi-subagents build
pnpm --filter @yesifan/pi-subagents pack --pack-destination /tmp
```

See [`docs/domain-model.md`](docs/domain-model.md) for the terminology and lifecycle model, and [`docs/specs/yesifan-pi-subagents-spec.md`](docs/specs/yesifan-pi-subagents-spec.md) for the implementation specification.
