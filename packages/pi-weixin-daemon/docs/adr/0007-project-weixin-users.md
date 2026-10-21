# ADR-0007：项目微信用户与统一投递

- 状态：已采纳（Accepted）
- 日期：2026-10-21
- 关联：[需求 0009](../requirements/0009-project-weixin-user-simplification.md)、[ADR-0004](0004-layering-and-dependency-direction.md)、[ADR-0006](0006-session-wide-agent-reply-routing.md)、[协议核查 §11](../ilink-protocol.md#11-扫码身份与入站发送者核查2026-10-21)

## 背景

此前 CLI broadcast 使用绑定账号的登录用户，Agent 广播使用本进程观察到的 participant。后者使广播范围取决于用户是否发言及 daemon 是否重启。两套收件人模型也让文本、文件、UI 等出口的身份和 token 关联难以保持一致。

登录响应的 `ilink_user_id` 与入站 `from_user_id` 是分别取得的数据。外部 adapter 的客户端策略不证明服务端只允许扫码用户发送消息，也不证明两种 ID 永远相等。

## 决策

1. 项目微信用户来自绑定账号的 `account.userId`，删除 Participant/ParticipantRegistry，不新增联系人实体、登记存储或等价的观测发送者缓存。保留账号存储和 RPC 的 `userId` 字段。
2. 入站仍按 `accountId → projectId` 路由，保留消息类型、绑定、启用和运行状态检查；不增加 sender 白名单或 `senderId === account.userId` gate。不同 sender 的消息仍可按现有规则进入 Pi。
3. 出站统一使用账号登录用户和精确 `(accountId, userId)` token。最终文本、typing、互通与主动通知使用项目绑定账号用户；互通排除来源账号。命令、错误、warning、文件、进度和 UI 仍定向到来源账号用户；未绑定或停用提示也使用该账号用户，不要求先有项目。CLI broadcast 与 Agent 出口共用解析及投递规则。
4. 入站 token 按实际 sender 保存。当前 token 仅在 sender 与收件人一致时可直接使用，否则查收件人的精确缓存；不猜 ID 映射、不借用其他用户 token。缺用户、token 或可用 transport 时跳过并记录，单目标失败不影响其他目标，不切换收件人，不宣称全部成功。
5. 保留 TurnContext 的回合来源、实际 sender、messageId 和必要交互上下文。UI 询问发送给来源账号用户后，只接受该账号对应用户的回答；交互关联校验不是普通入站身份过滤。
6. 沿用 ADR-0004 的分层：账号/微信层负责身份、token 与投递，项目层负责绑定用户及范围，会话层负责回合和交互，Pi SDK 仅由 `src/pi/` 接触。ADR-0004 中的 participant 结构由本决策取代。
7. 保留 ADR-0006 的会话级成功最终文本出口，包括扩展触发的独立回合；取代其中 participant 收件范围与允许缺 token 发送的策略。不改变会话生命周期、busy/abort、错误归属或会话代际隔离，不实施需求 0010 的默认会话、CLI prompt 或 MCP。

## 后果与取舍

- **这是有意的用户可见行为改变，不是无行为变化重构。** 广播不再要求用户在本次进程中发言；重启后已有精确缓存 token 即可投递。原来可能向实际 sender 回复的路径现在定向到来源账号登录用户，即使二者不同。
- 缺少精确 token 时跳过，而不是 tokenless fallback。缓存 token 仍可能被服务端拒绝；不新增 TTL、刷新、自动重试、队列或送达保证。
- 入站信任与出站定向是应用策略，不包装成平台强制安全保证。无需维持第二套 participant 生命周期，但必须让询问收件人和允许回答者一致。

## 证据与未知

固定上游 commit 的客户端核查来源和结论保留在协议文档 §11。腾讯与 Hermes 的普通回复使用实际 sender；本项目选择登录用户作为统一出站来源，不声称复刻这些 adapter 的策略。

目前未取得同账号完整登录响应与入站报文的关联日志，样本/账号数量和匹配统计未知。现有登录日志只保留 ID 前缀与长度，不能证明完整相等；也未确认服务端身份恒等或 token/recipient 强绑定契约。离线 fake transport 测试只能验证本地规则，不能替代真实日志或平台保证。不得为补证据提交原始用户 ID、token 或凭据。
