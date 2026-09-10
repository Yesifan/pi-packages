## 需求与决策记录

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
