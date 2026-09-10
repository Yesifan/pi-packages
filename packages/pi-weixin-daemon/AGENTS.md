# Project Overview

`pi-weixin-daemon`（CLI：`pi-wx`）是一个 Node.js/TypeScript 守护进程，将腾讯微信 iLink Bot
接入 Pi Coding Agent。一个 daemon 可管理多个微信账号和多个项目；每个账号最多绑定一个项目，
每个项目以自己的 `cwd` 运行一个共享 Pi 会话，并在项目之间进行故障隔离。

## 核心链路

```text
Weixin iLink → account monitor → AccountManager → ProjectManager
→ ProjectController → SessionController → PiSdkHost → Pi Agent
```

- 入站消息按 `accountId → projectId` 路由。
- `ProjectController` 负责项目生命周期、参与者注册、互通和广播。
- `SessionController` 负责单会话状态机、busy/abort、命令、超时及错误回复。
- `src/pi/` 是唯一允许直接依赖 Pi SDK 的边界；项目和会话层只使用本项目定义的领域接口。
- 文本回复可广播给同项目参与者；文件发送和 Extension UI 始终回到当前 `TurnContext`。
- 无 HTTP server、数据库或消息队列，控制面使用 Unix Domain Socket RPC。

## 主要目录

- `src/accounts/`：微信账号 transport 的注册与生命周期。
- `src/weixin/`：iLink API、长轮询、消息归一化、媒体及发送实现。
- `src/projects/`：账号到项目的路由、项目控制器、配置和参与者注册表。
- `src/sessions/`：共享 Pi 会话状态机、prompt 构造和回复结果处理。
- `src/pi/`：Pi SDK host、事件转换、Extension/UI 适配。
- `src/daemon.ts`：运行时组合根；`src/cli/`：`pi-wx` CLI 和 RPC 客户端。
- `test/unit/`、`test/integration/`：Vitest 单元及集成测试。

## 开发命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

运行环境要求 Node.js `>=22.19.0`、pnpm `11.x`；版本和依赖以 `package.json` 为准。

---

## 版本管理
- 无 **BREAKING** 变更（仅新增/修复/行为增强）→ 只更新 `package.json`的 **`z`（patch）**，例如 `0.5.0 → 0.5.1`。
- 有破坏性的变更（标记 `BREAKING`）→ 升 **`minor`**（`x.y`），必要时 **`major`**（`x`）。
- `src/version.ts` 动态读 `package.json` 作为**唯一版本源**，改版只改 `package.json`。
- 每次改版同步在 `CHANGELOG.md` 顶部新增对应版本条目（Keep a Changelog）。

---

## 项目文档索引

本项目的机制 / 领域模型文档在 [`docs/README.md`](docs/README.md)，建议按以下顺序阅读：

1. [`docs/domain-model.md`](docs/domain-model.md) —— 实体与变量的术语基准（先读）。
2. [`docs/routing.md`](docs/routing.md) —— 消息路由与会话生命周期。
3. [`docs/ilink-protocol.md`](docs/ilink-protocol.md) —— 微信 iLink 协议机制存档。
