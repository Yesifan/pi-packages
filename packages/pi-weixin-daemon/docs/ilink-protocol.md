# Weixin iLink 协议机制存档

> 本文件记录 `pi-weixin-daemon` 所依赖的微信 iLink 机制，以及官方参考实现
> `Tencent/openclaw-weixin` 的关键行为，并存档当前 multi-project 实现所依据的**协议契约**。
>
> 原则：只引用、不发明。涉及协议行为时以官方当前 `main`、`CHANGELOG`、源码为准，
> 不凭经验猜测，也不重新发明一套行为。

---

## 0. 一句话概括

iLink 是微信面向 bot 的通道协议。一个账号 = 一个**bot**（`ilink_bot_id`），bot 通过
**扫码登录**产生，与其**扫码人（`ilink_user_id`）**绑定。bot 用 `bot_token` 鉴权，
通过 `ilink/bot/getupdates` 长轮询接收私聊消息，通过 `ilink/bot/sendmessage` 等回复。

**关键认知（避免踩坑）：**

1. **扫码身份与消息发送者是分别取得的数据**：扫码返回 `ilink_user_id`，入站通过
   `from_user_id` 标识发送者。未核实到服务端保证两者永远相等，不能断言其他用户不可能发送消息。
2. **官方有「两道门」**：
   - **道 1 · 发送方鉴权（pairing）**：`*-allowFrom.json` 白名单，兜底只信任扫码人
     自己的 `userId`。
   - **道 2 · 路由解析**：`resolveAgentRoute` 决定「这个账号 → 哪个 agent」；无 agent
     路由 → 丢弃。
   - 方案的 `accountId→projectId` 索引，**等价于官方「道 2」**。
3. **`getUpdates` 按账号自己的 `bot_token` 鉴权**，返回该 bot 的消息记录，但完全不认识
   Project/绑定。本地在 transport 层先丢弃明确的 BOT/非 USER 记录，再执行 project gate；
   未绑定或停用的消息不会进入媒体/Pi 层。本地没有官方 pairing/allowFrom 那一道发送方鉴权。

---

## 1. 登录产物（扫码生命周期）

本地实现：`src/weixin/auth/login-qr.ts`（`waitForWeixinLogin`），端点：

- `ilink/bot/get_bot_qrcode?bot_type=3` → 取二维码
- `ilink/bot/get_qrcode_status?qrcode=...&verify_code=...` → 轮询扫码状态

成功 `confirmed` 后的产物（`StatusResponse`）：

| 字段 | 语义 | 本地映射 |
|---|---|---|
| `ilink_bot_id` | bot ID | **`accountId`** |
| `bot_token` | bot 鉴权 token | 暂存为账号 `token` |
| `ilink_user_id` | 扫码人用户 ID | 账号 `userId` |
| `baseurl` | 有效 API base URL | 账号 `baseUrl` / 默认 `https://ilinkai.weixin.qq.com` |

状态机：`wait` · `scaned` · `confirmed` · `expired` · `need_verifycode` ·
`verify_code_blocked` · `scaned_but_redirect`（IDC 重定向）· `binded_redirect`。

- `get_bot_qrcode` 请求携带 `local_token_list`（本地最近 ≤10 个已登录账号的 token），
  用于让服务端知道「此客户端已有哪些 bot」，避免重复绑定。
- `binded_redirect`：该 bot 已绑定过本实例，不重新签发凭据，视为成功
  （`alreadyConnected`）。
- `scaned_but_redirect`：把轮询 base URL 切到 `redirect_host`。
- token 只作为 `Authorization: Bearer <bot_token>` 传递，**绝不打印**（见 §8 脱敏）。

本地账号存储：`src/weixin/auth/accounts.ts`，索引 `accounts.json`，凭据
`accounts/<accountId>.json`（`token`/`baseUrl`/`userId`/`savedAt`）。账号间用
`clearStaleAccountsForUserId` 去重——同一 `userId` 只保留最新绑定账号，避免
context_token 歧义。

---

## 2. 身份头（每请求必带）

本地实现：`src/weixin/api/api.ts`。

| 字段 | 说明 |
|---|---|
| `iLink-App-Id` | 固定 `"bot"` |
| `iLink-App-ClientVersion` | uint32：`0x00MMNNPP`，`major<<16 | minor<<8 | patch` |
| `X-WECHAT-UIN` | 随机 uint32 → 十进制字符串 → base64 |
| `AuthorizationType` | `ilink_bot_token` |
| `Authorization` | `Bearer <bot_token>`（仅配置了 token 时） |
| `bot_agent`（`base_info`） | UA 风格，如 `pi-weixin-daemon/<version>`，仅观测用，不参与鉴权 |
| `channel_version`（`base_info`） | 本地包版本 |

`bot_agent` 有 sanitize 规则（`sanitizeBotAgent`，UA 语法），超长/非法 token 丢弃。

---

## 3. 端点与消息流

### 入站（私聊收消息）

- `ilink/bot/getupdates`（长轮询）body：

```json
{ "get_updates_buf": "<缓存 cursor，首次为空串>", "base_info": { ... } }
```

- 响应 `GetUpdatesResp`：`msgs: WeixinMessage[]`、`get_updates_buf`（**必须回传**给
  下一次长轮询）、`longpolling_timeout_ms`（服务端建议的下一轮超时）、`ret`/`errcode`。

> **cursor 契约**：官方要求把响应里的 `get_updates_buf` 作为下一轮 `get_updates_buf`
> 传回。本地持久化在 `src/weixin/storage/sync-buf.ts`（`loadGetUpdatesBuf`/`saveGetUpdatesBuf`），
> 按账号存储，daemon 重启后凭它续上下文。

`WeixinMessage` 关键字段：`from_user_id`、`to_user_id`、`session_id`、`group_id`、
`message_type`(`1=USER`,`2=BOT`)、`message_state`、`item_list: MessageItem[]`、
`context_token`（回复时必须回传）。

`MessageItemType`：`1=TEXT` `2=IMAGE` `3=VOICE` `4=FILE` `5=VIDEO` `11=TOOL_CALL_START`
`12=TOOL_CALL_RESULT`。

本地 `ILinkWeixinTransport.handleInbound`（`src/weixin/transport.ts`）在媒体下载前丢弃
明确的 BOT/非 USER 记录；`message_type` 缺失时为兼容旧报文仍按 USER 接受。随后
`normalizeInboundMessage`（`src/weixin/normalize.ts`）提取文本和附件。

`message_state` 是消息级状态（`NEW=0`、`GENERATING=1`、`FINISH=2`）；`is_completed`
则位于单个 `MessageItem` 上。当前本地和官方参考实现都没有据此过滤 USER 输入，其完整语义
缺乏充分协议说明，因此不能未经真实报文验证就只接受 `FINISH/is_completed=true`。

### 出站（回复）

- `ilink/bot/sendmessage`：body 包 `WeixinMessage`，含 `context_token`。
  - 校验 `sendMessage` 的 `ret`：非 0 抛错。
- `ilink/bot/sendtyping`：`{ ilink_user_id, typing_ticket, status }`，
  `status`(`1=typing`,`2=cancel`)。
- `ilink/bot/getconfig`：取该用户的 `typing_ticket`（`context_token` 需回传）。
- `ilink/bot/getuploadurl`：媒体上传（见 §4）。

本地出站统一解析账号的 `account.userId` 及其 `(accountId, userId)` 精确缓存 token；项目层决定广播或来源账号定向范围。入站 token 仍按实际 sender 保存，只有 sender 与收件人一致时才可直接使用当前 token。缺用户、token 或可用 transport 时跳过并记录，逐目标失败隔离，不借用其他 sender 的 token、不自动重试。已有缓存可跨 daemon 重启使用，不要求重新发言，也不保证 token 仍有效。这是本项目投递策略，不是服务端身份恒等或 token 强绑定保证。

### 生命周期 notify

- `ilink/bot/msg/notifystart` / `ilink/bot/msg/notifystop`：channel 启动/停止通知
  （best-effort，失败忽略），本地 `src/weixin/transport.ts` 的 `start()`/`stop()`。

---

## 4. 媒体 CDN 上传（发送文件）

官方流程：`getUploadUrl` → CDN 加密上传 → `sendMessage`。

- **加密**：`aeskey` 用于 AES-128-ECB 加密文件；上传字段见 `GetUploadUrlReq`
  （`rawsize`/`rawfilemd5`/`filesize`/`thumb_*`/`no_need_thumb`）。
- 响应 `upload_param`（原图）/`thumb_upload_param`（缩略图）/`upload_full_url`。
- 本地：`src/weixin/cdn/`（`aes-ecb.ts`、`cdn-upload.ts`、`cdn-url.ts`、
  `pic-decrypt.ts`），`src/weixin/messaging/send-media.ts`（`sendWeixinMediaFile`）。

> 上游明确媒体 CDN 使用 AES-128-ECB，并定义了文件上传字段。**不要自行更改加密方案。**

---

## 5. 长轮询 monitor 的容错

本地 `src/weixin/monitor/monitor.ts`（`monitorWeixinProvider`）：

- 循环：`getUpdates` → 持久化 `get_updates_buf` → 逐条 `onInbound`。
- 异常分类：
  - **API 错误**（`ret!==0` 或 `errcode!==0`）：2s 重试；连续 3 次 → 30s backoff。
  - **stale token `-14`**（`errcode` 或 `ret` 为 `-14`）：**暂停该账号所有请求 1 小时**，
    属于**过期/失效 token**，`pauseSession`（`src/weixin/api/session-guard.ts`）。
    **不是整个 daemon/session 失效**——只影响该账号。
  - **网络错误**：同样 2s/30s 策略（`classifyFetchError` 分 dns/tcp/tls/timeout）。
- 支持 `AbortSignal` 取消进行中的长轮询（对外部 abort 快速退出）。
- 首次启动前 `restoreContextTokens`（`src/weixin/storage/context-token.ts`），
  按账号/用户恢复已记录 context_token。

---

## 6. 入站处理的「两道门」（对齐官方）

官方 `src/messaging/process-message.ts` 的 `processOneMessage`：

### 道 1 · 发送方鉴权（pairing）

```ts
resolveSenderCommandAuthorizationWithRuntime({
  dmPolicy: "pairing",
  readAllowFromStore: async () => {
    const fromStore = readFrameworkAllowFromList(accountId); // 配对白名单 *-allowFrom.json
    if (fromStore.length > 0) return fromStore;
    return [loadWeixinAccount(accountId).userId];            // 兜底：只信任扫码人本人
  },
});
```

`resolveDirectDmAuthorizationOutcome` 若为 `disabled`/`unauthorized` → 丢弃。

> **本地当前差异**：本地 `src/` **没有**发送方鉴权（无 `pairing`/`allowFrom`/
> `authorize`）。transport 只做消息类型 gate：明确的 BOT/非 USER 记录直接丢弃；USER 或缺失
> `message_type` 的兼容报文继续经过 project gate。通过项目 gate 后，任意 `senderId` 都可能进入 Pi。
> 应用选择不增加该身份过滤，不代表服务端保证身份恒等。上述代码是普通消息授权示意，
> 不能概括为所有入口都先检查：旧账号例外和插件 slash handler 顺序见 §11。

### 道 2 · 路由解析（对应方案的 account→project 索引）

```ts
const route = channelRuntime.routing.resolveAgentRoute({
  channel: "openclaw-weixin",
  accountId,
  peer: { kind: "direct", id: ctx.To },
});
if (!route.agentId) {
  log("no agentId resolved ... message will not be dispatched"); // 无路由 → 丢弃
}
```

**本地的 `accountId→projectId` 索引 ≡ 官方的 `resolveAgentRoute`（道 2）。** §7
中未绑定/停用的账号不会进入 Pi，但本地会在丢弃前回复原因，而非静默 drop。

---

## 7. 本地 multi-project 实现契约

1. **「先门后下」**：account transport 通过动态 `resolveInboxDir(accountId)` 查询当前项目——
   未绑定 / Project disabled → **不下载媒体**，并**回发告知用户**（区分「未绑定 / 项目停用」
   两种文案）；已绑定 → 才下载到该 Project 的 inbox
   （`<cwd>/.pi-weixin/inbox`）。
   - 这样**「未绑定账号的媒体」根本不会出现**。
   - 比官方更省：官方是 `saveMediaBuffer` 先下、后查 route，可能白下一份。
   - **已绑定但 runtime 未运行**：绑定 + 启用 ⇒ 有 inbox，所以下载发生在 transport gate 之后；
     真正判 `!rt` 丢弃在 `ProjectManager.dispatch`，此处**回发**「项目当前未运行」。
2. **inboxDir 不写死进 transport**：按账号当前绑定动态解析，rebind 时无需重建长轮询
   （不丢 `get_updates_buf`）；当前由 daemon 注入 `resolveInboxDir` 实现。
3. **busy / abort 是 Project 作用域**，不跨 Project 阻塞（见 [`routing.md`](routing.md)）。
4. **媒体处理（参考 Hermes，不混合）**：每条 iLink 消息独立成回合；image → 多模态
   （base64+mime）；file / video → **context note**（类型+保存路径+“自己读/处理”）给 agent；
   voice 仅用 `voice_item.text`（iLink 自带语音转写）当文本，追加识别错误备注，不下载音频；
   空转写直接提示来源账号的微信用户，没有其他有效输入时不调用 Pi，不等待或处理后续补发转写；
   其他媒体下载/解密失败 → 记录为 `mediaFailures`，由 agent 告知用户，不阻塞消息。

---

## 8. 脱敏 / 禁止打印

官方有 token redaction。本地 `src/weixin/util/redact.ts`（`redactToken`/`redactBody`/
`redactUrl`）。**禁止打印**：`bot_token`、`context_token`、AES key、完整
`Authorization` header。日志字段建议含 `component`/`project`/`account`/`event`/`error`。

iLink GET/POST 失败诊断统一只记录方法、端点路径、HTTP 状态、超时设置及固定错误分类。HTTP 错误正文、网络异常 cause/code、JSON 解析片段及业务错误描述不进入失败日志或向上抛出的错误；业务失败和非法 JSON 也不先打印原始响应 debug。保留调用方原有 ret/errcode 处理、stale-token 暂停、超时/中止和重试语义。本次未扩展审查请求或成功响应的 debug 字段。

---

## 9. 版本与兼容性注意事项

> 以下为方案里给出的指导，**未在本轮逐条直接验证**，落地时须核实。

- 截至方案记录日（2026-09-02），Tencent upstream 的 CHANGELOG 已含 `2.4.7`
  （2026-08-31），修复 OpenClaw 2026.8.1 SDK import 兼容；此前 npm 的 `2.4.6`
  曾被报告有兼容故障。
- **遇到协议/兼容问题时，不要只看本地 npm 包版本**，应同时核对：
  1. Tencent 仓库当前 `main`；
  2. `CHANGELOG`；
  3. 对应源码；
  4. Issues / PR（行为仍不明确时）。

---

## 10. 参考链接

### 官方仓库（首要参考）

- 仓库：<https://github.com/Tencent/openclaw-weixin>
- README：<https://github.com/Tencent/openclaw-weixin/blob/main/README.md>
- 本设计直接引用的源码路径（仓库内 `src/`）：
  - `src/monitor/monitor.ts` —— getUpdates 长轮询循环（含 stale token / abort / 网络分类）
  - `src/messaging/process-message.ts` —— 入站处理（鉴权 + 路由 + 媒体 + 回复）
  - `src/api/api.ts` —— 端点与身份头
  - `src/auth/accounts.ts`、`src/auth/pairing.ts` —— 账号存储与配对白名单
  - `src/cdn/upload.ts`、`src/media/media-download.ts` —— 媒体 CDN
  - `src/messaging/send-media.ts`、`src/messaging/send.ts` —— 出站

### 协议/机制参考（secondary，须再核对）

- 架构说明：<https://openclaw-weixin.newfuture.cc/en/architecture.html>
- OpenClaw WeChat 通道文档：<https://docs.openclaw.ai/channels/wechat.md>
- 深入分析（第三方）：<https://cipherhub.cloud/en/posts/ai-agent/openclaw-weixin-bot-analysis/>

### 已知问题（行为不明确时的参考）

- [Bug] getUpdates at-least-once delivery 重复触发 AI 管线：
  <https://github.com/Tencent/openclaw-weixin/issues/239>

### 本地实现对照

- `src/weixin/`（api / auth / cdn / media / messaging / monitor / storage / util）
- `src/weixin/auth/login-qr.ts`（扫码状态机）
- `src/weixin/monitor/monitor.ts`（长轮询）
- `src/weixin/transport.ts`（每账号 ILinkWeixinTransport facade）
- `src/projects/`（项目路由、绑定账号用户范围与广播）
- `src/sessions/`（busy / TurnContext / 命令与会话状态机）
- `src/pi/`、`src/weixin/interaction-controller.ts`（Pi host 与微信 UI 闭环）

---

## 11. 扫码身份与入站发送者核查（2026-10-21）

本节使用固定上游 commit，区分客户端行为与服务端保证；不是实际账号日志验证。
本地已按[需求 0009](requirements/0009-project-weixin-user-simplification.md) 移除动态参与者登记，统一向账号登录用户投递，并使用精确 token；不新增普通入站 sender 身份过滤。决策及行为变化见 [ADR-0007](adr/0007-project-weixin-users.md)。

- 腾讯官方 `Tencent/openclaw-weixin`，固定 commit `874637a0dbc24050f72d1385add4fc6170a2d726`：[扫码返回 userId](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts#L460-L473) 与 [入站授权](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/process-message.ts#L184-L200) 分开处理；普通消息使用实际 sender，allowFrom 为空时才以登录 userId 作为授权列表兜底。这是客户端策略，不是服务端身份恒等保证；该版本插件 slash handler 在这段授权之前运行，不能概括为所有入口都先校验。
- 腾讯正常回复以 [入站 from_user_id 和 context_token](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts#L255-L270) 为上下文，并非一律用扫码 userId。官方 [协议说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L248) 建议回传入站 token；客户端能发出无 token 请求不等于服务端一定接受。
- Hermes `NousResearch/hermes-agent`，固定 commit `cb6bcb401e4387459b67d46c0fae55192ad7cb01`：adapter 已迁移到 `plugins/platforms/weixin/adapter.py`。[扫码身份保存为 user_id](https://github.com/NousResearch/hermes-agent/blob/cb6bcb401e4387459b67d46c0fae55192ad7cb01/plugins/platforms/weixin/adapter.py#L645-L654)，[入站](https://github.com/NousResearch/hermes-agent/blob/cb6bcb401e4387459b67d46c0fae55192ad7cb01/plugins/platforms/weixin/adapter.py#L879-L912) 使用 from_user_id 和可配置 DM policy，不强制等于登录 user_id；与 bot account ID 的比较是排除自己，不是扫码用户校验。
- Hermes [发送](https://github.com/NousResearch/hermes-agent/blob/cb6bcb401e4387459b67d46c0fae55192ad7cb01/plugins/platforms/weixin/adapter.py#L1037-L1060) 使用传入 chat_id，并查找该账号/用户对应 token。它的 tokenless fallback 是实现选择，不能当作腾讯协议保证或本项目新增 fallback 的理由。
- 结论：两个 adapter 都分别获取扫码身份与 sender，普通私聊回复均使用 sender。未找到 sender 与扫码身份永远相等或 token/recipient 强绑定的服务端契约。保留精确 token 关联是本项目明确规则；统一按 account.userId 出站则是本项目的产品决策，不声称复刻这些 adapter 的回复策略。


未取得同账号完整登录响应与入站报文关联日志；现有登录日志的 ID 前缀和长度不足以证明完整相等。

---

## 附：已验证 vs 待验证

**本轮通过读源码直接验证**：

- 登录产物 `ilink_bot_id`/`bot_token`/`ilink_user_id`/`baseurl`。
- `getupdates` 端点与 `get_updates_buf` cursor 契约、`context_token` 需回传。
- 官方 `processOneMessage` 的「道 1（pairing 鉴权 + 扫码人兜底）+ 道 2（resolveAgentRoute）」。
- 本地 `src/` **无**发送方 pairing/allowFrom 鉴权。
- stale token `-14` 按账号暂停 1h，非全局失效。
- 本地已实现 transport project gate 先于媒体下载；明确的 BOT/非 USER 记录更早被丢弃。

**仍待实证 / 确认**：

- Tencent `main` 当前实际 CHANGELOG 与 `2.4.7` / `2.4.6` 兼容结论（§9）。
- getUpdates 是否 at-least-once（issue #239）对 daemon 去重的实际影响。
- 已落地的「先门后下」和 BOT gate 在更多真实账号/报文上的兼容性。
