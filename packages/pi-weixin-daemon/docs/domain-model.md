# 领域模型（Domain Model）

> 定义 `pi-weixin-daemon` 里各**实体**与**变量**的确切含义，作为所有文档、代码、日志与
> 讨论的**术语基准**。阅读顺序：实体 → 变量速查 → 消息流 → 关键事实。
> 协议机制细节见 [`docs/ilink-protocol.md`](ilink-protocol.md)，路由见
> [`docs/routing.md`](routing.md)。

---

## 1. 实体（Entities）

本系统只有四类核心实体：微信真人用户、Bot 账号、项目、会话。外加两个"过程"实体：
入站消息 / 回合上下文。

### 1.1 微信真人用户（User）

- 一个**真实的微信用户**，是系统的最终用户。
- 产品面向 **1：1 私聊**；账号保存扫码登录用户 `userId`，入站实际用户由 `senderId` 标识。不能据此推断服务端永远只允许扫码用户发消息。
- 身份标识：
  - `userId`：登录时服务端返回的 `ilink_user_id`，即账号的微信用户；旧文档称 owner，不代表额外权限角色。
  - `senderId`：入站消息里的 `from_user_id`（实际发消息的人）。
  - 两者分别来自登录响应与入站报文，本地不做相等性/发送方鉴权；未核实服务端恒等保证（见协议文档 §11）。

### 1.2 Bot 账号（Account）

- 一个通过**扫码登录**创建出来的"机器人"，绑定到一个微信真人用户。
- **标识**：`accountId`，即登录返回的 `ilink_bot_id`（服务端分配，作为路由 key）。
- **属性**（存于 `accounts/<accountId>.json`）：
  - `name`：用户用 `--name` 起的**别名**（全局唯一，如 `personal`/`work`）。
  - `token`：`bot_token`，用于鉴权（绝不打日志）。
  - `baseUrl`：有效 API base URL。
  - `userId`：扫码登录结果中的微信用户。
  - `savedAt`：登录时间。
- **选择边界**：CLI 账号参数仅接受 name（trim、区分大小写、唯一匹配，无 ID 回退）；控制配置变更在共同锁内按最新磁盘登记/凭据解析。内部配置与路由仍使用 accountId，旧账号/项目写入 RPC 不再接受变更。
- **所有权**：CLI 唯一写入登记和凭据，daemon 只读并管理 monitor。配置已保存与运行已同步分别反馈；清理前必须确认接收任务停止。升级前先停旧 daemon，配套更新后启动，见 [ADR-0010](adr/0010-cli-control-ownership.md)。
- **归属**：一个 account 至多属于一个 project（多绑第二个会报错）。

### 1.3 项目（Project）

- 把若干 account 聚合到**同一个工作目录**，并共享至多一个活动 Pi 会话。
- **标识**：`projectId`（项目名，配置记录的 key）。
- **微信用户集合**：由绑定账号的 `account.userId` 投影得到，不设独立联系人或动态参与者登记。
- **控制属性**（存于 `config.json`）：`cwd`、`accounts: accountId[]`、`enabled`。由 CLI 在共同控制锁内写入，daemon 只读并同步；cwd 创建后固定，同名删除重建导致 cwd 变化时重建运行实例。
- **会话状态**：daemon 独占写入 `resolveStateDir()/projects.json`（默认 `~/.local/state/pi-weixin-daemon/projects.json`），按项目保存 `cwd` 与可选的 `defaultSessionId`，与临时 active/runtime 及 CLI 控制配置区分。旧 `config.json` 的默认会话字段只读兼容，不再写回；见 [ADR-0011：项目默认会话运行状态独立存储](adr/0011-project-runtime-state.md)。
- **运行时**：`ProjectController`（一个项目一个），内含 `SessionController`
  （单一会话状态机：busy / abort / 发言范围 / 命令执行）。项目启动时只启动 controller/host，
  Pi runtime 按需创建或恢复，不在项目启动时加载历史。

### 1.4 会话（Session）

- **session** 是持久历史与 ID；**runtime** 是加载并执行历史的实例，释放 runtime 不删除 session。每项目可保留多份历史，但至多一个 active、一个 runtime、一个任务。
- **default** 是项目持久保存的会话身份，不等于最近修改历史，也不是模型/思考强度默认配置；**active** 是当前加载的临时会话，可与 default 不同。
- 首个成功激活的会话自动成为 default，包括显式新建/恢复历史。以后 `/new` 或 CLI `--new-session` 只切 active；`/default [id]` 改 default 而不强制切 active。
- 微信普通消息继续 active，没有 active 时恢复 default；CLI 无 session 参数时选择 default 并使其成为 active。任一入口切换对全项目生效，不维护每用户 active。
- 闲置 10 分钟释放 runtime 并清除 active；重启后也按需恢复 default，不恢复临时 active 或进行中的回合。默认历史不可读时明确失败，不静默替换。
- 历史范围沿用项目 cwd；相同 cwd 的项目允许共享历史，不建立会话所有权表，不接受其他 cwd 的任意路径。
- 项目历史不按账号 owner 隔离；已获项目访问权限的用户可使用该项目历史。仅账号 owner/凭据变化不重建项目 runtime 或切换 active/default，只更新接收器和微信 token 缓存，见 [ADR-0012](adr/0012-project-session-owner-independence.md)。

### 1.5 入站消息（InboundMessage）

一条被归一化的微信私聊消息，是 agent 的输入。字段：

| 字段 | 含义 |
|---|---|
| `accountId` | 收到这条消息的 **bot 账号** |
| `senderId` | 入站报文中的实际发件人，不保证等于登录用户 |
| `messageId` | 消息 id（`message_id` 或 `client_id`） |
| `contextToken` | 微信下发的会话上下文 token，按实际 sender 保存；仅可用于同一账号/用户 |
| `text` | 原始文本内容（含语音转写 `voice_item.text`，不含识别错误备注），用于命令和 UI 回复解析；空转写不生成文本 |
| `promptText` | 可选的 Agent 输入文本；对应语音转写后追加识别错误备注，不用于控制解析；未提供时使用 `text` |
| `attachments` | 附件（入站微信生成 image / file / video）；image 走多模态，file/video 以 context note 带入；语音不下载、不生成附件 |
| `mediaFailures` | 下载/解密**失败**的媒体（不会阻塞，仅用于让 agent 告知用户） |
| `createdAt` | `create_time_ms` |

### 1.6 回合上下文（TurnContext）

本轮 agent 的来源记录，保留 `accountId`、实际 `senderId`、`messageId` 和 `contextToken`。
**默认文件目标、UI 询问及错误定向到来源账号的 `account.userId`**，不是直接使用原始 sender 作为收件人；UI 允许回答者与该投递对象一致。
微信回合成功文本发给项目绑定账号的微信用户（见 [`routing.md`](routing.md) 的"回复 / 广播"）。CLI 请求另有本地调用来源及 reply 目标，不伪造微信 sender/token；CLI 成功文本按 reply 投递，无来源的独立回合仍向项目用户广播。

CLI reply 是**单回合成功最终文本受众**，不是 session 权限或持久订阅：`caller`、`user:all`、`user:<id>` 可组合，微信目标去重，ID 必须属于项目。会话切换通知和微信发送工具不受 reply 控制。同 project 所有本地 CLI 是同一可信交互来源，可互相回答；答复沿用原回合 session/reply。

### 1.7 组合示例：两个用户 + 一个项目

```
                        项目 project
                ┌───────────┴───────────┐
            账号A (bot)               账号B (bot)
              │  扫码登录用户            │
          用户a ───────────          用户b
        (userId_a / senderId_a)     (userId_b / senderId_b)
```

- 用户a 扫码登录账号A，用户b 扫码登录账号B；本例中的入站 sender 恰好等于登录用户，不代表协议保证。
- 两个账号都绑到**同一个项目**，共享**同一个会话**。
- 用户a 只通过账号A 发消息（`accountId=A`、`senderId=a`）；用户b 只通过账号B
  （`accountId=B`、`senderId=b`）。
- **a 和 b 是两个不同的人**：`senderId_a ≠ senderId_b`（各自在自己账号里独立）。

对应需求（互通 / 广播）：
- ③ a 发消息 → 通过账号B 给用户b 发一条 "`<账号A.name>`: 消息文本"。
- ④ agent 回复 → 通过账号A 给 a、通过账号B 给 b 各发一份。

---

## 2. 变量速查表

| 变量 | 来源 | 含义 | 等价 / 关系 |
|---|---|---|---|
| `accountId` | 登录 `ilink_bot_id` | **bot 账号**（收消息的一方） | 路由 key；账号存储索引 |
| `name` | `--name` | 账号**别名**（人话标识） | 全局唯一；仅展示/CLI |
| `userId` | 登录 `ilink_user_id` | **扫码登录用户** | 出站收件人来源；不推断与 `senderId` 相等 |
| `senderId` | 入站 `from_user_id` | 实际发消息的**真人** | 入站来源及 token 归属，不直接决定出站收件人 |
| `context_token` | 入站消息 | 会话上下文 token | 按 (account, user) 持久化 |
| `projectId` | 项目名 | 项目的 key | 一个账号 → 至多一个项目 |
| `sessionFile/sessionId` | Pi 历史 / 活动实例 | 持久会话身份 / 当前加载的会话 | 一个项目至多一个 active |
| `defaultSessionId` | daemon 项目运行状态（旧配置只读兼容） | 持久默认会话身份 | 可与 active 不同，闲置/重启不清除 |

> **一句话**：`accountId` 是**机器人**；`userId` 是扫码登录用户，`senderId` 是报文中实际发件人；
> 本地不以二者相等作为入站条件。`name` 是机器人的**别名**。
> 出站使用 `account.userId` 及其精确 token，这是应用策略，不是对两种 ID 映射的猜测。

---

## 3. 消息流

```
 微信真人(user)  ──发送消息A──▶  bot账号(account)
         │
         ▼
    微信服务器(iLink) 收到消息A
         │
         ▼
  pi-weixin 长轮询(getupdates) 拿到消息A   # 持有一条 from_user_id = user
         │        # 归一化成 InboundMessage{ accountId=bot, senderId=user }
         ▼
  pi-weixin 投递到 project → ProjectController → SessionController
         │        # 给文本追加 "-- from weixin <账号name>"
         ▼
  pi agent 处理，生成回复消息B
         │
         ▼
  pi-weixin 把消息B 发给微信服务器      # 接收方 = 绑定账号的 userId + 精确 context_token
         │
         ▼
  微信服务器 通过各目标 bot 把消息B 发给其登录用户
```

- 一个项目可绑定多个 account；每个 account 对应一个 bot，记录各自的扫码登录用户。
- 一个项目只有一个活动会话，所以微信与 CLI **共用**当前上下文，历史会话只能串行切换。

---

## 4. 关键事实（决定功能可行性）

1. **`accountId` 是 bot；`userId` 是扫码用户，`senderId` 是实际发送者，本地不校验相等**。
   - 未找到服务端保证二者恒等的契约；官方与 Hermes adapter 的客户端策略不能替代此保证（见 `ilink-protocol.md` §11）。
   - 本地没有 pairing/allowFrom 鉴权，不增加 sender 白名单；入站仍按账号绑定、项目启用及运行状态路由。
2. **项目微信用户来自绑定账号的 `account.userId`**。
   - 微信最终文本、typing、互通及主动通知使用这一用户来源；互通排除来源账号。CLI 最终文本按 reply 选其中的用户或 caller。
   - 微信命令、错误、warning、默认文件/进度和 UI 定向到来源账号的微信用户；CLI/独立回合的文件工具未指定 `userId` 时使用全项目用户，显式目标也只能来自项目；CLI notify/进度进入响应 `messages`，不广播微信；未绑定或停用提示也使用该账号用户，不要求先有项目。
3. **`context_token` 按 `(accountId, userId)` 精确关联**。
   - 入站 token 按实际 sender 保存，不改写成登录用户。当前消息 token 仅在 sender 与收件人一致时可直接使用，否则查收件人的精确缓存。
   - 重启后不需要重新发言，已有精确缓存 token 即可投递；缺用户、token 或可用 transport 时跳过并记录，不借用其他用户 token，也不切换收件人。
4. **尽力发送，不保证送达**：逐目标失败隔离，无自动重试、token TTL 或刷新机制；缓存 token 仍可能被服务端拒绝。

---

## 5. 与官方 openclaw-weixin 的差异

- 官方 `process-message.ts` 有**道 1：发送方鉴权**（`*-allowFrom.json` 白名单，
  兜底只信任扫码人自己的 `userId`）。
- **本地 `src/` 未实现**发送方鉴权。`ILinkWeixinTransport` 在媒体下载前丢弃明确的
  BOT/非 USER 记录；为兼容旧报文，缺失 `message_type` 时仍作为 USER 输入。由于没有
  pairing 校验，代码不将 `senderId === account.userId` 作为安全边界。
- 出站统一使用账号登录用户及精确 token，不沿用官方普通回复直接使用 sender 的策略；这不是服务端 owner-only 保证（见协议 §11）。
- 「道 2：路由解析」对应本项目的 `accountId → projectId` 索引（见 `routing.md`）。

---

## 附：术语对照（本文件 vs 旧文档）

| 旧说法 | 本文件术语 |
|---|---|
| 微信用户 / 用户 | 微信真人用户；登录用户 `userId` 与入站发送者 `senderId` 分别记录 |
| 机器人 | Bot 账号（account），标识 `accountId`，别名 `name` |
| 项目 | 项目（project），`cwd` + 若干账号 + 一个会话 |
| 会话 | session 是持久历史，active 是当前加载的会话，runtime 是运行实例；每项目至多一个 active/runtime |
| 回复只回发起者 | 成功文本发给绑定账号用户；文件、UI、错误及不完整输出定向到当前 `TurnContext` 来源账号用户 |
