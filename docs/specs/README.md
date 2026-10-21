# Specifications

规格记录已约定行为、范围和实施决策。实施前检查状态；未开始的规格不代表已发布能力。

## Index

| Spec | Purpose | Status | Execution time |
| --- | --- | --- | --- |
| [pi-session](pi-session.md) | Session 名称引用补全、授权 cwd 正文搜索及通过完整 ID 继续原会话的轻量后台对话。 | not-started | 2026-10-08 |

包内既有规格仍由其自身索引维护：[pi-subagents 规格索引](../../packages/pi-subagents/docs/specs/README.md)。本目录不迁移或重复维护包内历史规格。

## Maintenance

- 新增、重命名、移动、删除规格或修改其范围、状态、执行日期时，同步本索引；每项提供相对链接与一句目的说明。
- metadata 使用 `status: not-started | in-progress | completed`；`execution_time` 记录创建日期，完成时改为 `创建日期 / 完成日期`。迁入的未完成规格保留原创建日期。
- metadata 是状态和日期的唯一来源；实施时保持规格、代码及用户文档一致，未经验证不得标记 completed。
- 已完成规格保持不变；后续变更新建规格，链接并说明替代或扩展的约定，同时在索引记录关系。
- 已有未完成同主题规格优先整合最新确认，不将尚未决定的细节写成已确认行为。
