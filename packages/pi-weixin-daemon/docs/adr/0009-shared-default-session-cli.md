# ADR-0009：共享默认会话与 CLI 回合来源

> 合并时原 ADR-0008 编号已由 [Pi 业务单入口与内部适配精简](0008-pi-business-entry-simplification.md) 使用，本记录调整为 ADR-0009；原决策内容保留。

- 状态：已采纳（Accepted）；需求 0010 已完成
- 日期：2026-10-21
- 关联：[需求 0010](../requirements/0010-project-session-cli-mcp.md)、[ADR-0002](0002-session-lazy-creation-and-status.md)、[ADR-0003](0003-pi-host-compatibility-policies.md)、[ADR-0004](0004-layering-and-dependency-direction.md)、[ADR-0005](0005-weixin-slash-session-controls.md)、[ADR-0006](0006-session-wide-agent-reply-routing.md)、[ADR-0007](0007-project-weixin-users.md)

## 背景

闲置释放后新建、重启不恢复的策略会中断项目上下文。新增 CLI prompt 后，微信和终端需要共用项目历史，同时允许调用方选择最终回复出口；不能把 CLI 请求伪装成微信 sender，也不能为每个入口新增独立 runtime 或队列。

## 决策

1. **持久 default、临时 active、单 runtime。** 每项目保存 `defaultSessionId`；session 是历史，runtime 是运行实例。每项目至多一个 active/runtime/任务。首个成功激活的会话自动成为 default，包括显式新建或恢复；后续新建只改变 active。`/default [id]` 修改默认身份，不强制切换 active。
2. **按需加载，释放不删历史。** 微信普通消息继续 active，无 active 时恢复 default；CLI 未指定 session 时使用 default 并激活。闲置 10 分钟或重启清除临时 active，下次按需恢复 default，不恢复进行中的任务。默认历史不可读时明确失败，不静默新建替代；显式新建并设置 default 可修复。
3. **显式切换全项目生效。** `/new` 无 active 时也创建；`/resume` 保留分页/latest，新增 ID/default。`latest` 仅在无 active 时恢复最近历史，不充当 default。历史范围沿用 cwd，相同 cwd 的项目允许共享历史，不增所有权登记，不接受其他 cwd 的任意文件路径。
4. **通知独立于回复目标。** 实际切换成功向全部项目微信用户通知，标题缺失用 ID。无 active 时显式新建/恢复也通知，仅无 active 时按需恢复 default 免通知；已有不同 active 时，普通 CLI prompt 切回 default 也通知；同会话不重复，仅改 default 不通知。通知失败不回滚会话，也不自动重试。
5. **CLI 是入口，不是新调度系统。** 本地 UDS 接入 `prompt`，参数/项目目标校验先于会话变更。`--session` 与 `--new-session` 互斥；项目 busy 时所有新任务及切换均拒绝、不排队，合格交互答复除外。保留状态/abort 和跨项目隔离。
6. **reply 仅属于当前回合。** 可重复的 `caller`、`user:all`、`user:<id>` 组合选择成功最终文本出口，默认 caller；项目微信用户目标去重，未知/跨项目目标拒绝。没有 caller 时不返回成功正文，但仍返回身份、状态、错误及可用投递结果。微信回合与无来源独立 Agent 回合仍广播，不能继承前一 CLI reply。保留会话级结算、重试后发送和旧代际隔离，不增加第二套流式累积。
7. **文字交互按来源仲裁。** 同 project 所有本地 CLI 视为同一可信来源，可互相回答；不提供每终端私有询问。微信来源仍按账号及实际询问收件用户关联，两类入口不能互相代答。回答沿用原回合 session/reply，不因默认参数切会话；指定其他 session 或新建不能消费询问。超时/取消/abort 不自动批准。
8. **工具目标与 reply 分离。** 文件工具 `weixin_send_file` 默认使用微信来源账号用户；CLI/独立回合无微信来源时默认向全部项目微信用户发送，可选 `userId` 也只能属于项目。caller-only 不禁止文件工具发送微信。notify/进度仍按来源处理，CLI 回合进入响应 `messages`，不广播微信。沿用 ADR-0007 的精确 token、缺条件跳过与逐目标失败隔离，不伪造 sender 或借用 token。
9. **保持分层和控制面。** CLI/UDS 只做入口适配，项目负责目标范围、会话层负责回合及交互、SDK 继续限制在 `src/pi/`。复用既有历史列表与恢复，不新增历史数据库、历史读取 RPC、MCP 服务、异步任务轮询或持久输出队列。

## 与旧决策的关系

- 调整 ADR-0002 的 inactive `/new` 不空转：显式新建现在是有效的使用意图；保留项目启动时懒加载。
- 调整 ADR-0003 的重启/闲置后新建策略：保留 idle 真关闭，但下次恢复持久 default。
- 扩展 ADR-0005 的会话命令及交互来源；保留 latest 兼容行为、分页仲裁及 UI 优先。
- 调整 ADR-0006 的所有来源统一广播：CLI 回合按 reply 投递；保留微信/独立回合广播、会话级结算及代际隔离。
- 沿用 ADR-0007 的项目用户和 token 模型，扩展无微信来源时的工具投递；不改变普通微信入站身份策略。
- 不覆盖旧 ADR 的理由或历史实现记录；分层继续遵循 ADR-0004，SDK 边界内部适配遵循 [ADR-0008](0008-pi-business-entry-simplification.md) 的精简方案。

## 取舍与验证边界

共享 active 意味着 CLI 切换会影响下一条微信消息；caller-only 不意味着私有会话或禁止切换通知。接受这一简单共享模型，不规划同项目多 runtime、多并发会话或每用户 active。

执行成功与微信投递成功是不同结果；断线不保证撤销，重复请求可能重复执行/发送，不提供恰好一次保证。普通 broadcast 继续绕过 Pi，不激活会话或刷新闲置计时。

需求 0010 已完成：离线 30 文件 / 237 测试、typecheck、build、Biome 和 diff check 通过，最终针对性静态独立审查完成，无剩余阻塞问题。验收使用 fake transport/runtime 与真实本地 UDS，不调用真实模型或自动发送真实微信；验证记录见[需求 0010](../requirements/0010-project-session-cli-mcp.md)。
