# 消息路由与会话生命周期

> 面向非读者，讲清两件事：一条微信消息怎么到达 agent、一个会话怎么生老病死。
> 实体/变量定义见 [`docs/domain-model.md`](domain-model.md)；协议机制见
> [`docs/ilink-protocol.md`](ilink-protocol.md)。

---

## 路由：微信真人 → 账号 → 项目 → 会话

```
  微信真人用户(owner)
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
                     │ 一个项目只有一个会话
                     ▼
                   会话
                     │
                     ▼
          agent 处理,回复回给发起者(见下方"回复/广播")
```

- 一个账号只属于一个项目；一个项目可绑多个账号。
- 一个项目至多有一个活动会话，所以多个账号 / 真人共用同一份活动上下文。
- owner-scoped 协议下，一个账号（bot）通常只服务扫码 owner；但本地没有 pairing/allowFrom
  鉴权，也不校验 `senderId === account.userId`。回复和广播始终使用报文中实际观测到的
  `senderId`，不把二者字节相等作为安全边界。

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
  pi-weixin 把消息B 发给微信服务器      # 接收方 = 实际 senderId + context_token
        │
        ▼
  微信服务器 通过 bot 把消息B 发回给 user
```

- **入站**：`getupdates` 长轮询 → 归一化 `InboundMessage` → 按 `accountId` 路由到项目 →
  `SessionController.handleUserMessage`。
- **出站**：回复使用 `TurnContext`（`accountId`/`senderId`/`context_token`）回传；
  `context_token` 必须原样回传。

### 入站 gate 与丢弃前告知

transport 首先丢弃明确的 BOT/非 USER 记录；该检查发生在项目查询和媒体下载之前。
`message_type` 缺失的旧报文仍按 USER 兼容。通过类型 gate 后，账号再进入“多项目 gate”
（绑定 / 启用判定）。后者原先是**静默丢弃**；现在
**区分原因并回发告知**，让用户知道为什么没反应：

- **未绑定**：`⚠️ 该账号尚未绑定任何项目，请先绑定 project 后再使用。`
- **项目停用**：`⚠️ 该项目已停用，启用后再发送消息。`
- **已绑定但项目未运行**（绑定且启用但 runtime 没起来）：`⚠️ 项目当前未运行（可能启动失败或仍在启动），请稍后重试。`

> 前三者分别在 `transport` 层（绑定/停用）与 `ProjectManager.dispatch`（未运行）处理；
> 都需要把告知回发给**发送者**（`from_user_id` + `context_token`）。

---

## 入站媒体处理

一条进来的消息里的媒体按类型处理（**不做跨消息合并**，每条 iLink 消息独立成回合）：

- **图片** → 读取为多模态 `ImageContent`（base64 + 检测到 mimeType）直接进 agent。
- **文件 / 视频 / 语音文件** → 不内联内容，而是生成一条 **context note** 给 agent：
  类型 + 保存路径 + “自己用工具读/处理，别让用户粘贴/描述”的指令，避免 agent 反问她。
- **语音** → 优先用 iLink 自带的 `voice_item.text`（语音转写）**当作文本**；无转写才按语音附件给
  context note。
- **下载 / 解密失败** → 不阻塞消息，但记录到 `mediaFailures`，交由 agent 告知用户“附件下载失败”。

> 单条消息内的 text 和 media 一起进入同一回合；附件路径都在 `<project.cwd>/.pi-weixin/inbox`，
> agent 的 cwd 即项目目录，可读到。

---

## 回复 / 广播

- **成功文本回复**：project 层通过 `broadcastText` 将 agent 最终成功回复广播给项目内
  **所有**参与者（含发起者）。错误、可能不完整的部分输出和 extension warning 只回发起者。
- **中间进度**：长任务可调用 `weixin_send_progress`，立即向当前 `TurnContext` 发简短进度；
  它不广播、不进入最终回复文本，且在没有活动 turn 时拒绝发送。
- **消息互通**：某账号的 sender 发来消息时，同时通知同项目**其他**参与者，
  内容为 "`<该账号name>`: 消息文本"——需求③。
- **目标来源**：广播 / 互通的目标取自 **参与者注册表**（`ProjectController` 记录每个项目下
  "实际发过消息的 `(accountId, senderId)` + `contextToken`"），不靠 `account.userId` 猜
  （避免 `ilink_user_id ≠ from_user_id` 出错）。
- **限制**：没发过消息 / 无 token 的账号不会出现在注册表里，也就不会收到（已知取舍）。

> 多用户场景（两用户→两账号→一项目）见 [`docs/domain-model.md`](domain-model.md) §1.7。

### Pi 错误与送达失败

- Pi 的 Provider/模型错误通常编码在最终 assistant message 的 `stopReason/errorMessage` 中，
  不一定让 `prompt()` 抛异常；daemon 会在 `agent_settled` 后检查最终结果并明确回复发起者。
- 自动重试期间的中间错误不会提前告知；重试最终成功时只发送成功结果。
- 错误发生前若已有部分输出，会标记“内容可能不完整”，且仅回复当前回合发起者，不广播。
- 当前回合中的 extension runtime error 会作为警告回复发起者；不相关的后台错误只记日志。
- Agent 回合默认最多运行 30 分钟，超时后 abort；可用 `PI_WEIXIN_TURN_TIMEOUT_MS`
  覆盖（毫秒，`0` 表示关闭）。abort 后默认等待 10 秒，可用
  `PI_WEIXIN_ABORT_GRACE_MS` 覆盖。仍无法停止时 session 进入 faulted 状态。
- 所有用户可见错误都会清除控制字符、脱敏并截断；原始异常仅写 daemon 日志。
- 微信发送通道自身失败时无法再通过同一通道告知用户。系统会记录项目、消息、账号及广播
  成功/失败统计，但不会把送达失败误判为 Pi 项目故障。

---

## UI / 权限交互（ask）

当 agent 需要交互时，会往**当前 turn 的账号**发一条 **ask**（确认 / 选择 / 输入），或者某个工具调用
命中权限系统需要批准（也是一种 ask）。此时 interaction controller 进入 `WAITING_FOR_UI`，等用户的**下一条普通消息**
作为答复。

- **答复路由**：只有**当前 turn 的发起者**（`(accountId, senderId)` 与 turn 一致）的普通消息才被当作答复；
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

```
   项目启动
     │  仅启动 controller/host，不恢复旧会话
     ▼
   [inactive：无 Pi session]
     │  首条普通消息懒创建
     ▼
   [会话 S]
     │
     ├─ 普通消息 ─▶ 进 S,agent 处理
     ├─ 空闲 ≥10 分钟 ──▶ 自动关闭会话 + 广播"本次会话已关闭"
     │                         └─> 下一条普通消息再新建一个会话
     ├─ /new     ─▶ 已有 S 时换成 S'(旧上下文抛弃)
     ├─ /compact ─▶ 压缩 S(仍是 S)
     ├─ /abort   ─▶ 中止当前任务(仍是 S)
     └─ daemon 重启 ─▶ 回到 inactive
```

- 项目启动时不创建 Pi session，也不跨重启恢复；首条普通消息才创建全新会话，后续普通消息
  进入同一个活动会话。
- 已有活动会话时 `/new` 才会替换它；inactive 状态下 `/new` 只提示直接发送普通消息。
  空闲自动关闭后，下一条普通消息会创建新会话。`/compact`、`/abort` 不主动换会话。
- 项目忙时（`busy`），普通消息**直接拒绝、不排队**，不进会话；`WAITING_FOR_UI` 时只有
  当前 turn 发起者的消息作为答复，其余同样拒绝（见上方「UI / 权限交互」）。
