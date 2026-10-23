# Specifications

规格记录已约定行为、范围和实施决策。实施前检查状态；未开始的规格不代表已发布能力。

## Index

| Spec | Purpose | Status | Execution time |
| --- | --- | --- | --- |
| [Pi 1.4.0 全仓升级](pi-1.4-upgrade.md) | 原版 SDK 升级、官方 services/恢复/steering 替换、submitted 与串行清理合同、daemon UI 类型及四包回归。 | completed | 2026-10-22 / 2026-10-22 |

## 归属与包内索引

单包规格放在 `packages/<pkg>/docs/specs/`，由该目录的 `README.md` 维护索引；本目录仅保存跨包或全仓规格。跨运行模式不等于跨包，应按实际涉及的包确定归属。根索引只提供包内索引入口，不重复登记其规格条目、状态或执行日期；包内已有规格继续遵循对应包的索引和规则。

- [pi-session 规格索引](../../packages/pi-session/docs/specs/README.md)
- [pi-subagents 规格索引](../../packages/pi-subagents/docs/specs/README.md)

## Maintenance

- 新增、重命名、移动、删除规格或修改其范围、状态、执行日期时，同步所属索引；每项提供相对链接与一句目的说明。新增包内索引时在根索引登记入口。
- 移动规格时同步所有引用和相关索引；允许为迁移修正已完成规格的相对链接，但不改变其约定、状态、执行日期和验收记录。
- metadata 使用 `status: not-started | in-progress | completed`；`execution_time` 记录创建日期，完成时改为 `创建日期 / 完成日期`。迁入的未完成规格保留原创建日期。
- metadata 是状态和日期的唯一来源；实施时保持规格、代码及用户文档一致，未经验证不得标记 completed。
- 已完成规格保持不变；后续变更新建规格，链接并说明替代或扩展的约定，同时在索引记录关系。
- 已有未完成同主题规格优先整合最新确认，不将尚未决定的细节写成已确认行为。
