# CI 与自动发布

仓库通过 GitHub Actions、Changesets 发布 `@yesifan/*` 包：

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 在 PR、`main` push 和手动触发时运行类型检查、Biome、离线测试、构建与 tarball 检查，不发布。
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) 仅在 `main` push 或手动触发时运行；先执行同样的验证，**只有验证成功**才创建/更新版本 PR 或尝试发布。发布所需的写权限与 npm OIDC 权限只授予 release job。
- 真实模型/API 集成测试不在 CI 运行；本地需要时运行 `pnpm test`。

## 日常发版流程

### 1. 功能 PR：提交变更及 changeset

修改公开包的运行时代码或用户可见行为时，从仓库根目录运行：

```bash
pnpm changeset
```

按提示**只选择受影响的子包**，填写用户可读的变更摘要并提交生成的 `.changeset/*.md`。本仓库独立管理各包版本：修复和兼容增强选 `patch`；标记为 BREAKING 的变更按仓库 0.x 约定通常选 `minor`，必要时选 `major`。只改内部文档、测试或 CI 配置且不影响发布内容时可不添加 changeset。

普通功能 PR 不手工修改子包 `package.json` 版本、CHANGELOG 或锁文件来替代 changeset，避免发布时重复升级。PR 上的 CI 必须通过；包括 `pnpm test:ci` 的离线测试和 tarball 检查。将功能 PR 合入 `main`。

### 2. 版本 PR：审核版本与发布内容

`main` 的 Release workflow 先重新验证该提交。验证成功且存在 pending changeset 时，Changesets 创建或更新 `chore: release packages` 版本 PR；**这一步不发布 npm**。该 PR 会消费 changeset，更新所选子包的版本和 CHANGELOG，以及需要同步的锁文件。各包版本无需一致；将来若存在跨包依赖，也应审核依赖版本的连带更新。

审核该 PR 中受影响的包、`package.json` 版本、CHANGELOG、锁文件及实际 tarball；确认发布内容和版本级别后再合入 `main`。版本 PR 同样要通过 CI。由默认 `GITHUB_TOKEN` 创建的自动 PR 若显示工作流待批准，需有写权限的维护者在 GitHub 上批准运行后再合并。

### 3. 发布：合并版本 PR

版本 PR 合入 `main` 后，Release workflow **再次验证**，通过后运行根目录 `pnpm release`（检查、离线测试、构建、`changeset publish`）。Changesets 只尝试发布 npm 上尚未存在相应版本的包；其他子包不会仅因共用仓库而自动升级。首次发布时，尚不存在于 npm 的其他公开包也可能按它们当前的版本一起发布。

发布成功后，工作流为已发布的包创建 package tag 和 GitHub Release；若验证、认证或 npm 发布失败，则不能认为发布完成。没有 pending changeset 的普通 `main` push 不修改版本，只检查是否有尚未发布的版本。手动触发 `release.yml` 也会先验证；仅选择 `main` 时才会执行版本或发布 job，操作前仍应检查当前版本。

本地可预检：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:ci
pnpm build
pnpm -r --filter './packages/*' pack --pack-destination /tmp/pi-packages
```

## 一次性配置与参考

GitHub 仓库需要允许 Actions 创建 PR，并为版本 PR 与发布提供相应权限；可用分支保护要求功能 PR 和版本 PR 的 CI 通过。npm 发布需要 `@yesifan` scope 权限：尚未建立 Trusted Publisher 的包首次发布可临时使用 `NPM_TOKEN`，之后为各包配置 npm Trusted Publisher（workflow 文件名为 **`release.yml`**），验证成功后移除长期 token。具体设置以官方文档为准：

- [Changesets：自动发版流程](https://changesets.dev/guide/automating)
- [npm：Trusted publishing、首次发布及 OIDC 设置](https://docs.npmjs.com/trusted-publishers/)
- [GitHub Actions：`GITHUB_TOKEN` 权限](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication)
- [GitHub：分支保护规则](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
