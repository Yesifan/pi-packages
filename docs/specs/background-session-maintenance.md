# 后台会话与子代理报告

---
status: completed
execution_time: "2026-11-18 / 2026-11-18"
---

适用于 pi-session 和 pi-subagents，扩展 [pi-session 跨模式约定](../../packages/pi-session/docs/specs/pi-session-cross-mode.md) 与 [子代理终态报告约定](../../packages/pi-subagents/docs/specs/0003-terminal-exit-reporting.md)。

- #38：新建和恢复的 child 绑定 print，保留 root UI 代理。后台 prompt 和 steer 使用 extension source。
- #54：报告正文最多展示 max_live_agents + 4 个直接子代理。先保留运行项，剩余位置给最近活动的历史项。入选项按最近活动倒序展示，同时间按全名排序。已接受任务和消息结束刷新活动时间，恢复使用已加载历史的最近消息或 header 时间。工具快照仍提供完整名单。
- 两个扩展从本次请求起点之后的活动分支提取最终 assistant 文本，过滤 commentary。截断和缺少最终文本明确标为不完整；pi-session 保留既有报告字段。
- pi-session 在加载目标资源前核对实际打开的会话 ID、canonical cwd 和路径。caller 关闭时先阻止报告并发起取消；输入 hook 恢复并启动后再次请求 abort。已开始的 SDK 调用结束后发出 shutdown 并释放会话。不合作的 hook 仍可能延长关闭。
- 验证使用现有离线测试、类型检查、构建和 tarball 检查，以及针对报告和关闭行为的独立验证。

隔离的 Pi 1.5.2 打包安装验证：新建和恢复均显示 print，有 UI 时确认成功，无 UI 时返回 fallback。暂停输入 hook 并关闭 caller 后，只执行一次 shutdown，未调用模型网络或发送报告。报告定向验证使用 20 个直接子代理和并发上限 8，正文缩至 12 条，保留最早的运行项，复用项回到首位，工具快照仍有 20 条。
