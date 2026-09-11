# @BYKWP/pi-subagents

Persistent, in-process background subagents for [Pi](https://pi.dev), tested against `@earendil-works/pi-coding-agent@0.85.1`.

## Install

```bash
pi install npm:@BYKWP/pi-subagents
# local checkout
pi install -l ./packages/pi-subagents
```

Restart Pi or run `/reload` after installation.

## Tools

### `subagent`

Starts a background logical subagent and returns as soon as Pi accepts its prompt.

```json
{
  "name": "reviewer",
  "prompt": "Review the authentication flow and report concrete findings.",
  "agent_type": "general",
  "thinking": "high",
  "cwd": "/absolute/path/to/project"
}
```

`cwd` is optional and defaults to the caller's current cwd. An explicit value must be an absolute path that resolves exactly to the current cwd or one configured external cwd. Relative paths, `~`, `$HOME`, and `${HOME}` are rejected in tool input.

### `ask_subagent`

Starts another run on a directly owned idle logical subagent:

```json
{ "id": "sa_...", "prompt": "Now check the tests." }
```

A normal ask against a busy subagent immediately returns `SUBAGENT_BUSY`; requests are not queued.

To steer an actively streaming run without creating a new run:

```json
{ "id": "sa_...", "prompt": "Focus on the authorization boundary.", "isSteer": true }
```

Steering returns the current run ID with `status: "steered"`. It does not create a separate report. Idle, released, finalizing, or waiting-for-children agents are not steerable.

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

The built-in `explore` allows only `read`, `grep`, `find`, and `ls`.

## Configuration

Global:

```text
<getAgentDir()>/extensions/pi-subagents.json
```

Project:

```text
<projectRoot>/.pi/extensions/pi-subagents.json
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

Project fields replace global fields; arrays are not unioned. `external_directory` entries may expand `~`, `$HOME`, or `${HOME}`, but must then be absolute, existing directories. Each entry grants only that exact canonical directory—not its descendants.

Delegation authorization is session-local. If A permits B and B permits C, `A → B → C` is allowed even when A does not mention C. A never preloads B's agents or C configuration. Same-cwd children are leaves; external children may delegate when depth, role tools, and runtime policy permit it. Canonical cwd ancestor repetition, such as `A → B → A`, is rejected.

## Background lifecycle

- Final responses are reported automatically to the direct parent as Pi custom messages.
- An idle parent waiting for children remains loaded; it is not cold-released.
- Stopping only the root model response does not stop accepted background work.
- Quitting, replacing, forking, or reloading the root session aborts active descendants, cancels proxied UI, and disposes child SDK sessions.
- Completed logical identities and histories remain available when the exact persistent root session is resumed.
- Interrupted work is not automatically replayed.

Cross-restart recovery requires a file-backed root session. A new, forked, cloned, or imported root cannot take ownership of another root's subagents.

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

`external_directory` is cwd admission, not a filesystem sandbox. Bash, extension code, and third-party tools can access paths outside cwd unless their own policy prevents it. External project resources remain subject to Pi project trust.

Children run in the same Node.js process. This package keeps its own state session-scoped, but cannot isolate third-party extensions that use process-global singletons, mutate environment variables, or terminate the process.

## Development

```bash
pnpm install
pnpm --filter @BYKWP/pi-subagents typecheck
pnpm --filter @BYKWP/pi-subagents test
pnpm --filter @BYKWP/pi-subagents build
pnpm --filter @BYKWP/pi-subagents pack --pack-destination /tmp
```

See [`docs/domain-model.md`](docs/domain-model.md) for the terminology and lifecycle model, and [`docs/specs/bykwp-pi-subagents-spec.md`](docs/specs/bykwp-pi-subagents-spec.md) for the implementation specification.
