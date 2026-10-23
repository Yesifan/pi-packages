# Project Overview

`@yesifan/pi-session` 是一个 Pi 扩展，提供 session 引用补全、授权 cwd 历史正文搜索和在原会话中运行的轻量后台提问。实现基线为 `pnpm-workspace.yaml` 中 catalog 锁定的 Pi SDK 版本；涉及 SDK 行为时，以该版本的类型和源码为准。

先阅读 [`README.md`](README.md) 了解当前公开行为，再阅读[规格索引与维护规则](docs/specs/README.md)。原始约定见 [pi-session 规格](docs/specs/pi-session.md)，跨模式及异步提示由[后续规格](docs/specs/pi-session-cross-mode.md) 扩展；后续规格未明确替代的行为继续遵循原规格。涉及 SDK 升级时同时核对[全仓升级规格](../../docs/specs/pi-1.4-upgrade.md)。

修改公开语义、授权或生命周期边界前先核对规格；发现未被明确替代的冲突时暂停并与用户讨论，不自行选择新语义。包内规格统一放在 `docs/specs/` 并同步索引及相关引用。已完成规格不改写历史约定，后续行为变更新建规格并说明扩展或替代关系。

## 核心模型与不变量

- `@s:` 查找当前 cwd 的有名会话，`@as:` 查找 SDK 标准存储中可发现的所有项目有名会话；不扫描任意自定义存储或 subagent 私有目录。
- 补全选中后只插入保留前缀与完整 session ID，不提交输入、不注入会话正文。无匹配不回退到文件搜索；非 session 补全完整委托原 provider。
- 引用展开按 input source 决定：`interactive` 和 `rpc` 展开，`extension` 原样通过，不按运行 mode 筛选。未知 ID 或枚举失败时保留输入，通知失败不能阻断提交。
- 两个工具在 TUI、RPC、JSON、print 均注册，执行要求调用方生命周期已启动且仍有效。runtime 初始化与补全注册分离；无 UI 或补全失败不能禁用工具，不将 `hasUI` 或 no-op provider 注册当作补全 UI 能力。
- `search-session` 和 `ask-session` 默认使用 caller cwd；其他 cwd 必须在 `<caller-cwd>/.pi/pi-session/setting.json` 的 `externalDirectories` 中授权。工具 cwd 必须绝对化，经 realpath 后精确匹配，不按路径前缀授权子目录；枚举或运行前验证授权并核实实际 cwd。
- cwd 授权不是文件系统沙箱，也不限制 `@as:` 名称发现；发现名称不代表获准搜索正文或运行会话。
- 搜索使用 SDK 聚合的 user/assistant 文本，按大小写不敏感子串匹配，以换行截取片段；不承诺消息边界、行号或 toolResult/thinking 搜索。保留结果数量、片段长度限制及明确的截断标记。
- `ask-session` 仅接受指定授权 cwd 内的完整 session ID，拒绝当前 caller session。在原持久化会话继续执行，不分叉、不复制为私有 history、不切换编辑器会话。
- 目标使用目标 cwd 的默认 SDK 环境和已存历史，不继承 caller 的 trust、工具、UI 或其他覆盖配置，不承诺复现 CLI 专属加载能力。
- 仅维护本扩展实例的活动任务内存映射；普通 ask 在异步加载前占用 ID，重复调用立即 busy，不排业务队列。完成或失败后清理并释放，后续 ask 重新加载原会话。
- `steer: true` 仅操作本实例已加载且 streaming 的活动任务，不创建新执行或独立报告。`handled` 不等于已排入 steering、执行完成或原任务仍活跃。
- accepted 不代表完成；报告仅在 caller 生命周期仍存活时自动投递。等待期间不得轮询、重做或重新委派已接受任务；后续提问复用报告中的完整 ID。
- 切换、reload 或退出时关闭任务并抑制迟到报告；旧 runtime 不得向新生命周期投递。已接受任务独立于原工具调用取消信号，但仍受 caller shutdown 约束。

## 主要目录与模块

- `src/index.ts`：扩展入口、工具注册、input 处理、补全注册及 caller 生命周期绑定。
- `src/references.ts`：session 引用解析、补全 provider 包装与输入展开。
- `src/sessions.ts`：cwd 授权、session 发现与正文搜索。
- `src/tasks.ts`：后台 session 加载、活动任务、ask/steer、报告与资源清理。
- `test/`：Vitest 离线测试，包含真实锁定 SDK 的隔离集成验证。
- `docs/specs/`：内部规格及索引，不随 npm 包发布。

## 实现边界

- 保持轻量会话工具定位，不照搬 pi-subagents 的角色、父子任务树、私有 history、持久化 metadata 或整树锁。
- 不增加跨实例占用检测或互斥锁；多个实例打开同一 session 可能产生分支和陈旧上下文，不宣称能够安全串行化外部写入。
- 不增加 keep-alive、持久队列、跨重启恢复或历史报告补发。后台仍使用 print mode 和 extension source；短命 caller 或嵌套 ask 的父任务结束可能提前关闭后台任务，不保证全部后代完成。
- 不新增祖先、循环或委派深度检查；如需改变这些边界，先确认需求并更新规格。
- 报告经 caller 模型处理，不是向终端用户或微信直接可靠投递；保留工具结果第一段 JSON、结构化 details 与后续提示的合同。
- 优先复用 SDK session 枚举、解析和定位能力，不自建 JSONL 解析器、正文索引或空闲 session 缓存。
- 修改公开行为时同步 README、相关规格并按根规则添加 changeset，不在功能改动中手动改版。

## 测试与发布要求

测试必须使用隔离临时 session 存储；需要 agentDir 时设置临时 `PI_CODING_AGENT_DIR`，不得读写真实用户会话、配置或 trust 状态。测试结束清理临时目录，默认不请求付费模型。

修复缺陷优先添加复现测试，按改动覆盖以下边界：

- 补全范围、名称变化、自动建议与 Tab、保留前缀无匹配、过期查询及非 session provider 委托；
- 多引用、空格名称与路径、未知 ID、枚举失败及完整 ID 插入到提交展开的转换；
- 默认/空 cwd、绝对路径、home 展开、canonical 精确授权和实际 cwd 校验；
- 搜索排序、片段截取、数量与长度限制及截断标记；
- 原会话持久化、完整 ID 定位、自我提问拒绝、busy、加载失败后重试及 steer/handled 语义；
- 四模式工具可用性、source 输入矩阵、no-op/异常补全与通知、幂等启动、启动前和关闭后拒绝执行；
- caller shutdown、资源清理、迟到报告隔离及状态提示不改变 JSON/details。

真实 SDK 离线测试不能冒充完整 TUI、RPC 子进程协议或嵌套模型端到端验收；记录实际验证范围，不复制历史测试数量作为当前通过结果。

在 monorepo 根目录运行：

```bash
pnpm --filter @yesifan/pi-session typecheck
pnpm --filter @yesifan/pi-session lint
pnpm --filter @yesifan/pi-session test
pnpm --filter @yesifan/pi-session pack --pack-destination /tmp
```

按根约定在代码编辑阶段后及时使用 Biome 格式化相关文件。包直接发布 TypeScript 源码，无 build 步骤；保留 `package.json` 的 `files` allowlist，检查 tarball 仅包含运行时源码及用户所需文件，不包含测试、开发配置、内部规格或 `AGENTS.md`。扩展源码修改后需 reload 或启动新会话验证，当前已加载实例可能仍运行旧代码。
