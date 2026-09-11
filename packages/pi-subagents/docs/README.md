# pi-subagents 文档

## 当前实现基线

1. [`domain-model.md`](domain-model.md) — 实体、值对象、所有权、生命周期和术语基准。
2. [`specs/bykwp-pi-subagents-spec.md`](specs/bykwp-pi-subagents-spec.md) — V1 产品行为、实现约束和验收要求。
3. [`adr/0002-native-widget-for-background-progress.md`](adr/0002-native-widget-for-background-progress.md) — 使用 Pi 原生字符串 widget 展示后台 subagent 进度。

领域模型用于统一术语；两者冲突时，以实现规格中的明确产品要求为准，并先修正文档冲突再修改代码。ADR 记录后续架构决策及对规格边界的补充解释。

## 已实施的设计

- [`ADR-0001`](adr/0001-project-local-subagent-storage.md) — 使用项目本地的单一权威 subagent store，不复制 external descendant 分支。
- [`需求 0001`](requirements/0001-project-local-subagent-storage.md) — 项目本地配置、自动初始化、fail-closed、路径安全和恢复验收要求。
