# 文档索引（docs/）

> pi-weixin-daemon 的机制 / 领域模型文档，建议按下面顺序阅读。

## 先读

- [`domain-model.md`](domain-model.md) —— 确认项目的 **术语基准**。

## 主题文档

- [`routing.md`](routing.md) —— 一条微信消息如何从真人到达 agent、回复如何回、会话如何生老病死。
- [`ilink-protocol.md`](ilink-protocol.md) —— 所依赖的微信 iLink 协议机制与官方参考实现的行为依据（登录产物、端点、媒体 CDN、monitor 容错、"两道门"、脱敏等）。**只引用、不发明。**
- [`../../../docs/reference-rules.md`](../../../docs/reference-rules.md) —— monorepo 根目录 `.refer/` 外部参考源码的来源、使用边界、引用与更新规则。
- [`../../../docs/local-install.md`](../../../docs/local-install.md#pi-weixin-daemon) —— 本地开发版本安装、构建及 systemd 用户服务操作。
- [`../README.md`](../README.md#安装) —— 安装要求、发布包安装及使用说明。

## 决策与需求存档

- [需求与规格索引及维护规则](requirements/README.md) —— 同号历史记录按完整标题和链接区分，保留原编号。
- [需求 0009：澄清 RPC 空闲超时](requirements/0009-rpc-idle-timeout-clarification.md) —— 普通 RPC 空闲超时与广播等待行为。
- [需求 0009：项目微信用户与消息投递实现简化](requirements/0009-project-weixin-user-simplification.md) —— 绑定账号 user 收件范围替代参与者注册表。
- [需求 0010：CLI 配置所有权与轻量 daemon 生命周期](requirements/0010-account-removal-monitor-lifecycle.md) —— 控制配置 writer、锁、保存与同步及清理分离。
- 架构决策记录（ADR）：`adr/`
- [ADR-0007：CLI name 与控制面 account ID 分界](adr/0007-account-name-id-boundary.md) —— CLI 名称选择和内部账号 ID 边界。
- [ADR-0007：项目微信用户与统一投递](adr/0007-project-weixin-users.md) —— 账号用户与精确 token 投递。
- [ADR-0008：RPC 消息边界](adr/0008-rpc-message-framing.md) —— 请求与响应分帧。
- [ADR-0009：账号登记与 monitor 生命周期分离](adr/0009-registered-account-visibility.md) —— 登记和运行状态区分；后续删除约定见 ADR-0010。
- [ADR-0010：CLI 配置所有权与接收生命周期](adr/0010-cli-control-ownership.md) —— CLI 写控制配置、daemon 只读及 flock 生命周期协调。
- [ADR-0011：项目默认会话运行状态独立存储](adr/0011-project-runtime-state.md) —— daemon 专属 `projects.json` 与 CLI 控制配置分离，整合共享 default 和唯一 writer。
- [需求 0010：项目默认会话与 CLI prompt](requirements/0010-project-session-cli-mcp.md) —— 已完成，验证记录见需求文档。
- [需求 0011：运行时代码与状态精简](requirements/0011-runtime-simplification.md) —— 已完成，保留 SDK 单入口和现有业务行为。
- [ADR-0008：Pi 业务单入口与内部适配精简](adr/0008-pi-business-entry-simplification.md) —— 删除冗余门面，保留必要 SDK 内部适配。
- [ADR-0009：共享默认会话与 CLI 回合来源](adr/0009-shared-default-session-cli.md) —— 默认/活动/运行实例、切换通知、reply 及同项目 CLI 交互来源。
