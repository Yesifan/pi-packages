# Specifications

规格记录已约定行为、范围和实施决策。实施前检查状态，并同时阅读包内权威规格与关联 ADR。

## Index

| Spec | Purpose | Status | Execution time |
| --- | --- | --- | --- |
| [权威规格索引与历史 V1](yesifan-pi-subagents-spec.md) | 顶部定义当前 Spec 0002 契约及 Spec 0004 的 history/discovery 修订；V1 大节和附录仅为历史资料，不作为当前不变量。 | 当前索引 / 历史 V1（旧格式） | 未记录 |
| [0001 项目本地存储](0001-project-local-subagent-storage.md) | 原项目配置与私有存储要求，相关存储决定被 Spec 0002 和 ADR-0003 替代。 | 历史规格（旧格式） | 未记录 |
| [0002 提示与会话存储](0002-prompt-and-session-storage.md) | 实现/自动验证/独立复审完成；用户明确接受手动 TUI/print 验收延期并关闭规格，手测未运行。 | completed | 2026-10-08 / 2026-10-09 |
| [0004 私有 Child History](0004-private-child-history.md) | 仅替代 0002 新 history 位置与普通 discovery；独立打开允许，存量 exact-path 恢复不变、不迁移。 | completed | 2026-10-10 / 2026-10-10 |
| [0003 异常退出通知](0003-terminal-exit-reporting.md) | 扩展 0002 的在线终态报告覆盖，失败/取消/无最终文本也通知有效直接 parent；不补投旧 root，不处理 parent 自身失败导致的 child 中断通知。 | not-started | 2026-10-09 |

V1 与 0001 保留历史格式；其历史标签不代表本轮验收完成。0002 已补充统一 metadata，执行日期沿用首次文档提交日期；0002/0003/0004 以各自文件 metadata 为状态与日期唯一来源。0002 实现、自动验证与独立最终复审已完成；用户于 2026-10-09 明确要求先标记完成再提交 PR，接受在实际交互 TUI/print 手动验收前关闭规格，status 为 completed，日期格式为创建日期 / 完成日期。手测未运行、延期跟进，不宣称 §14 全部通过；0003 仍未开始。

## Maintenance

- 添加、重命名、移动、删除或变更规格状态/范围/执行日期时同步本索引；每项提供相对链接与一句目的说明。
- 新规格使用 `status: not-started | in-progress | completed` 和 `execution_time` metadata；完成日期格式为创建日期 / 完成日期。
- 实施时保持规格、代码和用户文档一致；未验证的改写不得标记 completed。
- 已完成规格不直接改写；后续变更新建规格并链接被扩展或替代的约定，同时在索引描述关系。
- 证据记录链接于对应规格，必要时保留摘要和指纹；原始会话、prompt、工具输出保存在本地受限且 Git 忽略的目录，不混入发布包。
