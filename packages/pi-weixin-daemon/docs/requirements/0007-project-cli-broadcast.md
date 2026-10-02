# 需求 0007：通过 CLI 向项目绑定用户广播通知

---

status: completed
execution_time: "2026-10-01 / 2026-10-01"
commit: null
version: null
related_documents:
  - "[领域模型](../domain-model.md)"
  - "[路由与会话生命周期](../routing.md)"
  - "[微信 iLink 协议](../ilink-protocol.md)"
  - "[ADR-0004：分层与依赖方向](../adr/0004-layering-and-dependency-direction.md)"
  - "[需求 0006：活动 Pi 会话的统一最终文本回复](0006-session-wide-agent-replies.md)"

---

## Goal

项目维护者希望从终端或脚本向指定 project 所有绑定账号的扫码登录用户发送同一条微信通知，不需要让 Pi 处理消息，也不依赖当前会话的参与者记录。

## Solution

提供 `pi-wx broadcast --project <name> --message "通知内容"`。CLI 通过运行中的 daemon 的本地 UDS RPC 发送通知，等待处理完成；逐用户发送结果写入 daemon 日志，CLI 通过简短反馈和退出码表达整体结果。

仅启用的 project 允许广播。缺少接收用户或 context token 时跳过并记录日志，不进行 token 有效期的本地时间判断。

## User Stories

1. 作为项目维护者，我希望指定 project 和通知文本，使该项目所有绑定账号的扫码登录用户收到同一条消息，而其他项目不受影响。
2. 作为脚本调用者，我希望复用 CLI 并等待广播处理完成，通过退出码判断是否全部发送成功，无需额外 HTTP 服务。
3. 作为项目维护者，我希望启用的项目在 Pi busy 或没有活动会话时仍能发送通知，不触发 Agent 回合、不创建会话，也不改变现有会话状态。
4. 作为项目维护者，我希望停用的项目拒绝广播，避免向已停用项目的用户发送通知。
5. 作为运维人员，我希望缺少接收用户或 context token 的账号被跳过，单账号发送失败不阻断其他账号，并能从 daemon 日志查明原因。
6. 作为脚本调用者，我希望 daemon 未运行、project 不存在或消息为空白时明确失败，而不是得到虚假的发送成功结果。
7. 作为运维人员，我希望能识别部分成功、全部失败及没有绑定账号的情况，同时避免自动重试造成重复通知。

## Implementation Decisions

### 入口与控制面

- 初始公开入口仅为 CLI；手动和脚本调用使用相同命令。
- `--project` 和 `--message` 均必填；空字符串或纯空白文本拒绝发送。非空文本保留原始内容和换行，不追加微信发言者或 Agent 标记。
- 使用现有本地 UDS RPC，新增 `project.broadcast` 操作。请求携带项目名与文本；响应提供成功、跳过、失败数量，供 CLI 判断整体结果。单个目标失败不作为整个 RPC 的异常提前终止。
- daemon 未运行、project 不存在或停用、请求参数无效时请求失败，不发送消息。
- 启用状态不要求存在活动 Pi 会话，也不要求 Pi 空闲；广播不得调用 Pi、登记新参与者、改变 busy 状态或刷新会话空闲计时。

### 接收对象与发送

- 接收集合来自指定 project 的绑定账号，每个账号的接收方是账号持久保存的扫码登录用户 `userId`。
- 此集合与现有 Agent 回复广播使用的实际参与者注册表不同；不改变需求 0006 的回复接收规则。
- 按精确的 `(accountId, userId)` 查找 context token。即使缓存存在其他 sender 的 token，也不得借用或猜测 ID 映射。
- 绑定账号无法解析、缺少用户 ID、缺少 context token 或无法取得可用 transport 时，跳过该账号并记录原因。
- 逐账号尽力发送；一个账号发送失败仍继续处理其他账号。复用现有账号 transport、文本发送及长文本分块行为。
- 成功指现有发送路径完成且未报错，不承诺微信真人已阅读；分块文本后续发送失败时可能已部分送达，该目标记为失败。
- 项目没有绑定账号时不发送，记录日志，整体结果不视为全部成功。

### context token

- 不新增 token 时间戳、24h/48h 有效期判断、自动续期或无 token 重试，不改变已有持久化缓存格式。
- 缓存附近注释说明：协议文档未明确规定 context token 有效期；社区有 24h 失效报告，也有约 48h 的报告，不能当作固定 TTL 保证。
- 有 token 不代表仍有效；发送是否被接受以微信接口实际结果为准。

### 日志与 CLI 结果

- daemon 日志记录项目、账号、接收用户、成功/跳过/失败状态、跳过原因或安全的发送失败分类，并记录最终汇总。上游异常可能回显分块正文或凭据，不直接记录异常文本、stack 或 cause。
- 不记录 context token、账号凭据或完整通知正文；详细逐用户结果不打印到 CLI。
- CLI 等待完成后给出简短提示，告知详细结果在 daemon 日志中，可通过 `pi-wx logs` 查看。
- 所有绑定账号均发送成功且接收集合非空时退出码为 `0`。
- 请求失败、存在跳过或发送失败、没有绑定账号时退出码为 `1`。

### 超时、重试与职责

- 仅广播 RPC 不使用普通 RPC 客户端的 15 秒总超时，等待广播处理完成；其他 RPC 超时行为保持不变。
- 微信单次请求保留现有超时，不新增自动重试。CLI 断开不等于撤销 daemon 中已经开始的发送；再次调用可能导致重复通知。
- 不提供跨 daemon 重启补发或恰好一次送达保证。
- 项目层负责项目规则与接收范围，账号/微信层提供账号资料、token 及实际发送能力，daemon 负责组合，CLI/RPC 负责控制面。
- 保持现有 Pi SDK 边界，不让广播功能依赖 Pi SDK，不新增通用通知框架、数据库或队列。
- 实现时同步更新用户 README 并添加受影响包的 patch changeset；本 spec 本身不表示功能已经可用。

## Testing Decisions

主要沿用现有「真实 daemon + 真实 UDS RPC + fake 微信 transport / Pi runtime」集成测试边界，验证用户可观察行为，避免为每个内部方法分别建测试。

1. 经 RPC 向多账号项目广播，确认只有指定项目的扫码登录用户收到原始文本，每次发送携带对应账号和用户的 token。token 在重启后恢复时仍可用于广播，不要求重新建立参与者注册表。
3. 不存在或停用的 project、空白文本被拒绝且没有发送；缺少账号资料、用户 ID、token、可用 transport 及无绑定账号时，按约定跳过或零发送并记录日志。
4. 单目标发送失败后其他目标继续；结果统计与实际发送一致，daemon 保持可用。成功、跳过、失败日志及汇总可被验证，日志不泄露 token、凭据或通知正文。
8. 不增加真实微信或真实模型的自动化测试要求；真实送达能力需使用真实账号另行验证。

代码编写阶段立即对改动文件执行根 Biome 检查/格式化，再运行受影响包类型检查及相关单元、RPC/CLI 集成测试。不为本功能修改无关测试边界。

## Out of Scope

- HTTP API、额外 SDK、定时广播、stdin/文件输入、图片或附件通知。
- 将通知送入 Pi、生成 Agent 回复或改变既有会话级回复广播。
- 接收用户管理、参与者持久化、owner/sender ID 转换或新增鉴权机制。
- token 本地有效期、刷新、重登录或无 token 发送策略。
- 发送队列、后台任务查询、跨重启补发、幂等键和自动重试。
- 发布、推送分支或变更其他包。

## Further Notes

- 本需求在 `feat/pi-wx-project-broadcast` 分支完成实现。全仓类型/Biome 检查、受影响包离线测试（25 个文件、161 项）及构建通过；真实微信送达未验证。
- 本 spec 对 owner 的显式通知是新的接收规则，不覆盖领域文档中既有「使用实际 sender 的回复」规则；实现时应明确区分二者。
- token 有效期核查来源：腾讯参考实现 [context token 缓存](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/messaging/inbound.ts) 及 [协议文档](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol.md) 未明确固定 TTL；社区 [issue #202](https://github.com/Tencent/openclaw-weixin/issues/202) 报告 24h，[issue #225](https://github.com/Tencent/openclaw-weixin/issues/225) 报告约 48h。社区报告不是服务端保证。
- 用户已确认存放位置、CLI 整体结果约定、超时与会话行为；测试范围仅保留原第 1、3、4、8 项，不另增 owner/sender 差异、会话生命周期、RPC 超时或 CLI 专项测试。没有阻塞实施的待确认项。
