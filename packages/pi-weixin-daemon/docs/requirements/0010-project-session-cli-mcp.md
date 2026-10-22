# 需求 0010：项目默认会话与 CLI prompt

---

status: completed
execution_time: "2026-10-21 / 2026-10-22"
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
  - "[ADR-0008：共享默认会话与 CLI 回合来源](../adr/0008-shared-default-session-cli.md)"

---

## Goal

用户希望微信和 CLI 共用 project 的 Pi 会话，默认继续工作而不是反复新建，并能够选择 CLI prompt 的回复出口。保持单 runtime、共享上下文和无队列的简单模型，保留现有微信状态查询及 Pi 历史会话列表、恢复能力。

## 实施状态与实施前基线

以下 Solution 及 Implementation Decisions 描述本需求的完整目标。默认会话、微信会话命令、CLI prompt/reply、交互及文件目标能力的核心实现已完成。实现阶段报告最新完整检查离线 30 文件 / 237 测试、typecheck、build、Biome 和 diff check 通过；最终针对性静态独立审查已完成，无剩余阻塞问题，需求状态为 `completed`。下表仅记录实施前历史基线，不描述当前源码。

| 范围 | 实施前实现（历史） | 本需求新增或调整 |
| --- | --- | --- |
| 会话生命周期 | `src/sessions/session-controller.ts` 按需创建单 runtime，闲置后真正关闭；`src/pi/sdk-host.ts` 通过 `SessionManager.create(cwd)` 新建 | 持久化 default，重启及闲置后恢复；`src/projects/types.ts` 新增默认会话字段 |
| 微信命令 | inactive `/new` 只提示发消息；`/resume` 支持分页选择和 `latest`，其他参数也进入选择器 | inactive `/new` 实际新建；新增按 ID/default 恢复及 `/default`；帮助和状态区分 active/default |
| 切换反馈 | 新建、恢复只向命令来源反馈 | 实际切换后向全部项目微信用户通知 |
| CLI 与控制面 | `src/cli/index.ts`、`src/daemon/rpc-server.ts` 尚未接入 prompt；daemon 仅启动本地 UDS 控制面 | CLI prompt 和相应 RPC |
| 最终回复 | `SessionController.deliverOutcome` 将成功非空最终文本统一交给广播 hook | CLI 按 reply 分流，保留微信及独立回合广播 |
| UI 与文件 | UI 回答绑定微信 turn；`src/pi/extensions/weixin-send-file.ts` 只有 path/caption 参数，无微信 turn 时失败 | 新增 CLI 调用来源与回答路径；文件工具新增目标选择及无微信来源时的项目广播能力 |
| 历史会话 | `src/sessions/runtime-port.ts` 已有列表、恢复和状态接口 | 复用现有 Pi 历史会话列表和恢复能力，不扩展历史读取 RPC |

当前模型/思考强度的“项目默认值”写入项目 Pi settings，与本需求的“默认会话身份”是不同概念。广播、精确 token 投递、busy 拒绝和旧会话事件隔离属于保留的回归基线，多入口 prompt 仍须独立验收。

## Solution

每个 project 保存一个 default session，并共享至多一个 active session 和 runtime。微信消息继续 active，CLI prompt 未指定 session 时使用 default；显式切换对整个 project 生效，并向项目微信用户发送切换通知。闲置回收 runtime 后，下次恢复 default。

新增 `pi-wx prompt`，扩展 `/resume`、`/new` 并新增 `/default`。CLI 沿用本地 UDS 控制面；微信用户与投递模型以需求 0009 为前置约定。

## User Stories

1. 作为项目用户，我希望 daemon 重启或闲置关闭后继续 project 默认会话，不丢失历史上下文。
2. 作为共享项目用户，我希望任一用户切换会话后所有人使用同一 active session，并收到明确的微信通知，不维护每用户会话指向。
3. 作为 CLI 用户，我希望发送文本到默认、指定或新建会话，并选择最终文本回到终端、微信用户或两者组合。
4. 作为微信用户，我希望用 `/resume default` 回默认，用 `/new` 新建，用 `/default` 指定默认；设置默认不强制切换当前 active。
5. 作为 CLI 用户，我希望遇到确认、选择或输入时收到文字询问，再通过下一次 prompt 回答，保持与微信类似的交互方式。
6. 作为项目用户，我希望忙时新任务被明确拒绝，而不是排队、偷偷切换会话或中断已有任务。
7. 作为调用者，我希望区分模型执行失败与微信投递失败；会话不存在、默认历史丢失或目标不属于项目时得到明确错误。

## Implementation Decisions

### 一个 project、一个 active、一个 runtime

- session 是 Pi 持久会话历史及其 ID；runtime 是加载并执行该历史的运行实例。释放 runtime 不删除 session。
- 一个 project 可以保留多个历史 session，但始终只加载一个 active session、持有一个 runtime、执行一个任务。不引入每用户 active、多 runtime 或多会话并行调度，也不为此预留扩展抽象。
- project 持久保存 default session 身份，不用“最近修改的历史文件”猜测默认。从未设置 default 时，首个成功激活的会话（包括显式新建或恢复历史）自动成为 default；首次需要默认且无 active 时懒创建；重启后按记录恢复 default，不承诺恢复临时 active 或进行中的任务。
- default 文件不存在/无法读取时明确失败，不静默新建替代；允许通过显式新建并设置 default 修复。
- 普通微信消息使用 active；没有 active 时恢复 default。CLI 普通 prompt 未指定 session 使用 default，并使其成为 active。
- 指定 session 则切换并执行；指定新建则新建并切换，不替换已有 default。只有一个全项目共享 active，用户 A 切到 A 会话后，用户 B 的下一条微信普通消息也进入 A。
- 切换与 reply 目标无关，不存在“成功投递给某用户后才激活”的机制。
- 项目级 busy 时拒绝新任务及会话切换，即使目标是另一个 session；保留已有状态/中止控制能力。等待交互时，合格回答走原任务而非新任务。
- 延用项目共享的 10 分钟闲置计时和既有 busy 保护，不新增每用户计时器。active 闲置回收后清除临时 active，下一次使用 default；default 本身闲置不改变其身份。普通 broadcast 不激活会话或刷新闲置时间。

### 会话切换通知

- 实际切换到另一个 session 后，向 project 微信用户发送 `当前会话已切换为「<session title>」` 通知；范围与 broadcast 一致，与 reply 无关，包括 `reply=caller` 的切换。
- 同一 session 不重复通知；无 active 时显式新建/恢复也通知，仅无 active 时按需恢复 default 免通知；已有不同 active 时，普通 CLI prompt 切回 default 也通知。无标题时以 session ID 作为可识别的替代文字。
- 通知只在切换成功后发出，不因通知部分失败回滚已成功切换的会话；记录投递结果，沿用 broadcast 的尽力发送策略，不自动重试。
- `/default` 仅修改默认指向而不实际切换时，不伪造“当前会话已切换”通知；正常命令反馈保留。

### 微信命令

| 命令 | 行为 |
| --- | --- |
| `/resume` | 保留现有历史会话分页选择，选择后切换 project active |
| `/resume <id>` | 切换到指定历史 session |
| `/resume default` | 切回 project default |
| `/resume latest` | 保留已有兼容行为：已有 active 时不切换；没有 active 时恢复最近历史。不把 latest 等同于 default |
| `/new` | 显式新建并切换 active，包括当前无 runtime 的情况；不修改已有 default |
| `/default` | 将当前 active 设为 project default；没有 active 时明确提示 |
| `/default <id>` | 将指定 session 设为 default，不强制切换 active |

不新增 `/session`。保留 `/help`、`/status`、`/abort`、模型/思考强度等现有命令能力；帮助和状态同步显示 active/default 的区别。

### CLI prompt 与 reply

公开形式为 `pi-wx prompt "消息" --project <project>`，支持可选 `--session <id>` 或 `--new-session`，二者互斥。CLI 继续通过本地 UDS 访问 daemon。

- 默认 `--reply caller`；可重复提供 `--reply`，支持 `caller`、`user:all`、`user:<id>` 的组合，最终微信目标去重。
- `user:<id>` 的 ID 为 `account.userId`，必须来自指定 project 的绑定账号；`user:all` 为该 project 全部微信用户。拒绝未知或跨项目目标，不把空目标默认为所有人。
- reply 控制成功最终文本投递，不控制会话切换通知。调用方始终获得 session ID、执行状态、错误及可用投递结果；未选择 caller 时不把成功最终正文重复回给调用方。
- CLI 默认等待完成或需要交互时返回单个 JSON：可用的 `sessionId`、`status`（success/error/aborted/waiting）、可选 `text`/`error`、辅助 `messages` 和可选 `delivery: { succeeded, skipped, failed }`。delivery 仅统计最终文本微信投递；messages 包含询问、notify、进度及 warning，不受 caller 选择影响，随响应返回而非实时微信推送。不增加第二套回复累积机制或流式输出。
- 执行 error/aborted 或 delivery 有失败/跳过时 CLI 退出 1，其他结果（含 waiting）退出 0。参数校验、busy 或 RPC 请求失败向 stderr 报错并退出 1，不保证 JSON。
- project 不存在、未启用、daemon 不运行、空白 prompt、参数冲突及非法 session/目标明确失败。会话变更前完成参数和项目目标校验。
- 不自动重试，不承诺客户端断开会撤销已启动工作；重复提交可能产生重复执行或投递。

### 下一次 prompt 回答交互

- 沿用微信的文字询问、下一条消息回答机制；确认、选择、输入不自动批准，不因无 TUI 就默认为成功。
- project 等待 UI 时，原调用来源的下一次 prompt 作为回答，不新开回合、不因省略 session 而切回 default；显式指定其他 session 或 `--new-session` 不能绕过等待状态。
- 同 project 的全部本地 CLI 调用视为同一可信来源，可跨终端/进程互相回答，不引入每调用方身份。微信使用已有来源关联；保持询问收件人与回答者一致，不向其他来源开放待回答权。不新增询问 ID，仍由单 project 单活动询问仲裁。
- 回答沿用原回合目标，不通过回答请求改变 reply；等待期间其他新任务被拒绝。交互超时、取消及 abort 继续使用既有机制。

### 最终文本与独立回合

- 微信发起的普通回合继续按 project 微信用户广播最终文本；CLI 发起回合使用显式 reply，避免既走默认广播又重复投递。
- 没有当前微信/CLI 请求来源的独立 Agent 回合，例如扩展主动触发后续回合，最终成功文本仍发给 project 微信用户，范围与 broadcast 一致，不另设复杂受众策略。
- 保留既有回合结算、重试完成后发送及旧 session 事件隔离机制，不按每个流式片段广播。
- reply 不影响文件工具 `weixin_send_file({ path, caption?, userId? })`；CLI 即使仅选择 caller，也可以发送微信文件。工具收件人独立于最终回复目标，仍须来自 project 微信用户并使用精确 token，不能伪造 sender/token。CLI/独立回合没有原微信 TurnContext，未指定 userId 时默认发送给 project 全部微信用户；显式 userId 只能是项目绑定账号的 `account.userId`。微信回合未指定时继续使用来源账号用户。
- `weixin_send_progress({ update })` 和 notify 按回合来源处理：微信定向来源账号用户，CLI 写入响应 messages，不广播微信；进度工具不新增 userId 参数，无活动回合时拒绝。交互询问由上面的调用方机制处理。

### 分层、状态和兼容性

- CLI/UDS 为入口适配，复用 project/session 能力；只有既有 Pi SDK 边界访问 SDK，复用 Pi 历史会话列表与恢复，不扩展历史读取 RPC 或另建历史数据库。
- 持久状态只增加实现所需的 project 默认会话指向，不引入每用户 active 指向。
- 实施时同步更新 README、领域模型、路由及相关帮助，并用新 ADR 记录共享默认会话决策；关联旧 ADR，不覆盖旧理由。
- 本 spec 调整现有“idle 后新建”“重启不恢复”、inactive `/new` 和统一广播所有来源回合等约定；保留跨 project 隔离、busy 拒绝及 CLI broadcast 的独立发送能力。

## Testing Decisions

现有回归基线包括 `test/integration/session-controller.test.ts` 的 busy 拒绝、resume 分页仲裁、`/resume latest` 不替换活动会话、独立回合广播及旧 session 事件隔离，以及 `test/integration/daemon.test.ts` 的精确 token 广播与项目路由隔离。以下列表是新增验收要求；测试执行与最终静态独立审查结果见上方实施状态。

用户已确认：沿用 daemon/project + fake 微信 transport / Pi runtime 的集成边界验证会话与真实本地 UDS RPC，不调用真实模型或自动发送真实微信。

1. 首次默认懒创建，以及显式新建/恢复的首个成功激活自动设为 default；重启恢复、闲置释放后回默认、默认文件丢失明确失败；显式新建可修复，不能悄悄替换默认。
2. 两用户共享 active：一方 `/resume` 或 CLI 切换后另一方微信消息使用同一 session；修改 default 不立即切 active。忙时不同 session 也拒绝，其他 project 不受影响。
3. 切换成功向 broadcast 同范围用户发送标题通知，caller-only 也通知；无 active 时显式新建/恢复通知，仅无 active 时按需恢复 default 免通知，已有不同 active 时普通 CLI 切回 default 也通知；同会话不重复，切换失败无误报，通知失败不回滚切换。
4. 经真实 UDS 验证 prompt 的默认/指定/新建、参数互斥、reply 组合去重、未知目标、执行失败和投递失败；broadcast 不激活或刷新会话。CLI 即使 reply=caller 也能调用微信发送工具，未指定用户时发送给全部 project 微信用户，指定用户时只发送给选定用户。
5. 交互询问能返回文字，同 project 本地 CLI 可互相回答且不切换 default；错误来源、新建/跨 session 请求不能消费询问；超时/取消不自动批准。
6. 独立 Agent 回合继续向 project 微信用户投递一次，不被上一 CLI reply 污染，旧 session 事件不混入新会话。
7. 保留微信 `/status`、`/resume` 等现有控制能力及 Pi 历史会话列表、恢复行为，不新增历史读取 RPC。

代码阶段立即对本阶段改动格式化，运行包类型检查与相关离线测试；失败或未验证必须明确记录。

## Out of Scope

- 同 project 多 runtime 或多个并发活动 session 不在规划范围；只考虑一个 project、一个 runtime、一个 active session。不引入每用户 active session、排队执行或会话私有受众。
- 跨重启恢复进行中的回合、持久化输出队列、恰好一次执行或自动重试。
- 新增 CLI 异步任务、状态轮询、分页历史读取或历史搜索接口；保留现有微信状态和历史会话列表、恢复能力。
- 无关重构、发布或远端状态变更。

## Further Notes

- **范围确认：只考虑一个 project、一个 runtime、一个 active session。** 不规划同 project 多 runtime、多 session 并发，也不为其设计调度或扩展抽象；历史 session 的保留及串行切换不属于多 session 并发。
- 用户已确认测试边界、共享 active、会话切换独立于 reply 并必须通知微信。不采用每用户 active 或投递成功才激活的方案。
- 用户明确允许相同 cwd 的多个 project 读取彼此的会话，不增加会话所有权登记或隔离。会话列表与恢复范围沿用该 cwd 的 Pi 历史，不接受其他 cwd 的任意历史路径。
- 实施前核实 Pi 锁定版本现有的会话列表、恢复及交互接口，以便复用；不因此扩展历史 RPC 或重建历史系统。
- CLI 文件工具默认向 project 全部微信用户发送、且不受 reply 影响已经确认；以可选 userId 选择项目用户。CLI notify/进度进入调用方 messages，不按文件工具广播规则发送。
- 账号 `userId` 与入站 sender 的证据核实按需求 0009 执行。
