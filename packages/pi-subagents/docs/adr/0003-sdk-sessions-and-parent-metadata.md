# ADR-0003：SDK 默认会话历史与按直接 parent 保存的最小元数据

- 状态：已接受并实施，独立最终复审已完成；用户于 2026-10-09 接受手动 TUI/print 验收延期并将 Spec 0002 标记 completed。手测实际未运行，不代表全部验收通过。
- 关联：[Spec 0002](../specs/0002-prompt-and-session-storage.md)、[实现规格](../specs/yesifan-pi-subagents-spec.md)、[领域模型](../domain-model.md)。
- 替代：[ADR-0001](0001-project-local-subagent-storage.md) 的 D1/D2/D4/D5 中运行数据位置、项目 runtime 初始化、完整树单文件 scope 与相对 history 路径决定。保留其背景、理由与历史实现记录，不覆盖旧理由。
- 不改变：ADR-0001 D3 的 caller-local 项目配置、root-only limits、trust 及单一事实来源原则；[ADR-0002](0002-native-widget-for-background-progress.md) 的原生进度 widget。

## 背景

ADR-0001 为项目生命周期一致而把整树 metadata、runs、reports 和 JSONL 放入 root 项目。该选择带来项目写入/Git ignore 约束，也维护了一套 Pi 历史已有信息的副本。新需求明确选择更简单的 SDK 行为、name 接口和最小恢复信息，接受 BREAKING 与较小恢复承诺。

## 决策

### 1. Pi SDK 保存 history，本包只保存直接 children

child 使用 `SessionManager.create(cwd)` 的内建默认 cwd 分组目录。`PI_CODING_AGENT_DIR` 仍决定 SDK agentDir；不读取或传播 CLI `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、global/project settings 的 `sessionDir`，不继承 root CLI override。root 已有会话不搬迁，不手写 cwd 编码。为建立有效 0600 history 所需的适配使用 SDK 给出的实际路径，不重实现 CLI 优先级。

本包在 `<getAgentDir()>/subagents/sessions/<sessionKey>.json` 按直接 parent session 保存 name-keyed children。A→B→D 时，A 文件仅含 B，B 文件仅含 D；不保存项目镜像或第二份关系总表。记录包含 Pi ID/实际绝对文件身份、完整角色 snapshot 与最新 state；cwd/model/thinking/conversation 从 Pi history 恢复，不保存 runRecord、结果副本或 delivery 状态。

同一原 root 的整树 writer lock 位于 `<getAgentDir()>/subagents/locks/<rootKey>/`；同文件更新串行并原子替换，不添加跨文件事务。ID+file 派生 key 保留 exact root 隔离。name 仅在直接 parent 下唯一，不参与路径生成。

### 2. 接受原生独立打开与 discovery（D2/D3）

允许用户独立打开/resume child、继续聊天和使用普通 Pi 管理。不添加 owned-child guard、标记或索引；独立打开不授予原 root 树的 metadata/ask 权限。整树锁只保护本包 metadata 管理，不阻止宿主直接写 child JSONL，不保证此类并发无冲突。

接受 SDK 原生 discovery、picker 和 continue 行为，不过滤 child、不改 mtime 隐藏。header-only history 也可能可见；同 cwd child 可能成为 recent/continue 候选。不同 cwd 默认分组，实际可见性由宿主扫描目录决定。

### 3. 最小生命周期与 handled（D6）

使用内存 Execution/RootScope 对象身份保护执行、迟到 callback 和直接 parent 报告路由，不生成本包 agent/run/mount/report ID 或 epoch。保留 busy 原子占用、等待 child/report 的处理 barrier、在线至多一次最终报告和 shutdown 清理。

preflight 普通请求仅 `started` 接受；steering 仅 `queued` 接受。`handled` 明确返回未启动/未排队诊断：普通请求清理未接受 prepared，新 child 仅清本次准备资源，既有 ask 恢复先前 state；steering 保持原 Execution 不变，不 abort 原任务。不声称撤销 extension 历史或外部副作用，不无条件 abort extension 自行启动的处理。

恢复只恢复身份、关系、snapshot 与 history；遗留 running 标 interrupted，不续跑、不补投旧报告。prepared crash 恢复与 SDK 非预期 disposition 按 Spec 0002 的具体边界处理。

### 4. 无兼容迁移

新实现不读取、转换、双写或 fallback 到旧 project store 或旧 agentDir store；不保留 ask.id alias。旧 agents 不进入新 registry、不能继续 ask，旧文件不自动删除。项目配置仍在 `.pi/subagents/setting.json`，缺失用默认值；配置读取不再强制生成项目 sessions/.gitignore。

## 理由与取舍

- 用 Pi history 承担它已有的 cwd/model/thinking/conversation 信息，减少副本和恢复对账。
- 保留 caller-local 配置、角色 snapshot、直接所有权、root limits 和整树锁，不增加全局关系框架。
- 优先简单 SDK 默认行为和有用诊断日志，延后过度边缘策略。
- history 不再随项目删除；项目移动/cwd 消失仍不会自动重定位。
- 接受 child 进入原生 picker/continue，以及用户直接打开造成的 history 并发风险。
- 接受保存 idle 后投递前退出时在线报告丢失；history 可读但不承诺重启补投。
- 新全局 store 不可写时明确失败，不退回旧布局；全局目录仍含敏感数据，需要正常权限与备份策略。

## 实施与验证

当前工作区已实施本 ADR 与 Spec 0002 的 runtime 重写，不再使用旧 ID/project-local store。主代理已独立重跑当前 typecheck 与 21 个文件 / 241 项测试通过，runtime 修正后 pack 成功；独立最终复审确认此前 5 项问题已解决、未发现新的具体缺陷。实际交互 TUI/print 手动验收未运行，自动验证/复审完成不等于全部规格/真实 CLI 验收完成。当前契约以 Spec 0002 为准，旧 V1 章节仅为历史资料。测试使用临时 `PI_CODING_AGENT_DIR`；model/thinking 恢复、preflight disposition、SDK prompt 取消、报告拒绝和处理顺序已纳入自动验证/复审；discovery 与 UI 等实际交互验收仍需手测。root 无 processing receipt、已 queued 不可撤回、不合作 hook 保留关闭锁、路径检查非 sandbox 的边界按 Spec 0002 保留。[Spec 0003](../specs/0003-terminal-exit-reporting.md) 的异常退出通知扩展未开始，不在本次实施声明中。
