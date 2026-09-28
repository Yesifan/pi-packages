# ADR-0006：Pi 会话级统一路由 Agent 最终回复

- 状态：已采纳（Accepted）
- 目标版本：0.6.11
- 关联：[`需求 0006`](../requirements/0006-session-wide-agent-replies.md)、[ADR-0003](0003-pi-host-compatibility-policies.md)、[ADR-0004](0004-layering-and-dependency-direction.md)

## 背景

一个项目共享至多一个由 pi-wx 创建的 Pi 会话。当前 `PiSdkHost` 在 session 存活期间持续订阅 SDK 事件，但 `SessionController.runTurn()` 只为微信入站消息临时安装回复收集器：等这次 `prompt()` 与 `agent_settled` 后发送结果，再移除收集器并清除 `TurnContext`。因此，扩展在此后向同一 Pi 会话送入消息并触发新 Agent 回合，Pi 历史中虽有最终 assistant 回复，微信却无对应发送路径。会话仍存活、空闲超时尚未到期，也无法弥补这一缺口。

按扩展名称或自定义消息类型专门识别 subagent 报告，会让微信 transport 与扩展协议耦合，且漏掉其他同样能触发独立回合的会话内消息。单纯延长 idle 时间也不能保证回复送达。需要以**会话内 Agent 回合**为单位定义通用的正常回复出口。

## 决策

1. **统一正常回复出口，不按输入来源决定是否发送。** 对 pi-wx 当前管理的 Pi session，每个已结算的 Agent 回合若产生可发送的成功最终文本，就按现有 project `broadcastText` 规则广播一次。微信入站回合和扩展触发的独立回合走同一出口；微信 `runTurn()` 不再另行发送同一成功文本。
2. **会话级事件订阅、回合级收集。** 在 `SessionController` 的单一状态机内持续处理活动 session 的领域事件。由 `src/pi/` 将 SDK 的回合起始及 `agent_settled` 翻译为领域事件；每个回合独立累加响应。`agent_end` 可能后接自动重试、steer 或继续执行，不能作为最终发送边界。回复投递按回合顺序串行，不把不同回合的文本混合。
3. **广播范围沿用项目注册表。** 不新增 session 专属收件人列表。发送时使用 `ProjectController` 现有参与者筛选、所保存的微信 context token 及逐目标失败隔离机制；context token 可缺失，不新增发送资格过滤；不扩大向未观察到的用户发送内容的范围。
4. **来源只服务于控制与错误语义。** 对微信发起的回合，可选 `TurnContext` 仍用于 typing、UI、文件、进度、超时及原有的错误/部分输出/warning 定向回复；它不决定成功文本是否广播。无微信发起者的失败、abort 或不完整输出不冒充成功结果广播，需留诊断日志。此决策不改变文件/UI/进度的定向契约。
5. **生命周期一致性。** 自主 Agent 回合及其最终投递参与 busy/空闲判断；每次 SDK session 绑定都建立可辨识的会话代际，事件收集和异步投递均按代际隔离，包含扩展通过 SDK 主动切换 session 的情况。原 session 替换、停止、空闲关闭或超时失效时，旧收集器不得污染新 session。`prompt()` 未实际启动 Agent 回合的路径不能等待一个不会到来的 `agent_settled`。保持现有 `/new`、项目隔离、busy 拒绝与微信 UI 仲裁语义。
6. **依赖方向不变。** SDK 事件与版本差异仍封装在 `src/pi/`；会话状态和回复归属由 `src/sessions/` 管理；项目参与者与微信投递仍由 `src/projects/` 管理。不引入对 pi-subagents 或其他具体扩展的依赖。

## 理由与备选方案

- 相比“仅在微信 `runTurn()` 内收集”，会话级收集能覆盖微信回合结束后的独立 Pi 回合，且无需依赖下一条微信消息唤醒回复链路。
- 相比“识别 `bykwp-subagent-report` 再发送”，通用回合出口覆盖其他扩展和未来 SDK 消息来源，并避免对某个扩展的安装、格式与版本形成耦合。
- 相比“每次 assistant 消息或 `agent_end` 就发送”，等待结算可避免把重试前的部分输出、steer 中间结果或连续消息拆成多条微信回复。
- 不将收件人改为 session 私有注册表：当前共享项目广播已定义项目参与者、当前账号授权与 context token 来源，改变受众是独立的产品决策。

## 后果与边界

- `SessionController` 的回复收集不再只属于微信入站调用；需要明确处理回合归属、投递序列、无发起者错误、异常超时和 SDK session replacement 竞态，并用 SDK 真实事件时序及 fake-runtime 测试验证。
- 成功文本仍是尽力广播；某个微信目标投递失败须留下记录，但本 ADR 不引入持久化重试或 exactly-once 微信送达保证。"广播一次"指本地每个回合至多发起一次广播流程。
- **不解决静默后台任务的存活问题**：根 Pi session 没有运行 Agent 回合时，pi-wx 无法仅凭回合事件判断扩展后台任务是否仍在执行。保留 ADR-0003 的空闲真关闭策略；如需防止这类任务被回收，应另立通用后台活动机制的需求和决策。
