# pi-packages

A monorepo of [Pi](https://github.com/badlogic/pi-mono) packages published under the `@BYKWP` scope.

## Packages

| Package | Description |
| --- | --- |
| [`@BYKWP/pi-weixin-daemon`](./packages/pi-weixin-daemon/) | Connect Weixin iLink Bot with Pi Coding Agent |
| [`@BYKWP/pi-system-prompt`](./packages/pi-system-prompt/) | Display the system prompt and tools sent to the model |
| [`@BYKWP/pi-subagents`](./packages/pi-subagents/) | Run persistent background subagents with nested delegation |

## Development

Requires Node.js 22 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm test
```

Install a package directly from the workspace during development:

```bash
pi install ./packages/pi-system-prompt
```
