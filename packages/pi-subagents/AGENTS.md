# Project Overview

`@yesifan/pi-subagents` 是一个 Pi 扩展，在同一 Node.js 进程中运行可持久化的后台
AgentSession，并提供 `subagent` 与 `ask_subagent` 工具。实现基线为
`pnpm-workspace.yaml` 中 catalog 锁定的 Pi SDK 版本；涉及 Pi SDK 行为时，以该锁定版本的类型和源码为准。

先阅读 [`docs/domain-model.md`](docs/domain-model.md) 统一实体和变量术语，再查阅权威行为规范
[`docs/specs/yesifan-pi-subagents-spec.md`](docs/specs/yesifan-pi-subagents-spec.md)。修改公开语义、生命周期、
持久化格式或委派边界前必须先更新或核对该规范；发现文档内部冲突时暂停实现并与用户讨论，
不自行选择新语义。需求与实现规格统一存放在 `docs/specs/`，新增或移动文档时同步维护
[`docs/README.md`](docs/README.md) 索引及相关引用。
新增、编辑或实施规格前先阅读并遵守 [`规格索引与维护规则`](docs/specs/README.md)，同步规格 metadata 与索引。

当前工作区已实现 [`Spec 0002`](docs/specs/0002-prompt-and-session-storage.md) 的 runtime 重写与私有 history 目录；最新 typecheck、21 个文件 / 245 项测试、build 与 pack 通过。此前 runtime 独立最终复审已完成，不将其冒充最新目录修订已复审；该审查由主代理记录。实际交互 TUI/print 手测未运行，用户明确接受延期并关闭 Spec 0002（completed），不能因此声称 §14 CLI 全验收通过。PR #11 尚未合并，用户要求把最终目录/discovery 直接整合进原 Spec 0002 和 [`ADR-0003`](docs/adr/0003-sdk-sessions-and-parent-metadata.md)，不另立后续规格/决策。权威规格中的 V1 大节仅保留真实历史资料；当前按顶部摘要、Spec 0002/ADR-0003 执行，独立打开仍允许。[`Spec 0003`](docs/specs/0003-terminal-exit-reporting.md) 仍为未开始的异常退出通知计划，未经授权不要顺带实施。

## 核心模型与不变量

- 每个 file-backed root Pi session 对应一个 `RootRuntime` 和新的内存 `RootScope`，持有 `<getAgentDir()>/subagents/locks/<rootKey>/` 整树 writer lock；metadata 按直接 parent session 保存于全局 `subagents/sessions/<sessionKey>.json`，无项目镜像。
- logical subagent 以直接 parent 下 trim、大小写敏感唯一 name 寻址；`ask_subagent` 使用 name，不支持旧 id。身份可跨 ask/exact root resume 保留，每次普通 ask 使用新的 `Execution` 与 AgentSession；不生成本包 agent/run/mount/report ID 或 epoch。
- 新 child history 采用 SDK `SessionManager.create(cwd, privateDir)`，privateDir 为 `<getAgentDir()>/subagents/histories`，不追加 cwd 分组、不应用 CLI/env/settings sessionDir、不继承 root CLI override；`PI_CODING_AGENT_DIR` 仍决定 agentDir。存量新 schema metadata 引用的默认目录 history 按已保存 exact paths 恢复，不迁移、搬迁或删除。cwd/model/thinking 从 Pi header/history 恢复，不在 metadata 重复保存。
- caller 只使用自己的 session-local `DelegationContext`：自己的 cwd、agent registry 和 external cwd 配置。
- child 角色在创建时从 caller registry 解析并保存完整 snapshot；后续 ask 不得重新解析同名角色替换 snapshot。
- tool 的 `cwd` 只接受绝对路径；canonicalize 后必须精确等于 caller cwd 或 caller 当前配置中的一个 external cwd。授权不包含子目录或路径前缀。
- same-cwd child 是叶节点；external child 只有在角色工具、深度和运行时策略都允许时才能继续委派。
- canonical cwd 祖先链不得重复，避免 `A → B → A` 循环。
- 普通 ask 只接受 idle logical subagent；busy 时立即返回 `SUBAGENT_BUSY`，不得增加业务任务队列。
- `isSteer: true` 只复用 Pi 当前 streaming Execution 的 steering queue，不创建新执行或独立 report；不可 steering 时返回 `SUBAGENT_NOT_STEERABLE` 并说明具体状态，不能把所有拒绝等同已停止。
- child/report 绑定发起它的具体 parent Execution；等待 child/report 的 parent 不得提前 finalize 或 cold-release。sender 释放后已提交 delivery 仍面向原有效 target，不改下一次执行。
- 恢复 running→interrupted，不自动续跑、不保存历史 runRecord/result/delivery、不跨重启补投。旧 project/global store 不读取、迁移或 fallback，旧文件不自动删除。
- root shutdown/session replacement 必须 abort 活动 descendants、取消 UI、dispose sessions 并释放 writer lock。
- 子 session 的 resources、extensions、tools、ModelRuntime 和动态描述必须按目标 cwd 当前状态重新建立，不能跨 cwd 共享 mutable registry。

任何可能改变 system prompt、tool schema、角色 prompt 拼接顺序、SessionManager 历史前缀或资源缓存边界的改动，都应保留或新增邻近的 `Warning Cache Broke` 注释，并添加恢复/隔离测试。

## 主要目录与模块

- `src/index.ts`：Pi 扩展入口及 root session 生命周期绑定。
- `src/runtime.ts`：Agent/Execution/RootScope 生命周期、name reservation、普通 ask、steering、在线报告处理 barrier 和 shutdown。
- `src/child-session.ts`：目标 cwd AgentSession 创建/恢复、资源隔离、工具白名单/黑名单和角色 prompt。
- `src/delegation.ts`：session-local delegation context 与动态 tool description。
- `src/config.ts`、`src/paths.ts`：caller 项目配置、project root、canonical cwd 授权和 cycle 检查。配置读取不强制新建项目 sessions/.gitignore；`src/project-storage.ts` 保留历史 helper，不是当前 runtime store 初始化入口。
- `src/agents.ts`：内置/global/project agent registry、frontmatter 校验和 snapshot/hash。
- `src/store.ts`：全局直接 parent owner JSON、归属校验、串行原子写入/同步接受提交、递归恢复与整树 writer lock。
- `src/progress.ts`：run-local 活动摘要与 root 原生 widget 行格式化。
- `src/ui.ts`：所有 descendants 共用的 blocking UI FIFO、root progress widget 与受限 UI proxy。
- `src/tools.ts`：`subagent` / `ask_subagent` schema 和结构化结果。
- `agents/`：发布的内置 agent definitions；`explore` 默认排除 `edit/write/bash` 并保留探索 prompt，不保证严格只读（其他工具、扩展及进一步委派仍可能有副作用）。
- `test/unit/`、`test/integration/`：Vitest 测试。

## 实现边界

- 不为方便而读取 target cwd 的 agents/config 来替 caller 做委派决策。
- 不把角色 snapshot、delegation context 或动态工具描述提升为 process-global cache。
- 不把 steering 实现为第二套 completion/report 流程；原 Execution 仍至多一个在线最终报告。
- 普通请求仅 preflight started 接受，steering 仅 queued 接受；handled 普通清 prepared，steering 原执行不变。接受后 tool abort 不撤销已接受结果；未接受新 child 仅清本次新资源，既有 ask 恢复先前 state，不声称回滚扩展历史或外部副作用。
- 允许 child 独立打开/resume/继续聊天；新 histories 在普通扫描根之外，默认 discovery/picker/continue 不选取，显式 private-directory 查询/custom sessionDir 和 explicit file open 仍可用。存量默认目录 histories 可能仍被普通发现。不增加 owned-child guard、标记或索引，不改 mtime 隐藏。整树锁不覆盖宿主直接写 JSONL 的竞争。
- 新 metadata 不保存 model/thinking/cwd 的第二份副本，不新增持久 inbox、全局关系表或跨文件事务；优先简单 SDK 行为和有用日志。
- root void sendReport 成功仅表示 submitted，无 processed receipt；nested Execution 才有 SDK 处理 barrier。queued steering 已实际排队，取消不可撤回。不合作的异步 hook 未退出时 shutdown 保留 writer lock；symlink/realpath/header 校验不是 sandbox 或全部恶意路径竞争的防护。
- trust 检查必须发生在加载 external project resources 之前。
- `external_directory` 只是 cwd admission，不是 filesystem sandbox；文档中不得宣称其提供文件系统隔离。
- 改变公开行为时同步更新 README、规范及 CHANGELOG；遵守根目录的 patch/minor 版本规则。

## 测试要求

测试必须隔离用户状态：设置临时 `PI_CODING_AGENT_DIR`，不得在真实 `~/.pi/agent` 下创建 store、session、config 或 trust 数据。临时目录应在 `afterEach` 中清理。

修复缺陷时优先添加复现测试。根据改动覆盖以下相关边界：

- config precedence、home expansion、绝对/canonical/exact cwd 匹配；
- agent layer override、snapshot 稳定性、symlink escape、工具白名单/黑名单互斥及动态扩展重新注册后的过滤；
- direct ownership、depth/live/cycle limit、普通 ask 原子 busy；
- Spec 0002 的 Execution/steering 行为、具体拒绝诊断、单 report 与迟到 callback guards；
- child 等待、report delivery、恢复、interrupted run 和 writer lock；
- target resources/tools 更新、跨 cwd 隔离及 `Warning Cache Broke` 场景；
- UI FIFO、取消、timeout、无 UI fallback 和 status cleanup；
- pre-accept abort、post-accept contract 与 shutdown race。

在 monorepo 根目录运行：

```bash
pnpm --filter @yesifan/pi-subagents typecheck
pnpm exec biome check packages/pi-subagents
pnpm --filter @yesifan/pi-subagents test
pnpm --filter @yesifan/pi-subagents build
pnpm --filter @yesifan/pi-subagents pack --pack-destination /tmp
```

