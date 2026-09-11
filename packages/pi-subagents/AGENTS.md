# Project Overview

`@BYKWP/pi-subagents` 是一个 Pi 扩展，在同一 Node.js 进程中运行可持久化的后台
AgentSession，并提供 `subagent` 与 `ask_subagent` 工具。实现基线为
`@earendil-works/pi-coding-agent@0.85.1`；涉及 Pi SDK 行为时，以该锁定版本的类型和源码为准。

先阅读 [`docs/domain-model.md`](docs/domain-model.md) 统一实体和变量术语，再查阅权威行为规范
[`docs/specs/bykwp-pi-subagents-spec.md`](docs/specs/bykwp-pi-subagents-spec.md)。修改公开语义、生命周期、
持久化格式或委派边界前必须先更新或核对该规范；发现文档内部冲突时暂停实现并与用户讨论，
不自行选择新语义。

## 核心模型与不变量

- 每个 root Pi session 对应一个 `RootRuntime`，并独占自己的持久化 scope。
- logical subagent 身份可跨 ask 和 root 恢复保留，但每次活动 mount 使用独立 AgentSession。
- caller 只使用自己的 session-local `DelegationContext`：自己的 cwd、agent registry 和 external cwd 配置。
- child 角色在创建时从 caller registry 解析并保存完整 snapshot；后续 ask 不得重新解析同名角色替换 snapshot。
- tool 的 `cwd` 只接受绝对路径；canonicalize 后必须精确等于 caller cwd 或 caller 当前配置中的一个 external cwd。授权不包含子目录或路径前缀。
- same-cwd child 是叶节点；external child 只有在角色工具、深度和运行时策略都允许时才能继续委派。
- canonical cwd 祖先链不得重复，避免 `A → B → A` 循环。
- 普通 ask 只接受 idle logical subagent；busy 时立即返回 `SUBAGENT_BUSY`，不得增加业务任务队列。
- `isSteer: true` 只复用 Pi 当前 streaming run 的 steering queue，不创建新 run、run ID 或独立 report；不可 steering 时返回 `SUBAGENT_NOT_STEERABLE`。
- 子 run/report 与发起它的 parent run 绑定；等待 child/report 的 parent 不得提前 finalize 或 cold-release。
- root shutdown/session replacement 必须 abort 活动 descendants、取消 UI、dispose sessions 并释放 writer lock。
- 子 session 的 resources、extensions、tools、ModelRuntime 和动态描述必须按目标 cwd 当前状态重新建立，不能跨 cwd 共享 mutable registry。

任何可能改变 system prompt、tool schema、角色 prompt 拼接顺序、SessionManager 历史前缀或资源缓存边界的改动，都应保留或新增邻近的 `Warning Cache Broke` 注释，并添加恢复/隔离测试。

## 主要目录与模块

- `src/index.ts`：Pi 扩展入口及 root session 生命周期绑定。
- `src/runtime.ts`：logical agent/run 状态机、普通 ask、steering、报告和 shutdown。
- `src/child-session.ts`：目标 cwd AgentSession 创建/恢复、资源隔离、工具白名单和角色 prompt。
- `src/delegation.ts`：session-local delegation context 与动态 tool description。
- `src/config.ts`、`src/paths.ts`：分层配置、project root、canonical cwd 授权和 cycle 检查。
- `src/agents.ts`：内置/global/project agent registry、frontmatter 校验和 snapshot/hash。
- `src/store.ts`：root-scoped 原子 JSON 持久化和单 writer lock。
- `src/ui.ts`：所有 descendants 共用的 blocking UI FIFO 与受限 UI proxy。
- `src/tools.ts`：`subagent` / `ask_subagent` schema 和结构化结果。
- `agents/`：发布的内置 agent definitions；`explore` 默认必须保持只读。
- `test/unit/`、`test/integration/`：Vitest 测试。

## 实现边界

- 不为方便而读取 target cwd 的 agents/config 来替 caller 做委派决策。
- 不把角色 snapshot、delegation context 或动态工具描述提升为 process-global cache。
- 不把 steering 实现为第二套 completion/report 流程；原 run 仍只有一个最终报告。
- 不让调用方 tool abort 在 Pi 已接受任务后撤销成功结果；接受前 abort 必须回滚 opening 状态。
- trust 检查必须发生在加载 external project resources 之前。
- `external_directory` 只是 cwd admission，不是 filesystem sandbox；文档中不得宣称其提供文件系统隔离。
- 改变公开行为时同步更新 README、规范及 CHANGELOG；遵守根目录的 patch/minor 版本规则。

## 测试要求

测试必须隔离用户状态：设置临时 `PI_CODING_AGENT_DIR`，不得在真实 `~/.pi/agent` 下创建 store、session、config 或 trust 数据。临时目录应在 `afterEach` 中清理。

修复缺陷时优先添加复现测试。根据改动覆盖以下相关边界：

- config precedence、home expansion、绝对/canonical/exact cwd 匹配；
- agent layer override、snapshot 稳定性、symlink escape 和工具白名单；
- direct ownership、depth/live/cycle limit、普通 ask 原子 busy；
- STR01–STR06 steering 行为和单 report；
- child 等待、report delivery、恢复、interrupted run 和 writer lock；
- target resources/tools 更新、跨 cwd 隔离及 `Warning Cache Broke` 场景；
- UI FIFO、取消、timeout、无 UI fallback 和 status cleanup；
- pre-accept abort、post-accept contract 与 shutdown race。

在 monorepo 根目录运行：

```bash
pnpm --filter @BYKWP/pi-subagents typecheck
pnpm exec biome check packages/pi-subagents
pnpm --filter @BYKWP/pi-subagents test
pnpm --filter @BYKWP/pi-subagents build
pnpm --filter @BYKWP/pi-subagents pack --pack-destination /tmp
```

