# pi-subagents 文档

需求与实现规格统一存放在 `specs/`，架构决策保留在 `adr/`。新增、编辑或实施前阅读[规格索引与维护规则](specs/README.md)。

## 当前权威规格

1. [`domain-model.md`](domain-model.md) — 当前实体、所有权、生命周期和术语基准。
2. [`specs/yesifan-pi-subagents-spec.md`](specs/yesifan-pi-subagents-spec.md) — 顶部定义当前契约；下文 V1 大节/附录仅为历史资料，不是当前实现要求。
3. [`ADR-0003`](adr/0003-sdk-sessions-and-parent-metadata.md) — SDK 私有目录原生 history 与全局直接 parent 最小 metadata 的最终决定，替代 ADR-0001 相关存储决策。
4. [`ADR-0002`](adr/0002-native-widget-for-background-progress.md) — Pi 原生字符串 widget 展示后台进度。

领域模型统一术语；冲突时以权威规格的明确产品要求为准，先修正文档冲突再修改代码。

## 已完成的 Spec 0002（用户接受手测延期）

- [`Spec 0002：Subagent 提示优化与按父会话存储`](specs/0002-prompt-and-session-storage.md) — name 接口、role/history 路径展示、Execution/RootScope 与直接 parent 最小 metadata；不保存 runRecord/result/delivery、不续跑或补投。新 child 通过 `SessionManager.create(cwd, privateDir)` 写入 `<getAgentDir()>/subagents/histories`，不在普通 discovery/picker/continue 扫描根内。独立打开与显式 custom-directory discovery 仍允许；已有默认目录 history 保留已存实际路径、可 exact-path 恢复，不迁移、搬迁或删除，不添加 guard/marker/index 或改 mtime 隐藏。CLI/env/settings sessionDir 与 root override 不传播，PI_CODING_AGENT_DIR 仍有效。
- PR #11 尚未合并，按用户要求将最终目录/discovery 决策直接整合进原 Spec 0002/ADR-0003，不另立后续规格或虚构已发布的替代历史。Spec 0002 保持 completed，日期 `2026-10-08 / 2026-10-09`；用户明确接受实际交互 TUI/print 手测延期，手测未运行，不表示 §14 全部验收通过。
- 最新 privateDir 修订已有 typecheck、21 文件 / 245 测试、build、pack 成功记录。原 runtime 独立复审已解决此前 5 项问题；不将该旧复审冒充最新目录修订已复审，该审查由主代理记录。root submitted 无 processing receipt、queued 不可撤回、不合作 hook 保留关闭锁、路径检查非 sandbox 的边界继续有效。

## 待实施的异常退出通知

- [Spec 0003：异常退出也向主代理报告](specs/0003-terminal-exit-reporting.md) — 未开始实现；包含[现场证据](specs/evidence/0003-terminal-exit-2026-10-09.md)。不因本轮目录修订声称异常退出通知或诊断完善已完成。

## 历史实现设计

- [`ADR-0001`](adr/0001-project-local-subagent-storage.md) — 原项目本地单一权威 store 的真实背景、理由与历史记录，原文保留。
- [`需求 0001`](specs/0001-project-local-subagent-storage.md) — 原项目配置与私有存储要求；相关存储目标由 Spec 0002/ADR-0003 替代。
