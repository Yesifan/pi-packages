# 需求 0010：项目默认会话、CLI prompt 与 MCP

---

status: not-started
execution_time: "2026-10-21"
commit: null
version: null
related_documents:
  - "[需求 0009：微信用户与投递简化](0009-project-weixin-user-simplification.md)"
  - "[需求 0007：CLI 广播](0007-project-cli-broadcast.md)"
  - "[领域模型](../domain-model.md)"
  - "[消息路由](../routing.md)"
  - "[ADR-0004：分层](../adr/0004-layering-and-dependency-direction.md)"
  - "[ADR-0005：Slash 命令](../adr/0005-weixin-slash-session-controls.md)"
  - "[ADR-0006：会话级回复](../adr/0006-session-wide-agent-reply-routing.md)"

---

## Goal

用户希望微信、CLI 和远程 MCP 共用 project 的 Pi 会话，默认继续工作而不是反复新建；能够选择回复出口、查询会话状态和历史，并通过服务器已部署的 Authelia 登录后从 Codex 或 ChatGPT 使用这些能力。保持单 runtime、共享上下文和无队列的简单模型。

## Solution

每个 project 保存一个 default session，并共享至多一个 active session 和 runtime。微信消息继续 active，CLI/MCP prompt 未指定 session 时使用 default；显式切换对整个 project 生效，并向项目微信用户发送切换通知。闲置回收 runtime 后，下次恢复 default。

新增 `pi-wx prompt`，扩展 `/resume`、`/new` 并新增 `/default`。提供 Streamable HTTP MCP、Authelia OAuth、用户绑定，以及 prompt、广播、列表、状态和历史工具。微信用户与投递模型以需求 0009 为前置约定。

## User Stories

1. 作为项目用户，我希望 daemon 重启或闲置关闭后继续 project 默认会话，不丢失历史上下文。
2. 作为共享项目用户，我希望任一用户切换会话后所有人使用同一 active session，并收到明确的微信通知，不维护每用户会话指向。
3. 作为 CLI 用户，我希望发送文本到默认、指定或新建会话，并选择最终文本回到终端、微信用户或两者组合。
4. 作为微信用户，我希望用 `/resume default` 回默认，用 `/new` 新建，用 `/default` 指定默认；设置默认不强制切换当前 active。
5. 作为 MCP 用户，我希望长任务可以异步提交，通过 session 查询状态和历史，不需要额外 request ID 或任务系统。
6. 作为 CLI/MCP 用户，我希望遇到确认、选择或输入时收到文字询问，再通过下一次 prompt 回答，保持与微信类似的交互方式。
7. 作为项目用户，我希望忙时新任务被明确拒绝，而不是排队、偷偷切换会话或中断已有任务。
8. 作为 MCP 用户，我希望分页查询会话历史，按角色过滤、关键词搜索并获取匹配的完整消息文本。
9. 作为服务器管理员，我希望 Authelia 身份绑定微信 `userId`，用户只访问所属 project；同 project 共享会话、历史和投递权限。
10. 作为调用者，我希望区分模型执行失败与微信投递失败；会话不存在、默认历史丢失、目标不属于项目或未授权时得到明确错误。

## Implementation Decisions

### 一个 project、一个 active、一个 runtime

- session 是 Pi 持久会话历史及其 ID；runtime 是加载并执行该历史的运行实例。释放 runtime 不删除 session。
- 一个 project 可以保留多个历史 session，但首版只加载一个 active session、持有一个 runtime、执行一个任务。不引入每用户 active、多 runtime 或多会话并行调度。
- project 持久保存 default session 身份，不用“最近修改的历史文件”猜测默认。首次需要默认且从未设置时懒创建；重启后按记录恢复 default，不承诺恢复临时 active 或进行中的任务。
- default 文件不存在/无法读取时明确失败，不静默新建替代；允许通过显式新建并设置 default 修复。
- 普通微信消息使用 active；没有 active 时恢复 default。CLI/MCP 普通 prompt 未指定 session 使用 default，并使其成为 active。
- 指定 session 则切换并执行；指定新建则新建并切换，不替换已有 default。只有一个全项目共享 active，用户 A 切到 A 会话后，用户 B 的下一条微信普通消息也进入 A。
- 切换与 reply 目标无关，不存在“成功投递给某用户后才激活”的机制。
- 项目级 busy 时拒绝新任务及会话切换，即使目标是另一个 session；保留已有状态/中止控制能力。等待交互时，合格回答走原任务而非新任务。
- 延用项目共享的 10 分钟闲置计时和既有 busy 保护，不新增每用户计时器。active 闲置回收后清除临时 active，下一次使用 default；default 本身闲置不改变其身份。普通 broadcast 不激活会话或刷新闲置时间。

### 会话切换通知

- 实际切换到另一个 session 后，向 project 微信用户发送 `当前会话已切换为「<session title>」` 通知；范围与 broadcast 一致，与 reply 无关，包括 `reply=caller` 的切换。
- 同一 session 不重复通知；无标题时以 session ID 作为可识别的替代文字。
- 通知只在切换成功后发出，不因通知部分失败回滚已成功切换的会话；记录投递结果，沿用 broadcast 的尽力发送策略，不自动重试。
- `/default` 仅修改默认指向而不实际切换时，不伪造“当前会话已切换”通知；正常命令反馈保留。

### 微信命令

| 命令 | 行为 |
| --- | --- |
| `/resume` | 保留现有历史会话分页选择，选择后切换 project active |
| `/resume <id>` | 切换到指定历史 session |
| `/resume default` | 切回 project default |
| `/resume latest` | 保留已有兼容入口，不把 latest 等同于 default |
| `/new` | 显式新建并切换 active，包括当前无 runtime 的情况；不修改已有 default |
| `/default` | 将当前 active 设为 project default；没有 active 时明确提示 |
| `/default <id>` | 将指定 session 设为 default，不强制切换 active |

不新增 `/session`。保留 `/help`、`/status`、`/abort`、模型/思考强度等现有命令能力；帮助和状态同步显示 active/default 的区别。

### CLI prompt 与 reply

公开形式为 `pi-wx prompt "消息" --project <project>`，支持可选 `--session <id>` 或 `--new-session`，二者互斥。CLI 继续通过本地 UDS 访问 daemon，不要求本机 CLI 走 OAuth。

- 默认 `--reply caller`；可重复提供 `--reply`，支持 `caller`、`user:all`、`user:<id>` 的组合，最终微信目标去重。
- `user:<id>` 的 ID 为 `account.userId`，必须来自指定 project 的绑定账号；`user:all` 为该 project 全部微信用户。拒绝未知或跨项目目标，不把空目标默认为所有人。
- reply 控制成功最终文本投递，不控制会话切换通知。调用方始终获得 session ID、执行状态、错误及可用投递结果；未选择 caller 时不把成功最终正文重复回给调用方。
- CLI 默认等待完成或需要交互时返回。流式文字输出仅在现有接口可低成本复用时加入，不作为首版验收必要项；不增加第二套回复累积机制。
- project 不存在、未启用、daemon 不运行、空白 prompt、参数冲突及非法 session/目标明确失败。会话变更前完成参数和权限校验。
- 不自动重试，不承诺客户端断开会撤销已启动工作；重复提交可能产生重复执行或投递。

### MCP 工具

工具通过 Streamable HTTP 暴露，同步复用项目/会话领域能力，不复制 CLI 业务规则。

| 工具 | 契约 |
| --- | --- |
| `broadcast` | project + message；直接发送给所有项目微信用户，不调用 Pi、不切会话，busy 仍可使用 |
| `prompt` | project + message，可选 session/new_session、reply、异步选项；与 CLI 共享选择和投递规则 |
| `list_user` | 列出指定 project 的绑定微信用户，ID 与 reply/身份绑定一致 |
| `list_project` | 列出已授权 project，包含 active/default 身份 |
| `list_session` | 列出已授权 project 的历史 session，提供 ID、标题及 active/default 标记 |
| `get_session_status` | 按 project + session 查询当前状态，包含加载状态、运行/等待交互/空闲及可用询问文本 |
| `get_session_history` | 按 project + session 分页读取历史，支持角色过滤和文本关键词搜索 |

- MCP prompt 默认异步，接受后返回 session ID 和当前状态；允许选择同步等待，遇到交互询问也须返回而非死等。
- 异步结果通过 session 状态与历史获取，不增加 request_id、get_request、持久任务表或后台任务队列。异步 `caller` 不承诺在已返回的调用上主动推送最终正文，调用方通过历史查询获取；同步 `caller` 则在本次调用完成时返回正文。reply 是投递选项，不是历史访问控制；未选 caller 的已授权用户仍可读取会话历史。
- 查询是 session 级视图，不保证精确关联到某次已结束的 prompt；后续回合可能已改变同一 session 的当前状态。需要最终文本时读取历史。
- Pi 提供的执行状态和历史由 Pi 作为唯一来源；SDK 差异封装在现有 Pi 边界。pi-wx 只复用必要的现有控制器状态（例如 UI waiter、busy 和微信投递），不维护第二套模型运行状态机或历史副本。
- 历史未加载不表示执行失败；状态查询不为读取历史创建或切换 runtime。
- 历史采用游标分页，按消息角色过滤；关键词为普通文本搜索，不做正则或语义检索。搜索结果返回命中消息的完整文本，而非仅命中片段或整份会话。过滤/搜索先于分页。
- 默认历史仅返回用户/助手文本；显式按角色过滤时允许查看工具调用及结果，始终不返回 thinking。
- 列表、状态、历史及广播均受相同 project 授权约束；不将任意客户端文件路径视为可读取的 session。

### 下一次 prompt 回答交互

- 沿用微信的文字询问、下一条消息回答机制；确认、选择、输入不自动批准，不因无 TUI 就默认为成功。
- project 等待 UI 时，原调用身份的下一次 prompt 作为回答，不新开回合、不因省略 session 而切回 default；显式指定其他 session 或 new_session 不能绕过等待状态。
- CLI 使用本地可信控制面来源，MCP 使用认证主体，微信使用已有来源关联；保持询问收件人与回答者一致，不向其他主体开放待回答权。
- 状态查询可显示待回答文本；查询权限不等于回答权限。不新增询问 ID，仍由单 project 单活动询问仲裁。
- 回答沿用原回合目标，不通过回答请求改变 reply；等待期间其他新任务被拒绝。交互超时、取消及 abort 继续使用既有机制。

### 最终文本与独立回合

- 微信发起的普通回合继续按 project 微信用户广播最终文本；CLI/MCP 发起回合使用显式 reply，避免既走默认广播又重复投递。
- 没有当前微信/CLI/MCP 请求来源的独立 Agent 回合，例如扩展主动触发后续回合，最终成功文本仍发给 project 微信用户，范围与 broadcast 一致，不另设复杂受众策略。
- 保留既有回合结算、重试完成后发送及旧 session 事件隔离机制，不按每个流式片段广播。
- reply 不影响微信发送工具；CLI/MCP 即使仅选择 caller，也可以使用微信发送工具。工具收件人独立于最终回复目标，仍须来自 project 微信用户并使用精确 token，不能伪造 sender/token。CLI/MCP 没有原微信 TurnContext，微信发送工具未指定用户时默认发送给 project 全部微信用户，与 broadcast 的用户范围一致；显式指定时只发送给指定的项目微信用户。交互询问由上面的调用方机制处理。

### Authelia OAuth 与用户绑定

- 使用服务器已部署的 Authelia，而非先前讨论的 Authentik。Codex 与 ChatGPT 分别预注册 OAuth 客户端，使用授权码流程及 PKCE；不自建登录/授权服务器，不依赖 DCR/CIMD。
- MCP 提供公开的受保护资源元数据，以及未授权请求的标准 Bearer challenge；发现接口公开不等于工具公开。
- MCP 每次请求验证 access token 的签发者、有效性、受众、有效期及权限；不能使用 ID token 替代 access token，不能通过关闭 audience 校验适配客户端。
- 部署使用 HTTPS，由现有 Caddy 反向代理终止 TLS；公网仅使用 1144，拟定 MCP 地址为 `https://wx.yhome.ximing.cc:1144/mcp`，认证门户为 `https://auth.yhome.ximing.cc:1144`。DNS、证书和公网可达性部署时验证，MCP 不套普通 forward-auth 的 302 登录跳转，使用 Bearer/OAuth 机制。
- 已部署 Authelia v4.39.28；2026-10-21 只读检查运行容器确认没有 `identity_providers` 配置段，目前仅有 forward-auth，尚未启用 OIDC。需配置 OIDC Provider，并先联调令牌形态、resource/audience、发现和客户端回调。检查不代表已授权修改或重启部署服务。
- 身份以稳定的 `(issuer, subject)` 绑定一个或多个微信 `account.userId`；pi-wx 提供本地管理员维护的身份绑定配置，与 project 配置一起管理，不增加独立用户数据库。不让 MCP 调用参数自行认领身份，不使用显示名/邮箱作为唯一主键。
- 初始绑定为 Authelia 登录用户 `yesifan` → 当前微信账号 `ye` 对应的 `account.userId`。通过实际 OIDC 登录取得 subject，不假定 sub 等于 yesifan；配置保存稳定身份与 userId，账号别名仅用于管理员识别。OIDC 客户端注册和密钥属于 Authelia 部署配置，不混入微信身份绑定数据。
- 用户可访问其绑定微信账号所属 project；同一 project 内共享会话、历史和向所有项目用户投递的权限，不做用户之间的会话隔离。无绑定或无 project 权限时拒绝。
- project 绑定和身份绑定变化后的请求以当前有效配置授权；日志不记录访问令牌、客户端密钥或完整敏感历史。
- 首版不并行增加 auth-key、匿名工具模式、stdio MCP 或额外认证网关。

### 分层、状态和兼容性

- CLI/UDS/MCP 为入口适配，复用 project/session 能力；只有既有 Pi SDK 边界访问 SDK，会话历史不另建数据库。
- 持久状态只增加实现所需的 project 默认会话指向、认证/身份绑定配置等，不引入每用户 active 指向和请求执行记录。
- 实施时同步更新 README、领域模型、路由及相关帮助，并用新 ADR 记录共享默认会话与远程认证边界；关联旧 ADR，不覆盖旧理由。
- 本 spec 调整现有“idle 后新建”“重启不恢复”、inactive `/new` 和统一广播所有来源回合等约定；保留跨 project 隔离、busy 拒绝及 CLI broadcast 的独立发送能力。

## Testing Decisions

用户已确认：沿用 daemon/project + fake 微信 transport / Pi runtime 的集成边界验证会话与真实本地 UDS RPC；MCP 增加真实本地 HTTP 与测试令牌集成测试。真实 Codex、ChatGPT、Authelia 登录另做人工验收，不进入默认离线测试，不调用真实模型或自动发送真实微信。

1. 首次默认懒创建、重启恢复、闲置释放后回默认、默认文件丢失明确失败；显式新建可修复，不能悄悄替换默认。
2. 两用户共享 active：一方 `/resume` 或 CLI/MCP 切换后另一方微信消息使用同一 session；修改 default 不立即切 active。忙时不同 session 也拒绝，其他 project 不受影响。
3. 切换成功向 broadcast 同范围用户发送标题通知，caller-only 也通知；同会话不重复，切换失败无误报，通知失败不回滚切换。
4. 经真实 UDS 验证 prompt 的默认/指定/新建、参数互斥、reply 组合去重、未知目标、执行失败和投递失败；broadcast 不激活或刷新会话。CLI/MCP 即使 reply=caller 也能调用微信发送工具，未指定用户时发送给全部 project 微信用户，指定用户时只发送给选定用户。
5. HTTP 工具调用覆盖异步接受、同步完成、状态轮询、历史读取及忙时拒绝，无 request ID 或任务恢复依赖。未加载历史只读取不切换当前会话。
6. 交互询问能返回文字，下一次同身份 prompt 回答且不切换 default；错误身份、新建/跨 session 请求不能消费询问；超时/取消不自动批准。
7. 历史分页、角色过滤及关键词返回完整匹配消息一致，无重复/漏页，默认不泄露 thinking；不存在/越权 session 不读取。
8. OAuth 发现和 challenge 正确；缺失、失效、签发者/受众错误的令牌拒绝；无身份绑定或跨 project 调用拒绝。所有列表/状态/历史入口同样授权。
9. 独立 Agent 回合继续向 project 微信用户投递一次，不被上一 CLI/MCP reply 污染，旧 session 事件不混入新会话。

代码阶段立即对本阶段改动格式化，运行包类型检查与相关离线测试。人工验收至少覆盖 Codex 和 ChatGPT 经部署的 Authelia 登录、调用/交互/历史查询及越权拒绝；失败或未验证必须明确记录。

## Out of Scope

- 本次不实现同 project 多 runtime 或多个并发活动 session；不引入每用户 active session、排队执行或会话私有受众。
- request_id、独立任务状态库、跨重启任务恢复、持久化输出队列、恰好一次执行或自动重试。
- 自建 OAuth 授权服务器、DCR/CIMD、API key、匿名 MCP、stdio MCP、按同 project 用户细分会话权限。
- 正则/语义历史搜索、thinking 暴露、另建历史索引或数据库。
- 无关重构、发布或远端状态变更。

## Further Notes

- **明确后续 feature：同 project 多 runtime、多 session 并发。** 本次保留简单单 runtime，不为它预建调度抽象；未来应另立 spec，重新定义 active、交互和并发语义。
- 用户已确认测试边界、共享 active、会话切换独立于 reply 并必须通知微信、Authelia 用户绑定及 project 级权限。预注册客户端、管理员配置一对多身份绑定沿用对话中已接受的最小方案；具体配置形式须根据部署版本联调，若预注册无法兼容客户端，应询问后再调整，不擅自增加注册服务。早期讨论中的每用户 active、投递成功才激活、Authentik 和 request_id 方案均已弃用。
- 用户明确允许相同 cwd 的多个 project 读取彼此的会话，不增加会话所有权登记或隔离。授权检查仍针对请求中的 project；会话历史范围沿用该 cwd 的 Pi 历史。管理员将同 cwd 的项目视为共享历史范围，不能据此访问其他 cwd 的历史。
- 核实 Pi 锁定版本接口仅指确认现有 SDK 如何读取历史、查询运行状态及处理交互，以便复用；不是新增产品限制，不因此重建历史或任务系统。
- CLI/MCP 微信发送工具默认向 project 全部微信用户发送、且不受 reply 影响已经确认。历史默认用户/助手文本、显式查询工具消息且不返回 thinking 已确认；API 参数细节在实施时保持简单。
- 无 request ID 时客户端只能查询 session 当前状态和历史，不能获得跨重启的某次请求收据。UI 和投递状态是 pi-wx 自身信息，不能声称 Pi 自动维护这些内容。
- 账号 `userId` 与入站 sender 的证据核实按需求 0009 执行。Authelia 联调若有兼容障碍，先报告并确认方案，不改用无认证或放宽令牌验证。
