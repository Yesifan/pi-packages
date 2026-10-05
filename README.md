# pi-packages

A monorepo of [Pi](https://github.com/badlogic/pi-mono) packages published under the `@yesifan` scope.

## Packages

| Package | Description |
| --- | --- |
| [`@yesifan/pi-weixin-daemon`](./packages/pi-weixin-daemon/) | Connect Weixin iLink Bot with Pi Coding Agent |
| [`@yesifan/pi-system-prompt`](./packages/pi-system-prompt/) | Display the system prompt and tools sent to the model |
| [`@yesifan/pi-subagents`](./packages/pi-subagents/) | Run persistent background subagents with nested delegation |

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

## Release

Changes to published packages include a changeset. After the feature PR is merged, automation opens a version PR for review; merging that PR triggers verification and publishing of unpublished package versions. Packages are versioned independently. See [CI and release guide](docs/ci-release.md) for the full process.
