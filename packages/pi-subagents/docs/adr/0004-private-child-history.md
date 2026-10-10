# ADR-0004：新 Child History 使用普通 Discovery 之外的全局目录

- 状态：已接受并实施，自动验证通过；独立审查待主代理执行，实际交互 TUI/CLI 手测未运行。
- 关联：[Spec 0004](../specs/0004-private-child-history.md)、[Spec 0002](../specs/0002-prompt-and-session-storage.md)、[领域模型](../domain-model.md)。
- 替代：[ADR-0003](0003-sdk-sessions-and-parent-metadata.md) §1 的新 history 默认 cwd 分组位置与 §2 的新 history 普通 discovery 行为；旧 ADR 的理由、历史记录和其他决定保留。
- 不改变：独立打开/resume/继续聊天、每 parent metadata、整树锁、exact-path 恢复、项目配置/trust、角色 snapshot、Execution/RootScope、报告和更早 legacy store 的不兼容边界。

## 背景

SDK 默认 cwd 分组使 child history 进入普通 picker/discovery/continue 候选。用户要求仅停止新 histories 的普通发现，没有批准禁止独立打开或迁移旧数据。需要小范围、可回滚且保留 SDK 原生 JSONL 的方案。

## 决策

新 child 通过 public `SessionManager.create(cwd, privateDir)` 分配历史，privateDir 为 `<getAgentDir()>/subagents/histories`，不在普通 `<agentDir>/sessions` 扫描根内。统一 directory 不追加 cwd 分组；目标 cwd 仍存于 SDK header。忽略 CLI/env/settings sessionDir override 和 root override，PI_CODING_AGENT_DIR 仍决定 agentDir。

保持有效 header 的 0600 排他预创建/open 适配，检查实际 directory ancestor chain，无 symlink/non-directory；本次新建目录设为 0700，既有目录权限保留。不检查无关普通 sessions groups，不改 history mtime。

不添加 discovery filter、index、owner marker 或独立打开 guard。默认 list/listAll/continue 不包含新 histories；显式 private-directory discovery、custom sessionDir 和 explicit file open 仍允许，不能宣称安全隔离或插件外访问限制。独立写 JSONL 的竞争仍不受整树 metadata lock 保护。

存量 Spec 0002 history 与 metadata 原样保留：不搬迁、删除、marker backfill 或 path 重写；其 exact-path 恢复不变，存量默认目录文件可能继续出现在普通 discovery。新旧 history 可共存；更早 legacy stores 的排除规则不变。

## 理由与取舍

目录隔离直接利用锁定 Pi 1.0.0 的 discovery 扫描范围，避免 hook 生命周期与全局关系扫描。SDK 仍负责文件名/header/history/context，metadata 无 schema 变化。所有新 child 共用一个 private directory，无需重实现 cwd 编码或目录索引。显式发现和独立打开不是缺陷，而是本次批准的兼容边界。

用户工具参数、结果和生命周期未变，本项作为 patch 行为增强；当前功能 PR 已有 Spec 0002 的 BREAKING minor changeset，更新其描述即可，不单独制造冲突的版本记录。

## 验证

见 Spec 0004 的隔离真实 SDK 测试与验证记录；API discovery 验证不等于实际交互 TUI/CLI 手测。本 ADR 不宣称 Spec 0003 已实施。
