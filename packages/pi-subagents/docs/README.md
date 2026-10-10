# pi-subagents 文档

需求与实现规格统一存放在 `specs/`，架构决策保留在 `adr/`。新增、编辑或实施前阅读[规格索引与维护规则](specs/README.md)。

## 当前权威规格

1. [`domain-model.md`](domain-model.md) — 实体、值对象、所有权、生命周期和术语基准。
2. [`specs/yesifan-pi-subagents-spec.md`](specs/yesifan-pi-subagents-spec.md) — 顶部定义当前契约与优先级；下文 V1 全部大节/附录为历史资料，不是当前实现要求。
3. [`adr/0002-native-widget-for-background-progress.md`](adr/0002-native-widget-for-background-progress.md) — 使用 Pi 原生字符串 widget 展示后台 subagent 进度。

领域模型用于统一术语；两者冲突时，以实现规格中的明确产品要求为准，并先修正文档冲突再修改代码。ADR 记录后续架构决策及对规格边界的补充解释。

## 新 Child History 与普通 Discovery

- [Spec 0004：新 Child History 不参与普通 Pi 发现](specs/0004-private-child-history.md) / [ADR-0004](adr/0004-private-child-history.md) — 新 child 使用 `<getAgentDir()>/subagents/histories`，默认 discovery/picker/continue 不选取；显式目录查询与独立打开仍允许。仅替代 Spec 0002 / ADR-0003 的新 history 位置与普通发现行为，不添加 guard/index/marker，不迁移、删除或搬迁存量 history，exact-path 恢复保持不变。

## 已完成的 Spec 0002（用户接受手测延期；以下为该轮记录）

- [`Spec 0002：Subagent 提示优化与按父会话存储`](specs/0002-prompt-and-session-storage.md) — 当前工作区已实现全部 runtime 重写：name 接口、role 列表/history 路径报告、SDK 默认 cwd 分组 history、全局直接 parent 最小 metadata、Execution/RootScope 对象 guards，不保存 runRecord/result/delivery、不补投。D2/D3 接受独立打开与原生 discovery，无 owned-child guard/索引；D4 不继承 root CLI 或 CLI/env/settings sessionDir，PI_CODING_AGENT_DIR 仍有效；D6 handled 未接受，普通清 prepared、steering 原执行不变。旧 agents 不兼容、不迁移，旧文件不删除。主代理独立重跑当前 typecheck、21 个文件 / 241 项测试通过，runtime 修正后 pack 成功；独立最终复审确认此前 5 项问题已解决、无新具体缺陷。2026-10-09 用户明确接受在实际交互 TUI/print 手测前关闭规格，status 为 completed；手测实际未运行、延期跟进，不等于 §14 全验收。root 投递只证明 submitted，无 processing receipt；queued 取消不可逆、不合作 hook 会使 shutdown 保留锁、路径校验不是 sandbox，详见规格验证边界。
- [`ADR-0003`](adr/0003-sdk-sessions-and-parent-metadata.md) — 已接受的存储与恢复决策，新 history 位置与普通发现部分后由 ADR-0004 替代；其余决定保留。替代 ADR-0001 的相关存储决定；保留项目配置与 trust，优先简单 SDK 行为和有用日志。

## 待实施的异常退出通知

- [Spec 0003：异常退出也向主代理报告](specs/0003-terminal-exit-reporting.md) — 未开始实现；失败、取消或无最终正文时也通知有效直接 parent，明确关闭抑制与投递失败，延续不跨重启补投的边界。包含[现场证据](specs/evidence/0003-terminal-exit-2026-10-09.md)。

## 历史实现设计

- [`ADR-0001`](adr/0001-project-local-subagent-storage.md) — 原项目本地单一权威 store 的理由和历史实现记录，相关存储决定已被 ADR-0003 替代。
- [`需求 0001`](specs/0001-project-local-subagent-storage.md) — 项目本地配置、自动初始化、fail-closed、路径安全和恢复验收要求。
