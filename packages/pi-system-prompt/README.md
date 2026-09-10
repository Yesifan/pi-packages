# pi-system-prompt

A [Pi](https://pi.dev) extension that adds a `/system-prompt` slash command.

`/system-prompt` prints everything Pi sends to the model **before the user message**: the system message text **and** the tools array.

## Install

```bash
pi install npm:@BYKWP/pi-system-prompt
# project-local installation from a monorepo checkout:
pi install -l ./packages/pi-system-prompt
```

After installing, run `/reload` in a Pi session (or restart Pi), then:

```
/system-prompt
```

## `/system-prompt` (current session)

Renders a dump with exactly two sections:

- **SYSTEM PROMPT (system message text)** — the fully assembled system prompt string sent
  as the system message (from `before_agent_start`/`getSystemPrompt()`).
- **TOOLS (tools array sent to the model)** — the `tools` from the last
  `before_provider_request` payload, dumped verbatim as JSON (the real tool definitions).

Nothing else is printed (no meta block, no prompt-inputs list, no tool registry dump). No file is written; it just displays directly.

## How `/system-prompt` captures the real values

- `before_agent_start` captures `event.systemPrompt` (the fully assembled system
  prompt string for the turn).
- `before_provider_request` captures `event.payload`, from which the exact `tools`
  array is read.

## License

MIT

## Development

See [docs/development.md](docs/development.md) for how to install the package
locally during development and how to update the extension after source changes.
