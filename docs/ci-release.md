# CI 与自动发布

仓库使用 GitHub Actions、Changesets 和 npm Trusted Publishing：

- `.github/workflows/ci.yml`：Pull Request、`main` push 和手动触发时执行安装、类型检查、
  lint、离线测试、构建以及 tarball 内容校验。依赖实际 AI API 的测试不会在 GitHub CI 运行。
- `.github/workflows/release.yml`：`main` 收到普通 changeset 时创建或更新 Release PR；Release
  PR 合并后再次检查、测试、构建，发布变更过的包，并创建 package tag 和 GitHub Release。
- npm 发布优先使用 GitHub OIDC 临时凭据，不需要长期 npm token；公开仓库会附带 provenance。

## 1. GitHub 仓库设置

进入 `Yesifan/pi-packages` 的 **Settings → Actions → General**：

1. 在 **Workflow permissions** 选择 **Read and write permissions**。
2. 启用 **Allow GitHub Actions to create and approve pull requests**。
3. 保存设置。

建议在 **Settings → Branches / Rules → main** 增加保护规则：

- 要求 Pull Request 才能合并；
- 要求 `Verify (Node.js 22)` 状态检查通过；
- 禁止跳过未完成的状态检查；
- 可选：要求 Release PR 也经过人工审核。

`release.yml` 只在 `main` 上运行；来自 fork 的 Pull Request 不会获得发布权限。

## 2. npm scope 与首次发布

npm 包名必须小写，因此 scope 是 `@yesifan`。npm 账号或组织 `yesifan` 必须已经存在，并且
执行发布的 npm 用户需要拥有该 scope 的发布权限。

Trusted Publisher 通常在包已经存在后才能从包设置页配置。本仓库中的两个小写包首次发布时，
先使用一次临时 token：

1. 在 npm 创建具有 `@yesifan` 包 **Read and write** 权限的 granular access token；若 npm 要求，
   为自动发布启用 bypass 2FA。
2. 在 GitHub **Settings → Secrets and variables → Actions → New repository secret** 中创建
   `NPM_TOKEN`。
3. 合并本次功能 PR。Release workflow 会创建 `chore: release packages` PR。
4. 审核并合并该 Release PR。工作流将用 `NPM_TOKEN` 首次发布两个包。

不要把 token 写入仓库文件、workflow 日志或 npm 配置文件。OIDC 配好后立即删除这个 secret。

## 3. 配置 npm Trusted Publishers

首次发布成功后，分别打开以下 npm 包的 **Settings → Trusted Publisher**：

- `@yesifan/pi-weixin-daemon`
- `@yesifan/pi-system-prompt`

每个包填写同一组、区分大小写的值：

| npm 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Yesifan` |
| Repository | `pi-packages` |
| Workflow filename | `release.yml` |
| Environment | 留空 |
| Allowed action | `npm publish` |

配置完成后：

1. 从 GitHub Actions secrets 删除 `NPM_TOKEN`；
2. 后续发布由 `release.yml` 的 `id-token: write` 换取短期、单包 OIDC 凭据；
3. 不要在仓库或用户 `.npmrc` 中配置发布 token。

如果发布报 `ENEEDAUTH`，优先检查 npm 上的 GitHub owner、仓库名和 workflow 文件名是否完全
匹配，并确认运行器是 GitHub-hosted runner。如果报 `E404`，检查 `yesifan` scope 的所有权和包名
是否全小写。

## 4. 日常发版流程

修改公开包的 Pull Request 应包含 changeset：

```bash
pnpm changeset
```

选择受影响的包和版本级别：

- `patch`：兼容修复或小增强；
- `minor`：BREAKING 变更（本仓库当前 0.x 版本约定）；
- 不影响发布内容的文档、测试或 CI 修改可以不添加 changeset。

提交 `.changeset/*.md`。合并到 `main` 后：

1. Release workflow 创建或更新 `chore: release packages` PR；
2. Changesets 在该 PR 中更新 package version、CHANGELOG 和 lockfile；
3. 人工审核并合并 Release PR；
4. workflow 执行 `pnpm check`、`pnpm test:ci`、`pnpm build`；
5. 仅发布版本尚未出现在 npm 的 package；
6. 创建形如 `@yesifan/pi-system-prompt@0.2.0` 的 tag 和 GitHub Release。

本地可预检发布内容：

```bash
pnpm check
pnpm test:ci # 与 GitHub CI 相同，不访问实际 AI API
pnpm test    # 可选的本地全量测试，需要配置模型 API
pnpm build
pnpm -r --filter './packages/*' pack --pack-destination /tmp/pi-packages
```

## 5. 必需与可选的 GitHub secrets

| Secret | 是否长期需要 | 用途 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 自动提供，无需创建 | 创建 Release PR、tag 和 GitHub Release |
| `NPM_TOKEN` | 否 | 仅用于尚不能配置 Trusted Publisher 的首次发布 |

日常 OIDC 发布不需要任何自建 GitHub secret。
