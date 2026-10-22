# 文档索引（docs/）

> pi-weixin-daemon 的机制 / 领域模型文档，建议按下面顺序阅读。

## 先读

- [`domain-model.md`](domain-model.md) —— 确认项目的 **术语基准**。

## 主题文档

- [`routing.md`](routing.md) —— 一条微信消息如何从真人到达 agent、回复如何回、会话如何生老病死。
- [`ilink-protocol.md`](ilink-protocol.md) —— 所依赖的微信 iLink 协议机制与官方参考实现的行为依据（登录产物、端点、媒体 CDN、monitor 容错、"两道门"、脱敏等）。**只引用、不发明。**
- [`../../../docs/reference-rules.md`](../../../docs/reference-rules.md) —— monorepo 根目录 `.refer/` 外部参考源码的来源、使用边界、引用与更新规则。
- [`LOCAL-DEPLOYMENT.md`](LOCAL-DEPLOYMENT.md) —— 本地部署 / 安装运行说明。

## 决策与需求存档

- 既定方案 / 待办需求：`requirements/`
- 架构决策记录（ADR）：`adr/`
- [需求 0010：项目默认会话与 CLI prompt](requirements/0010-project-session-cli-mcp.md) —— 已完成，验证记录见需求文档。
- [ADR-0008：共享默认会话与 CLI 回合来源](adr/0008-shared-default-session-cli.md) —— 默认/活动/运行实例、切换通知、reply 及同项目 CLI 交互来源。


