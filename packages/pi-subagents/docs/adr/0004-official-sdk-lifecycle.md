# ADR-0004：官方 SDK 生命周期、恢复与串行清理

- 状态：已接受；Pi 1.4.0 升级实施中，本文不是验证完成记录。
- 关联：[ADR-0003](0003-sdk-sessions-and-parent-metadata.md)、[当前规格](../specs/yesifan-pi-subagents-spec.md)、[全仓升级验收规格](https://github.com/Yesifan/pi-packages/blob/main/docs/specs/pi-1.4-upgrade.md)。
- 替代：ADR-0003 §3 的 preflight started/handled 接受握手及旧规格的严格历史模型恢复要求；保留原文理由和历史验收。history 位置、身份、直接所有权、角色 snapshot、trust、工具策略与最小 metadata 决策不变。

## 背景与决定

内部 `preflightResult` 是通知而非 admission/veto API；通过通知抛错阻止启动既不受支持，也可能使 SDK busy/abort 生命周期无法结束。不另建第二套接受状态机。

1. 普通创建/ask 先完成本地准备和 running 持久化，再调用公开 `session.prompt()` 并接入后台 completion，返回 `submitted`，不等待整轮完成，不保证 started 或模型调用。running 表示承担后台责任；写入失败不调用 SDK，写入后到调用前退出按 interrupted 保守恢复。提交后失败保留身份/history，不回滚扩展副作用。普通 handled 不伪造 started/回答，不复用旧回复，也不无条件 abort 扩展自行启动的工作。
2. 严格 steering 使用公开 `session.steer()`，不使用 prompt streamingBehavior。queued 返回 steered，仅保证入队；handled 不入队、不 abort 原执行。接受 skill/template 展开和 extension command 拒绝。hook 期间原 run 可结束，迟到 queued 只留在捕获 session，不启动新 run、不补投或生成独立报告。调用前取消不提交；公开 steer 无单次 AbortSignal，调用后不承诺零入队或撤回。
3. prompt/steer 调用和清理未结束时 logical Agent 仍 busy。旧调用、队列和资源清理完成后才允许下一 Execution；迟到 callback 仅作用于捕获的 Execution/session。shutdown 使用公开 abort，等待生命周期结束、dispose 后最后释放 writer lock；不合作 hook 可能阻止关闭，不假装所有写入者已释放。
4. 每个 mount 独立调用 `createAgentSessionServices()` 与 `createAgentSessionFromServices()`；trust 早于目标资源加载，保留 loader options、own-extension 排除、角色 prompt 顺序及 codemode/tool-search/MCP 三项 builtin factories。services 不自动注入它们。拒绝 error diagnostics 并保留原因，不手工清理 provider registrations 或复制 runtime 接线。
5. 恢复不传 parent/settings 模型覆盖，交由 SDK 解释实际 history，接受缺少 model/thinking entries、历史模型/鉴权不可用时的默认选择、fallback 和 clamp。展示公开 `modelFallbackMessage` 等诊断；没有 warning 不扫描历史伪造判断。无可用模型或调用失败正常报错，不保证 fallback 成功。身份、cwd、损坏 history、trust、角色与工具策略校验仍严格保留。

## 取舍与范围

以简单提交和串行清理替代 SDK started 与本地 durable acceptance 的原子承诺；不保证已排队输入必被消费，也不追溯撤回已提交后台任务。保留已有单报告和 child/report barrier，不扩展未实施的 [Spec 0003](https://github.com/Yesifan/pi-packages/blob/main/packages/pi-subagents/docs/specs/0003-terminal-exit-reporting.md) 终态通知覆盖，不增加队列、事务日志或重启补投。

验收以全仓升级规格的离线真实 SDK 竞争测试、回归与 pack 为准。旧规格的测试通过记录不代表本次升级通过。
