# AGENTS.md

## 仓库概览

本项目是一个使用 pnpm workspace 管理的 Pi 包 monorepo。所有子包位于 `packages/`，并以 `@BYKWP/` scope 发布到 npm。

当前包含：

- `@BYKWP/pi-weixin-daemon`：连接微信 iLink Bot 与 Pi Coding Agent 的 TypeScript 守护进程及 `pi-wx` CLI。
- `@BYKWP/pi-system-prompt`：提供 `/system-prompt` 命令，显示当前会话实际发送给模型的系统提示词和工具定义。

在根目录使用 pnpm filter 运行子 package 的命令：

```bash
pnpm --filter @BYKWP/<pkg> run <script>
# 或
pnpm -C packages/<pkg> run <script>
```

处理某个子包前，先阅读该目录下的 README、`package.json` 和已有的 `AGENTS.md`。
更具体目录中的 `AGENTS.md` 优先于本文件。

## 目录结构

```text
docs/                       # Monorepo 全局文档
.refer/                     # 被 Git 忽略的外部源码快照，只供调研
packages/
```


## 常用命令

安装依赖：

```bash
pnpm install
```

全仓检查：

```bash
pnpm check       # 对所有提供 typecheck 脚本的子包执行类型检查
pnpm lint        # 使用根目录 Biome 配置检查整个 monorepo
pnpm test        # 对所有提供 test 脚本的子包执行测试
pnpm build       # 对所有提供 build 脚本的子包执行构建
```

只检查一个包：

```bash
pnpm --filter @BYKWP/pi-weixin-daemon typecheck
pnpm --filter @BYKWP/pi-weixin-daemon lint
pnpm --filter @BYKWP/pi-weixin-daemon test
pnpm --filter @BYKWP/pi-system-prompt typecheck
```

`pi-weixin-daemon` 的完整测试包含真实运行时集成测试，可能耗时较长。不要因为超时而直接认定测试通过；应记录失败或超时的具体测试，并在需要时运行最小相关测试文件定位问题。

## 工作原则

- 保持改动范围小且可回滚，不顺手重构无关代码。
- 保留现有行为；删除功能、改变默认值、协议或公开接口前先征求确认。
- 优先修改源码，不直接修改构建产物。
- 每完成一个阶段性的代码编写后，立即使用根目录 Biome 配置格式化本阶段改动的文件（例如 `pnpm exec biome check --write <paths>`），再继续类型检查、测试或下一阶段工作；不要把格式化全部拖到任务结束时，也不要借机格式化无关文件。
- 修复缺陷时尽量先添加或确认能复现问题的测试，再实现修复。
- 修改后至少运行受影响包的类型检查和相关测试；跨包或根配置变更应运行对应的全仓命令。
- 不要用会改变远端状态的命令来探测行为。未经明确授权，不执行 `git push`、发布 npm 包、创建标签或修改远端 Issue/PR。
- 引用外部 API、Pi SDK 行为或依赖能力时，以当前包锁定版本的类型和实现为准，不仅凭印象或最新文档判断。

## 包与依赖管理

新增子包时至少完成以下事项：

1. 放入 `packages/<pkg>/`，并提供独立 `package.json`。
2. 包名使用 `@BYKWP/<pkg>`。
3. 在根 `README.md` 的 Packages 表中登记。
4. 配置明确的 `files` allowlist，只发布运行时代码和用户文档。
5. 提供适用的 `typecheck`、`test`、`lint` 或 `build` 脚本；根脚本通过递归运行自动发现它们。
6. 执行安装、类型检查及相关测试，并验证发布包内容。

依赖版本更新后必须同步更新 `pnpm-lock.yaml`。不要在子包中增加独立 lockfile 或 workspace 文件；工作区配置统一由根目录管理。

跨包依赖应显式声明。只有确实需要引用本仓库兄弟包时才使用 `workspace:` 协议，不要依赖隐式链接。

## 版本管理

- 无 **BREAKING** 变更（仅新增、修复或行为增强）时，只更新包版本的 **patch** 位，例如 `0.5.0 → 0.5.1`。
- 有破坏性变更（标记 `BREAKING`）时，升级 **minor**，必要时升级 **major**。
- 每个包的 `package.json` 是其唯一版本源，不要在源码中重复维护版本号。
- 每次改版都应在对应包的 `CHANGELOG.md` 顶部新增版本条目，格式遵循 Keep a Changelog。

## 发布内容约定

每个可发布包必须在 `package.json` 中使用 `files` allowlist，不使用 `.npmignore` 反向排除。发布包应包含：

- 运行时所需源码或构建后的 `dist/`；
- `package.json`、README、LICENSE 等用户所需文件；
- README 直接引用且用户安装后需要阅读的文档。

发布包不应包含测试、TypeScript/Vitest/Biome 配置、内部计划、临时文件或 `AGENTS.md`。

发布前使用以下方式检查 tarball：

```bash
pnpm --filter @BYKWP/<pkg> pack --pack-destination /tmp
```

确认 tarball 中包含所有运行时文件，同时没有混入开发文件。`pi-weixin-daemon` 发布前会通过 `prepare`/`prepublishOnly` 构建 `dist/`，不得发布陈旧构建结果。

## Pi 扩展注意事项

- Pi 扩展通常在会话启动时加载一次。修改扩展源码后，当前会话仍可能运行旧代码；验证改动时应重新加载扩展或启动新会话。
- `pi-system-prompt` 当前直接发布 `extensions/` 下的 TypeScript 源码。
- `pi-weixin-daemon` 通过 `dist/` 发布 CLI；其 `src/pi/` 是直接依赖 Pi SDK 的边界。修改该包时必须继续遵守 `packages/pi-weixin-daemon/AGENTS.md` 中描述的分层规则。

## 文档维护

代码、命令、包名、安装方式或公开行为发生变化时，同步更新相关 README 和用户文档。文档应描述当前真实行为，不把临时计划、历史设想或未实现能力写成现状。

### 文档索引

具体 package 的包查看package 目录下的 AGENTS.md 和 docs/*

- ./docs/local-install.md 指导如何本地安装开发版本
- ./docs/reference-rules.md 指导如何管理参考项目

### ADR 约定

影响系统结构、关键质量属性或难以撤销的决策，应记录到 `packages/*/docs/adr/`。普通实现细节不需要 ADR。决策变更时应新增 ADR 并关联旧记录，不要覆盖原有理由。
