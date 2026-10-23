# 需求与规格索引

本目录记录已确认的行为、范围和实现决策。实施前请检查 spec 状态；历史需求沿用其原有状态记录。

## Spec 索引

| Spec | Purpose | Status | Execution time |
| ---- | ------- | ------ | -------------- |
| [0007：通过 CLI 向项目绑定用户广播通知](0007-project-cli-broadcast.md) | 向启用项目的绑定账号扫码用户直接发送微信通知，不经过 Pi。 | completed | 2026-10-01 / 2026-10-01 |
| [0008：微信语音仅传递转录文本](0008-voice-transcript-only.md) | 入站语音只传递微信转录及识别错误备注，空转录提示发送者，不再下载或携带音频。 | completed | 2026-10-12 / 2026-10-12 |
| [0009：澄清 RPC 空闲超时](0009-rpc-idle-timeout-clarification.md) | 更正 0007 的“总超时”措辞，保留普通 RPC 15 秒空闲超时与广播禁用客户端超时的行为。 | completed | 2026-10-23 / 2026-10-23 |
| [0010：CLI 配置所有权与轻量 daemon 生命周期](0010-account-removal-monitor-lifecycle.md) | CLI 统一写账号及项目控制配置，daemon 只读并协调应用；区分保存、运行同步和文件清理，调整旧 writer 及删除约定。 | completed | 2026-10-23 / 2026-10-23 |
| [0009：项目微信用户与消息投递实现简化](0009-project-weixin-user-simplification.md) | 删除 participant，统一以 account.userId 投递；调整 0006/0007 的收件范围约定。 | completed | 2026-10-21 / 2026-10-21 |
| [0010：项目默认会话与 CLI prompt](0010-project-session-cli-mcp.md) | 基于 0009 增加共享默认/活动会话、切换通知与 CLI prompt/reply，保留微信控制及独立回合广播；同项目本地 CLI 可互相回答。 | completed | 2026-10-21 / 2026-10-22 |
| [0011：运行时代码与状态精简](0011-runtime-simplification.md) | 统一 PiSdkHost 业务入口，分阶段删除闲置代码并合并重复状态/步骤；不含 0010 或 logout #23。 | completed | 2026-10-21 / 2026-10-21 |

并行分支留下的同号历史规格和 ADR 保留原编号及文件名，以完整标题和链接区分。默认会话与控制配置的存储职责整合见 [ADR-0011：项目默认会话运行状态独立存储](../adr/0011-project-runtime-state.md)，不改写上述已完成规格。

## 维护规则

- 为每个 spec 添加相对链接和一句用途说明；已有历史需求及 ADR 索引保留在下方。
- 实施 spec 时保持文档与代码一致，不将未实现能力描述为当前行为。
- 添加、重命名、移动、删除 spec，或修改用途、状态、执行时间后，同步更新索引；spec 元数据是状态和执行时间的唯一依据。
- `status` 使用 `not-started`、`in-progress`、`completed`；`execution_time` 为创建日期，完成时改为「创建日期 / 完成日期」。放弃的 spec 删除或归档。
- 完成后的 spec 不再修改；后续变更创建新的 spec，链接旧记录并说明替代、调整或扩展的约定，在索引中记录关系。已有历史需求保持原文，不为统一格式改写。

## 历史需求与决策记录

- [ADR-0007：CLI name 与控制面 account ID 分界](../adr/0007-account-name-id-boundary.md) —— 账号选择边界；其配置写入及删除流程由 ADR-0010 调整。**Accepted**
- [ADR-0008：RPC 消息边界](../adr/0008-rpc-message-framing.md) —— 请求换行分帧、响应 EOF 分帧及配套升级要求。**Accepted**
- [ADR-0009：账号登记与 monitor 生命周期分离](../adr/0009-registered-account-visibility.md) —— 保留登记与运行状态区分；删除顺序由 ADR-0010 调整。**Accepted**
- [ADR-0010：CLI 配置所有权与接收生命周期](../adr/0010-cli-control-ownership.md) —— CLI 写控制配置、daemon 只读同步、flock 协调及分阶段清理。**Accepted**
- [ADR-0011：项目默认会话运行状态独立存储](../adr/0011-project-runtime-state.md) —— 整合共享 default 与 CLI writer：daemon 写独立运行状态，旧配置只读兼容。**Accepted**

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
- [ADR-0009：共享默认会话与 CLI 回合来源](../adr/0009-shared-default-session-cli.md) —— 共享 default/active、CLI prompt/reply 与交互来源；调整 ADR-0002/0003/0005/0006，沿用 ADR-0007 投递模型。**Accepted，需求 0010 已完成**
- [ADR-0007：项目微信用户与统一投递](../adr/0007-project-weixin-users.md) —— 统一账号微信用户及精确 token 投递，移除动态参与者登记；调整 ADR-0006 的收件范围。**Accepted**
- [ADR-0008：Pi 业务单入口与内部适配精简](../adr/0008-pi-business-entry-simplification.md) —— PiSdkHost 业务单入口与内部适配精简；保留 ADR-0004 的 SDK 隔离原则。**Accepted**
