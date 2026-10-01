# 需求与规格索引

本目录记录已确认的行为、范围和实现决策。实施前请检查 spec 状态；历史需求沿用其原有状态记录。

## Spec 索引

| Spec | Purpose | Status | Execution time |
| ---- | ------- | ------ | -------------- |
| [0007：通过 CLI 向项目绑定用户广播通知](0007-project-cli-broadcast.md) | 向启用项目的绑定账号扫码用户直接发送微信通知，不经过 Pi。 | completed | 2026-10-01 / 2026-10-01 |

## 维护规则

- 为每个 spec 添加相对链接和一句用途说明；已有历史需求及 ADR 索引保留在下方。
- 实施 spec 时保持文档与代码一致，不将未实现能力描述为当前行为。
- 添加、重命名、移动、删除 spec，或修改用途、状态、执行时间后，同步更新索引；spec 元数据是状态和执行时间的唯一依据。
- `status` 使用 `not-started`、`in-progress`、`completed`；`execution_time` 为创建日期，完成时改为「创建日期 / 完成日期」。放弃的 spec 删除或归档。
- 完成后的 spec 不再修改；后续变更创建新的 spec，链接旧记录并说明替代、调整或扩展的约定，在索引中记录关系。已有历史需求保持原文，不为统一格式改写。

## 历史需求与决策记录

- [`requirements/0001-session-trust-fix.md`](requirements/0001-session-trust-fix.md) —— 需求：修复 `PiRuntime` 的 project trust 解析（对齐官方文档）。**✅ 已完成（`0.5.3`，commit `3c4c226`，涉及 ADR-0001/0002）**
- [`adr/0001-session-project-trust-resolution.md`](adr/0001-session-project-trust-resolution.md) —— ADR-0001：会话项目信任解析采用 pi 官方完整决策链。**✅ Accepted（`3c4c226`）**
- [`adr/0002-session-lazy-creation-and-status.md`](adr/0002-session-lazy-creation-and-status.md) —— ADR-0002：会话懒创建 + status 暴露 trust + `/new` 不空转。**✅ Accepted（`3c4c226`）**
- [`requirements/0002-pi-host-compatibility.md`](requirements/0002-pi-host-compatibility.md) —— 需求：Pi host 兼容性重构 —— 架构优先、五阶段（对齐 pi 0.84.4 host 语义）。**✅ 已完成（`0.6.0`，涉及 ADR-0003/0004）**
- [`adr/0003-pi-host-compatibility-policies.md`](adr/0003-pi-host-compatibility-policies.md) —— ADR-0003：Pi host 兼容性策略（per-project fail-closed / cwd 固定 + accounts 重建 / idle 真关闭 / 微信 slash 语义 / UI 降级 / trust 双字段 / send_file 无边界）。**✅ Accepted（`0.6.0`）**
- [`adr/0004-layering-and-dependency-direction.md`](adr/0004-layering-and-dependency-direction.md) —— ADR-0004：分层与依赖方向（PiSdkHost / SessionController / ProjectController，只有 `src/pi/` import SDK）。**✅ Accepted（`0.6.0`）**
- [`requirements/0003-weixin-slash-session-controls.md`](requirements/0003-weixin-slash-session-controls.md) —— 需求：微信模型、思考强度、恢复、重载和显式 prompt 命令。**✅ 已完成（`0.6.3`，涉及 ADR-0005）**
- [`adr/0005-weixin-slash-session-controls.md`](adr/0005-weixin-slash-session-controls.md) —— ADR-0005：微信 Slash 会话控制与交互仲裁。**✅ Accepted（`0.6.3`）**
- [`requirements/0004-weixin-agent-progress-tool.md`](requirements/0004-weixin-agent-progress-tool.md) —— 需求：为长任务提供只回当前发起者的 Agent 中间进度工具。**✅ 已完成（`0.6.4`）**
- [`requirements/0005-weixin-typing-keepalive-and-broadcast.md`](requirements/0005-weixin-typing-keepalive-and-broadcast.md) —— 需求：Pi turn 期间每 5 秒续发微信正在输入状态，并广播给项目参与者。**✅ 已完成（`0.6.7`）**
- [`0006-session-wide-agent-replies.md`](0006-session-wide-agent-replies.md) —— 需求：活动 Pi 会话的所有来源 Agent 回合统一广播成功最终文本。**✅ 已完成（`0.6.11`）**
- [`ADR-0006`](../adr/0006-session-wide-agent-reply-routing.md) —— Pi 会话级统一路由 Agent 最终回复，不依赖具体扩展。**Accepted**
