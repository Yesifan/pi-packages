# pi-subagents 文档

需求与实现规格统一存放在 `specs/`，架构决策保留在 `adr/`。

## 当前实现基线

1. [`domain-model.md`](domain-model.md) — 实体、值对象、所有权、生命周期和术语基准。
2. [`specs/yesifan-pi-subagents-spec.md`](specs/yesifan-pi-subagents-spec.md) — V1 产品行为、实现约束和验收要求。
3. [`adr/0002-native-widget-for-background-progress.md`](adr/0002-native-widget-for-background-progress.md) — 使用 Pi 原生字符串 widget 展示后台 subagent 进度。

领域模型用于统一术语；两者冲突时，以实现规格中的明确产品要求为准，并先修正文档冲突再修改代码。ADR 记录后续架构决策及对规格边界的补充解释。

## 待实施方案

- [`Spec 0002：Subagent 提示优化与按父会话存储`](specs/0002-prompt-and-session-storage.md) — 草案：提示词与报告优化、name 委派接口、Pi 会话历史与最小 child 元数据、全局按直接 parent 拆分存储；内存执行对象替代独立执行 ID，不保存历史 runRecord、不自动补投报告。已确认不兼容、不迁移旧 agents；目录配置和手动 resume 等仍有待确认项，不替代当前实现基线。

## 已实施的设计

- [`ADR-0001`](adr/0001-project-local-subagent-storage.md) — 使用项目本地的单一权威 subagent store，不复制 external descendant 分支。
- [`需求 0001`](specs/0001-project-local-subagent-storage.md) — 项目本地配置、自动初始化、fail-closed、路径安全和恢复验收要求。
