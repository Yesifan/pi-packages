# pi-packages

A monorepo of [Pi](https://github.com/badlogic/pi-mono) packages published under the `@bykwp` scope.

## Packages

| Package | Description |
| --- | --- |
| [`@bykwp/pi-weixin-daemon`](./packages/pi-weixin-daemon/) | Connect Weixin iLink Bot with Pi Coding Agent |
| [`@bykwp/pi-system-prompt`](./packages/pi-system-prompt/) | Display the system prompt and tools sent to the model |

## Development

Requires Node.js 22 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm test:ci # offline suite used by GitHub Actions
pnpm test    # full suite; includes tests that call the configured AI model
```

Install a package directly from the workspace during development:

```bash
pi install ./packages/pi-system-prompt
```

## CI and releases

GitHub Actions validates every pull request and push to `main`. Changesets creates a release
pull request; merging that pull request publishes changed packages to npm and creates GitHub
Releases. See [CI and release setup](./docs/ci-release.md).
