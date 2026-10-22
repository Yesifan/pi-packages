# 消息路由与会话生命周期

> 面向非读者，讲清两件事：一条微信消息怎么到达 agent、一个会话怎么生老病死。
> 实体/变量定义见 [`docs/domain-model.md`](domain-model.md)；协议机制见
> [`docs/ilink-protocol.md`](ilink-protocol.md)。

---

## 路由：微信真人 → 账号 → 项目 → 会话

```
  微信真人用户
     │  把消息发给哪个"账号"(bot)?
     ▼
   账号(account)
     │  查这个账号属于哪个"项目"
     │
     ├─ 未绑定 ──▶ 告知“请先绑定 project”
     ├─ 项目停用 ──▶ 告知“项目已停用”
     ├─ 已绑定但项目未运行 ──▶ 告知“项目当前未运行”
     │
     └─ 已绑定 ──▶ 项目
                     │
                     │ 一个项目至多一个 active
                     ▼
                   会话
                     │
                     ▼
          agent 处理,按范围投递给账号用户(见下方"回复/广播")
```

- 一个账号只属于一个项目；一个项目可绑多个账号。
- 一个项目至多有一个活动会话，所以多个账号 / 真人共用同一份活动上下文。
- 本地没有 pairing/allowFrom 鉴权，不新增 `senderId === account.userId` 检查；不同 sender 仍按账号路由。
  出站统一使用账号的 `account.userId`，不把它与 sender 相等或服务端 owner-only 当作保证。

---

## 消息流

```
 微信真人(user)  ──发送消息A──▶  账号(bot)
        │
        ▼
   微信服务器 收到消息A
        │
        ▼
  pi-weixin 长轮询(getupdates) 拿到消息A
        │   # 归一化成 InboundMessage{ accountId=bot, senderId=user }
        ▼
  pi-weixin 投递到 项目 → ProjectController → SessionController
        │   # 在文本末尾追加 "-- from weixin <账号name>"
        ▼
  pi agent 处理，生成回复消息B
        │
        ▼
  pi-weixin 把消息B 发给微信服务器      # 接收方 = 绑定账号的 userId + 精确 context_token
        │
        ▼
  微信服务器 通过各目标 bot 把消息B 发给其登录用户
```

- **入站**：`getupdates` 长轮询 → 归一化 `InboundMessage` → 按 `accountId` 路由到项目 →
  `SessionController.handleUserMessage`。
- **出站**：按消息范围选择账号的 `account.userId`，使用 `(accountId, userId)` 精确 token。
  `TurnContext` 保留实际 sender 和回合来源；当前 token 仅在 sender 与收件人一致时可直接使用，否则查收件人的精确缓存。入站 token 始终按实际 sender 保存。

### 入站 gate 与丢弃前告知

transport 首先丢弃明确的 BOT/非 USER 记录；该检查发生在项目查询和媒体下载之前。
`message_type` 缺失的旧报文仍按 USER 兼容。通过类型 gate 后，账号再进入“多项目 gate”
（绑定 / 启用判定）。后者原先是**静默丢弃**；现在
**区分原因并回发告知**，让用户知道为什么没反应：

- **未绑定**：`⚠️ 该账号尚未绑定任何项目，请先绑定 project 后再使用。`
- **项目停用**：`⚠️ 该项目已停用，启用后再发送消息。`
- **已绑定但项目未运行**（绑定且启用但 runtime 没起来）：`⚠️ 项目当前未运行（可能启动失败或仍在启动），请稍后重试。`

> 前三者分别在 `transport` 层（绑定/停用）与 `ProjectManager.dispatch`（未运行）处理；
> 告知均定向到**来源账号的微信用户**（`account.userId` + 精确 token），不要求先有项目；缺少投递条件则跳过并记录。

---

## 入站媒体处理

一条进来的消息里的媒体按类型处理（**不做跨消息合并**，每条 iLink 消息独立成回合）：

- **图片** → 读取为多模态 `ImageContent`（base64 + 检测到 mimeType）直接进 agent。
- **文件 / 视频** → 不内联内容，而是生成一条 **context note** 给 agent：
  类型 + 保存路径 + “自己用工具读/处理，别让用户粘贴/描述”的指令，避免 agent 反问她。
- **语音** → 仅用 iLink 自带的 `voice_item.text`（语音转写）**当作文本**，末尾追加
  `【以上为用户的语音转录的信息，可能有识别错误】`；不下载音频、不生成语音附件或路径提示。
  转写缺失、为空或纯空白时，仅提示来源账号的微信用户「未获取到语音转录文本，请重新发送语音或改用文字。」；
  没有其他有效输入时不调用 Pi，混合消息的其他内容仍按现有规则处理。
- **下载 / 解密失败** → 不阻塞消息，但记录到 `mediaFailures`，交由 agent 告知用户“附件下载失败”。

> 单条消息内的 text 和 media 一起进入同一回合；附件路径都在 `<project.cwd>/.pi-weixin/inbox`，
> agent 的 cwd 即项目目录，可读到。

---

## 回复 / 广播

- **成功文本回复**：微信发起回合及无请求来源的独立 Agent 回合，最终成功文本广播给项目绑定账号用户；CLI 回合只按本回合 reply 投递，不再重复广播。无最终文本不发送。前一 CLI 的 reply 不遗留给后续独立回合。错误、可能不完整的输出和 warning 回到当前来源，不冒充成功广播。
- **文件工具**：`weixin_send_file({ path, caption?, userId? })` 收件人独立于最终 reply。微信回合默认面向来源账号用户；CLI/无来源独立回合未指定 userId 时面向项目全部微信用户，显式 userId 必须是项目绑定账号的 `account.userId`，即使 reply 只有 caller 也可发送。
- **通知与进度**：微信回合的 `ctx.ui.notify` / `weixin_send_progress({ update })` 定向来源账号用户；CLI 回合累积到响应 `messages`，不推送微信、不混入最终正文，也不受 caller 是否被选择影响。进度工具没有 userId 参数，无活动回合时拒绝。
- **消息互通**：某账号的 sender 发来消息时，同时通知同项目**其他账号的微信用户**，
  内容为 "`<该账号name>`: 消息文本"——需求③。
- **目标来源**：项目绑定账号的 `account.userId`；最终文本、typing、互通及主动通知统一使用该来源，互通排除来源账号。CLI broadcast 与 Agent 出口共用用户解析及投递规则。
- **来源范围**：微信命令结果、错误、warning 及 UI 定向来源账号用户，不是原始 sender；CLI 状态、错误及文字询问回到本地调用方。文件按工具目标规则处理，CLI 进度进入 messages。
- **投递限制**：缺用户、精确 token 或可用 transport 时跳过并记录；单目标失败不影响其他目标，不借用其他用户 token，不自动重试。重启后无需重新发言，已有精确缓存即可发送，但服务端仍可能拒绝。
- **已开始的广播继续完成**：即使发送第一个目标期间会话被停止或替换，仍尝试其余目标；transport 已停止时仍可能发送失败，不承诺送达。旧会话事件和尚未开始的过期投递仍由既有代际检查隔离，不产生新的旧会话广播。

> 多用户场景（两用户→两账号→一项目）见 [`docs/domain-model.md`](domain-model.md) §1.7。

### Pi 错误与送达失败

- Pi 的 Provider/模型错误通常编码在最终 assistant message 的 `stopReason/errorMessage` 中，
  不一定让 `prompt()` 抛异常；daemon 会在 `agent_settled` 后检查最终结果并明确回复发起者。
- 自动重试期间的中间错误不会提前告知；重试最终成功时只发送成功结果。
- 错误发生前若已有部分输出，会标记“内容可能不完整”，且仅回复当前回合发起者，不广播。
- 当前回合中的 extension runtime error 会作为警告回复发起者；不相关的后台错误只记日志。
- Agent 回合默认不设运行时限。可用 `PI_WEIXIN_TURN_TIMEOUT_MS` 设置 watchdog
  （毫秒，正整数表示超时后 abort，`0` 表示关闭）。abort 后默认等待 10 秒，可用
  `PI_WEIXIN_ABORT_GRACE_MS` 覆盖。仍无法停止时 session 进入 faulted 状态。
- 所有用户可见错误都会清除控制字符、脱敏并截断；原始异常仅写 daemon 日志。
- 微信发送通道自身失败时无法再通过同一通道告知用户。系统会记录项目、消息、账号及广播
  成功/失败统计，但不会把送达失败误判为 Pi 项目故障。

---

## CLI 入口与最终回复目标

`pi-wx prompt "文本" --project <project>` → 本地 UDS → 项目 → 同一个 SessionController。先校验项目启用、非空文本、互斥参数及 reply 目标，再改变会话：默认使用 default，`--session <id>` 恢复指定历史，`--new-session` 新建。不存在的会话和默认历史丢失明确报错。

`--reply` 可重复，默认 `caller`，支持 `user:all`、`user:<account.userId>` 与 caller 组合。微信目标去重，拒绝未知/跨项目用户；未选择 caller 时调用方不收到成功正文，但仍收到 session ID、执行状态、错误及可用投递结果。执行失败与投递失败分别记录，不能因一个微信目标失败把 Pi 执行判为失败。

CLI stdout 输出单个 JSON：`sessionId`（可用时）、`status`（success/error/aborted/waiting）、可选 `text`/`error`、本次响应的辅助 `messages`，以及可选 `delivery: { succeeded, skipped, failed }`。delivery 只统计成功最终文本的微信投递，不含文件或切换通知；caller-only 可得到全零计数。询问/notify/进度/warning 进入 messages，随等待或完成返回，不流式输出。执行 error/aborted 或投递存在 failed/skipped 时退出 1，其他结果（含 waiting）退出 0；请求校验、busy、RPC 失败则 stderr 报错并退出 1，不保证 JSON。

CLI 等待完成或交互询问，不提供异步任务/轮询或新增历史读取 RPC。没有队列、自动重试或断线取消保证；重复提交可能重复执行。现有 `broadcast` 不经过 Pi，不激活会话或刷新闲置计时。

## UI / 权限交互（ask）

CLI 回合向调用方返回文字询问；同 project 的所有本地 CLI 视为同一可信来源，可用下一次 prompt 互相回答。回答沿用原回合的 session/reply，省略 session 不切 default，指定其他 session 或新建不能绕过等待。微信与 CLI 不能互相代答；等待期间其他新任务 busy 拒绝。超时、取消或 abort 不自动批准，不新增询问 ID。

微信回合中，当 agent 需要交互时，会往**当前 turn 的账号**发一条 **ask**（确认 / 选择 / 输入），或者某个工具调用
命中权限系统需要批准（也是一种 ask）。此时 interaction controller 进入 `WAITING_FOR_UI`，等用户的**下一条普通消息**
作为答复。

- **答复路由**：只有**询问的收件用户**（来源 `accountId` 与该账号的 `account.userId`）的普通消息才被当作答复；原始 sender 仅保留为来源记录。这是交互关联检查，不是新增普通入站过滤；
  其他账号/发件人的消息仍按 busy 拒绝。
- **不阻塞接收**：`getupdates` 长轮询**不会等待 turn 处理完成**——它在 `onInbound` 处 fire-and-forget，
  turn 进行中依然持续轮询。因此用户对 ask 的答复能及时收回，不会因为 turn 卡住而被丢弃（旧版死锁）。
- **答复回执**：收到答复后，`WeixinUIContext` 会回发一条确认消息告诉用户结果
  （如 `✅ 已允许：Yes` / `❌ 已拒绝：No` / `✅ 已确认`）。
- **超时自动拒绝（兜底）**：ask 发出后开始计时；若用户一直没回，超时后**自动拒绝/取消**并回发
  `⏱️ 超时未收到回复，已自动拒绝/取消`。默认 **5 分钟**，可用环境变量 `PI_WEIXIN_UI_TIMEOUT_MS`（毫秒）覆盖；
  超时**只**在用户未回复时触发，`/abort` 等主动取消不误伤。

---

## 会话生命周期

```text
项目启动 → inactive（不立即加载历史）
  ├─ 微信普通消息 → 恢复 default；从未设置则懒创建
  ├─ CLI 普通 prompt → 使用 default
  └─ 显式新建/恢复 → 激活目标
                        ↓
                 一个 active / runtime
                  ├─ 微信普通消息 → 继续 active
                  ├─ CLI 默认 prompt → 切回 default
                  ├─ /new、/resume、CLI 显式选择 → 全项目切换
                  ├─ /default [id] → 只改持久默认指向
                  └─ 闲置 10 分钟 / 重启 → inactive，保留 default 和历史
```

- 首个成功激活的会话自动设为 default，包含显式新建和恢复；失败不设置。后续新建不覆盖已有 default。
- `/new` 无 active 时也真正创建；`/resume` 保留分页，新增 ID/default；`/resume latest` 仅无 active 时恢复最近历史，不等同 default。
- 默认文件不存在/不可读时明确失败；可显式新建，再 `/default` 修复。临时 active 不跨闲置或重启恢复，也不恢复进行中的任务。
- 切到不同会话成功后向全部项目微信用户发送 `当前会话已切换为「<session title>」`，无标题用 ID。无 active 时显式新建/恢复也通知；仅无 active 时按需恢复 default、同会话重复选择、仅修改 default 不通知。已有不同 active 时，普通 CLI prompt 切回 default 也通知。切换失败不通知，通知失败不回滚切换；caller-only 也遵循通知规则。
- 项目 busy 时拒绝新任务及切换，即使指定其他历史也不排队；合格 UI 答复走原任务。保留 `/status`、`/abort`，`/compact` 不主动换会话。
- 释放 runtime 不删除历史；闲置继续广播“本次会话已关闭”。`broadcast` 不激活或延长会话。其他项目不受 busy/abort/错误影响。

决策及与旧生命周期约定的关系见 [ADR-0008](adr/0008-shared-default-session-cli.md)。
