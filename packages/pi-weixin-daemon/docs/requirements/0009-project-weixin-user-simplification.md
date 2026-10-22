# 需求 0009：项目微信用户与消息投递实现简化

---

status: completed
execution_time: "2026-10-21 / 2026-10-21"
commit: null
version: null
related_documents:
  - "[领域模型](../domain-model.md)"
  - "[消息路由](../routing.md)"
  - "[iLink 协议](../ilink-protocol.md)"
  - "[需求 0007：CLI 广播](0007-project-cli-broadcast.md)"
  - "[需求 0010：默认会话、CLI 与 MCP](0010-project-session-cli-mcp.md)"
  - "[ADR-0004：分层](../adr/0004-layering-and-dependency-direction.md)"
  - "[ADR-0006：会话级回复](../adr/0006-session-wide-agent-reply-routing.md)"
  - "[ADR-0007：项目微信用户与统一投递](../adr/0007-project-weixin-users.md)"

---

## Goal

项目用户希望所有微信出口使用一致、可预测的用户集合，不再因为 daemon 重启或某用户尚未发言而改变广播范围。产品术语、文档和代码变量保持一致，去掉“owner”和动态 participant 两套收件人概念，保持实现简单。

## Solution

项目微信用户由 project 绑定的账号及其 `account.userId` 确定，沿用现有 CLI broadcast 的收件人来源。删除 participant 注册表；统一文本、typing、文件、交互、通知等出口的用户解析，但保留不同消息的定向或广播范围。

不增加入站发送者身份过滤：仍按收到消息的 `accountId` 路由 project，检查绑定和启用状态，并保留现有消息类型检查。此 spec 先简化用户与投递模型；默认会话和新增 CLI/MCP 入口由需求 0010 定义。

## User Stories

1. 作为项目用户，我希望广播发给 project 绑定账号的微信用户，不必在每次 daemon 重启后先发一条消息才能收到通知。
2. 作为项目维护者，我希望 `account.userId` 在代码、产品和文档中始终表示账号登录时记录的微信用户，不再把它解释为额外的 owner 权限角色。
3. 作为微信用户，我希望错误、文件和交互询问仍定向发给本次来源账号对应的微信用户，而不是因删除 participant 就将所有输出广播。
4. 作为项目维护者，我希望继续信任微信入站消息，通过账号绑定和 project 启用状态进行路由，不新增 sender 白名单或身份比对。
5. 作为运维人员，我希望缺少用户或精确 token 时明确记录无法投递，不能误用其他用户的 token；一个目标失败不影响其他目标。
6. 作为维护者，我希望文档区分官方协议保证、日志观察及未知情况，不把未验证的身份相等关系当成事实。

## Implementation Decisions

### 术语与用户来源

- `accountId` 标识机器人账号；一个账号最多绑定一个 project，一个 project 可以绑定多个账号。
- `account.userId` 表示该账号扫码登录结果中的微信用户 ID；project 微信用户集合由绑定账号投影得到，不增加独立联系人实体或用户登记存储。
- 保持账号存储及现有 RPC 字段 `userId`，不为术语统一迁移数据。局部变量需要区分角色时使用 `userId`、`loginUserId` 或 `recipientUserId`，不新引入 `ownerId`。
- `senderId` 仍表示入站实际发送者；协议字段 `ilink_user_id`、`from_user_id` 不改名、不重写。不能以术语简化为理由把 sender 和登录用户强制视为同一值。
- 删除 Participant/ParticipantRegistry、观测发送者集合及“发言后才成为广播对象”的逻辑；不另建等价缓存替代。

### 入站与出站

- 入站保持 `accountId → projectId` 路由，保留消息类型、项目绑定、启用和运行状态检查；不增加 `senderId === account.userId` gate，也不增加 pairing/allowFrom。
- 不依赖“微信服务端一定只允许扫码用户发消息”的假设。若收到不同 sender，仍按上述规则处理。
- 广播、最终文本、typing、互通和主动通知的用户来源统一为绑定账号的 `account.userId`；互通仍排除来源账号，不把用户自己的输入重复通知给自己。
- 原有定向消息仍定向到来源账号的 `account.userId`，包括命令结果、错误、warning、文件、进度及 UI；未绑定或停用提示也通过该账号的微信用户发送。没有 project 时不要求先建立项目用户集合。
- 交互询问的投递对象与允许回答者保持一致：发送给来源账号的 `account.userId` 后，由该账号对应的用户回答。保留原始 sender 用于来源记录，不让旧的 sender 条件导致询问收件人无法回答。仅此交互关联校验不构成新增普通入站过滤。
- CLI broadcast 与 Agent 出口共用用户解析及投递规则，不复制两套枚举逻辑。保留具体消息原有范围；需求 0010 再定义显式 prompt 的 reply 目标。
- 出站目标不再取决于本次进程是否收到该用户消息；已有精确缓存 token 的绑定用户可以直接收到通知。这是有意的行为变化，而非无行为变化重构。

### context token 与失败

- token 继续按 `(accountId, userId)` 精确关联。入站 token 按实际 sender 保存，不改写为登录用户。
- 当前消息的 token 只有在其 sender 与收件人一致时才可直接使用；其他情况查找实际收件人的精确缓存。不得借用另一 sender 的 token，不猜 ID 映射。
- 缺账号用户、token 或可用 transport 时跳过并记录原因；失败不切换到其他收件人，不影响其他广播目标，不宣称全部成功。
- 沿用现有尽力发送、逐目标失败隔离及无自动重试规则，不新增 token TTL、刷新或消息队列。
- 保留回合来源、messageId 和必要的 UI 上下文；删除 participant 不等于删除 TurnContext。

### 分层与文档

- 账号/微信层负责身份资料、token 和投递；项目层负责绑定用户和收件范围；会话层负责回合与交互。保持 Pi SDK 仅由现有 SDK 边界接触的约束。
- 实施时同步更新领域模型、路由、协议和 README 中的当前行为，新增关联旧 ADR 的决策记录；不改写已完成 spec 或旧 ADR 的历史理由。
- 本 spec 不修改既有会话生命周期；需求 0010 以本 spec 的用户模型为基础。

## Testing Decisions

用户已确认沿用 daemon/project 集成测试边界，使用 fake 微信 transport 和 fake Pi runtime；优先从可观察行为验证，不为每个内部模块另建测试层。

1. 多账号 project 在没有本次进程 participant 记录时，最终文本、typing、互通、主动通知仍使用绑定账号用户；重启后缓存 token 仍可用于投递。不同 project 隔离。
2. 命令、文件、进度、错误和 UI 保持定向；交互收件人能够回答，其他来源不能误消费该询问。
3. 入站仍按账号绑定/启用路由，现有 BOT/非 USER 检查保留；sender 与登录用户不同时不新增拒绝，但其 token 不得被挪给登录用户。
4. 缺用户、token、transport 及部分发送失败行为可观察，其他目标继续处理；日志不暴露 token 或凭据。
5. 复用现有 CLI broadcast 回归，确认统一解析没有改变其项目检查和成功/失败语义。

代码阶段按仓库要求分阶段格式化，运行受影响包类型检查与相关离线测试；不增加真实模型调用或真实微信自动发送。日志和官方协议核实是独立人工证据检查，不作为离线测试的平台保证。

## Out of Scope

- 新增入站身份鉴权、联系人发现、独立联系人数据库或 participant 持久化。
- 重命名微信协议字段、迁移账号 `userId` 字段或推测 sender/login ID 映射。
- 默认会话、CLI prompt、MCP、OAuth；这些由需求 0010 定义。
- 消息队列、自动重试、token 自动续期、恰好一次送达。
- 无关重构、发布或远端操作。

## Further Notes

- 实施前存在两套目标：CLI broadcast 使用 `account.userId`，Agent 广播使用内存 participant。本次已删除 participant，使用统一收件人解析；调整需求 0006/ADR-0006 的收件范围，不取消独立 Agent 回合的发送能力。
- 完成验证：受影响包 typecheck、build、Biome 及全部离线测试（25 文件、167 项）通过；补充 typing 目标/token 断言后再次通过类型检查和全部离线测试。独立变更审查未发现新增阻塞问题；真实微信/模型送达未验证。
- 范围外既有问题单列后续：[未使用 token 推断函数 #19](https://github.com/Yesifan/pi-packages/issues/19)、[广播代际检查透传 #20](https://github.com/Yesifan/pi-packages/issues/20)、[底层 API 错误日志统一 #21](https://github.com/Yesifan/pi-packages/issues/21)。本次投递层包装不记录原始上游错误，但不宣称既有底层所有端点日志已完成脱敏。需求 0010 未实施。
- 目前未取得同一账号登录响应与入站报文的完整关联日志，也未确认官方保证两种 ID 必然相等。已有登录日志只保留 ID 前缀与长度，不能据此证明完整相等。
- 实施前在可访问且获准的部署日志和官方协议资料中核实；只记录来源、版本、样本/账号数量、匹配统计及限制，不提交原始用户 ID、token 或凭据。没有证据时明确记为未知，不阻塞已确认的不新增过滤策略。
- 入站信任与出站定向是用户明确选择的应用策略；文档不得将其包装成平台强制安全保证。

### 外部 adapter 核查（2026-10-21）

- 腾讯官方 `Tencent/openclaw-weixin`，固定 commit `874637a0dbc24050f72d1385add4fc6170a2d726`：[扫码返回 userId](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts#L460-L473) 与 [入站授权](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/process-message.ts#L184-L200) 分开处理；普通消息使用实际 sender，allowFrom 为空时才以登录 userId 作为授权列表兜底。这是客户端策略，不是服务端身份恒等保证；该版本插件 slash handler 在这段授权之前运行，不能概括为所有入口都先校验。
- 腾讯正常回复以 [入站 from_user_id 和 context_token](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts#L255-L270) 为上下文，并非一律用扫码 userId。官方 [协议说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L248) 建议回传入站 token；客户端能发出无 token 请求不等于服务端一定接受。
- Hermes `NousResearch/hermes-agent`，固定 commit `cb6bcb401e4387459b67d46c0fae55192ad7cb01`：adapter 已迁移到 `plugins/platforms/weixin/adapter.py`。[扫码身份保存为 user_id](https://github.com/NousResearch/hermes-agent/blob/cb6bcb401e4387459b67d46c0fae55192ad7cb01/plugins/platforms/weixin/adapter.py#L645-L654)，[入站](https://github.com/NousResearch/hermes-agent/blob/cb6bcb401e4387459b67d46c0fae55192ad7cb01/plugins/platforms/weixin/adapter.py#L879-L912) 使用 from_user_id 和可配置 DM policy，不强制等于登录 user_id；与 bot account ID 的比较是排除自己，不是扫码用户校验。
- Hermes [发送](https://github.com/NousResearch/hermes-agent/blob/cb6bcb401e4387459b67d46c0fae55192ad7cb01/plugins/platforms/weixin/adapter.py#L1037-L1060) 使用传入 chat_id，并查找该账号/用户对应 token。它的 tokenless fallback 是实现选择，不能当作腾讯协议保证或本项目新增 fallback 的理由。
- 结论：两个 adapter 都分别获取扫码身份与 sender，普通私聊回复均使用 sender。未找到 sender 与扫码身份永远相等或 token/recipient 强绑定的服务端契约。保留精确 token 关联是本项目明确规则；统一按 account.userId 出站则是本项目的产品决策，不声称复刻这些 adapter 的回复策略。
