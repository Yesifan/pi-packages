# Subagent 异常退出也向主代理报告

---

status: not-started
execution_time: "2026-10-09"
commit: null
version: null
related_documents:
  - "[Spec 0002](0002-prompt-and-session-storage.md)"
  - "[现场证据](evidence/0003-terminal-exit-2026-10-09.md)"
  - "[ADR-0003](../adr/0003-sdk-sessions-and-parent-metadata.md)"

---

## Goal

用户委派后台任务后，即使 child 没有生成最终回复、被取消或因 SDK/工具异常退出，直接 parent 也应收到明确终态和原因，不能一直误以为仍在运行。主代理无需通过 steering 失败或再次 ask 才发现任务已结束。

本需求来自两次异常终态已记录但 delivery 为 pending 的现场；事实与未知原因见[证据记录](evidence/0003-terminal-exit-2026-10-09.md)。本规格只记录退出通知要求，不把 abort 推断为进程崩溃、挂起或模型自愿暂停。

## Solution

已接受的 child execution 在可观测终结时统一走一次终态报告路径，不依赖最终 assistant 文本存在。报告由宿主产生，说明成功、失败、取消、中断或没有最终文本，以及可获得的具体原因、已验证历史路径和当前可执行的下一步。

嵌套 child 通知自己的直接 parent；最外层 child 通知用户主代理。只发送给发起本次 execution 的仍有效接收方，不把旧报告转交 parent 的下一次 execution 或替换后的 root。

## User Stories

1. 作为主代理，我希望 child 正常完成时收到一次结果，避免重复总结或遗漏结果。
2. 作为主代理，我希望已接受任务在模型错误、工具调用中断或 prompt Promise 拒绝后也收到一次宿主终态报告，即使 child 的最终正文为空，以便调整计划。
3. 作为主代理，我希望取消与没有最终文本明确区分，报告呈现实际原因而不是一律声称成功或“暂停”，以便判断是否重新 ask。
4. 作为嵌套 parent，我希望异常 child 也完成报告处理依赖，避免永远等待；报告必须进入我的处理链后才能允许我终结。
5. 作为用户，我希望停止 root 当前模型回复不会默默丢弃已接受后台任务；只要接收方 runtime 仍有效，其终态仍按正常规则通知。
6. 作为用户，我希望真正退出、更换或关闭 root 时，不向新会话发送旧消息；无法投递的原因留在诊断日志，不能显示假成功。
7. 作为主代理，我希望接受前失败通过原工具明确报错、不另发 phantom 报告；已完成或空闲的 child 不因正常 mount 释放再发送第二次退出通知。

## Implementation Decisions

- 延续 Spec 0002 的 name 接口、Execution/RootScope 对象归属和在线唯一报告，不新增 run/report ID、持久 inbox 或结果副本。
- “退出”在本规格中指宿主可观测到的 execution 终结，而非每次 agent_settled、工具结束或 SDK mount dispose。等待 children/reports 不属于终结。
- 正常完成、SDK Promise rejection、已接受后的错误/abort、无最终 assistant 文本均进入统一的幂等终结路径。状态、结果提取和报告提交一致处理；多种回调竞争最多一次报告。
- 有错误时优先使用真实 SDK/tool/取消原因；缺少原因则说明未知，不编造“用户取消”“超时”或“已暂停”。报告包含 name、保存的 role、outcome、可用历史路径；不泄露内部执行 ID。
- 没有最终文本时由宿主生成简短诊断正文，不重用此前 ask 的成功回复、不要求 child 模型再生成一轮说明。
- 直接 parent 有效时，报告沿既有自动处理链触发接收方；停止 root 当前模型响应不自动等同 runtime shutdown。
- parent 依赖同步从 child 等待转入报告等待。send Promise resolve 不等于 processed；延续公开 SDK event + 已持久 Pi entry 的处理 barrier。
- sender 释放后、同一 child 开始下一次 ask，不影响已提交旧报告对原有效 target 的处理；迟到终结回调不得改变新 execution。
- 原 parent/root 关闭或替换时，不再投递旧报告。记录可诊断的 suppression 原因；投递失败记录 failure，不能记成已处理。父 execution 已不可继续时沿既有失败收尾处理，不留下无接收方依赖。
- 诊断至少区分终结原因、投递尝试、投递/处理失败与归属失效抑制；使用已有日志能力，不复制 prompt、完整工具输出或结果正文到日志。日志可带必要的宿主关联信息，但模型可见结果仍以 name 寻址。
- 保持 SDK 默认行为和简单实现，不引入轮询 watchdog、进程探活框架或“自动重启 child”。

## Testing Decisions

优先以 RootRuntime 与宿主报告接收边界的 integration tests 验证可见行为；只在真实 SDK 消息/lifecycle 语义影响结论时补充锁定版本的 SDK gate。不要为每个私有 helper 单独建立测试边界。

验收行为：

- T01：正常完成一次报告，无额外 mount-exit 通知。
- T02：accepted 后 Promise reject、模型 error、abort，各收到一次异常终态与具体原因；无最终文本也报告，不复用旧结果。
- T03：多次 settled/reject/dispose 回调竞争仍只有一次终结/报告，释放资源不重复投递。
- T04：nested child 失败或取消后，parent 先处理异常报告再终结；send 返回、消息尚未持久化时不得提前解除 barrier。
- T05：停止 root 当前模型响应但 runtime 未关闭，child 后续终态仍通知有效 root。
- T06：root shutdown/replacement 与终结、历史验证、报告提交竞争，不污染新 root/新 parent execution；抑制原因有日志。
- T07：sender E1 已释放且 E2 开始后，E1 已提交报告仍对原有效 target 生效；不修改 E2，也不路由给错误 parent。
- T08：接受前失败/handled 仅通过原工具诊断；无 phantom report。
- T09：持久化、mount 清理、发送及接收处理分别注入异常，不会显示假 processed 或留下永远等待的 parent；日志可区分投递失败与归属失效，不能依据 idle/completed 状态推断已发送。
- T10：缺少或损坏历史明确显示不可读取，不伪造路径；通知本身不因最终正文为空而消失。

使用临时 PI_CODING_AGENT_DIR 隔离状态、可控 Promise/barrier 构造竞争，不靠 sleep。测试须真实证明发送后处理语义；mock 可以验证归属竞争，不能冒充真实 SDK 确认。上述测试边界为拟采用方案，实施前请用户确认是否还需要真实 CLI 手测边界。

## Out of Scope

- parent 自身失败并强制中断 children 的退出通知。用户已确认本版不处理该场景，不要求逐 child 报告或由 parent 汇总退出原因；保留既有中断与资源清理行为。
- 全部 Node 进程被 kill、机器掉电后即时报告；没有存活宿主就无法在线投递。
- 跨重启补投、持久 delivery、exactly-once inbox、恢复旧布局 pending 记录或迁移现场旧数据。
- 向新 root 转交旧 child 报告，或自动重跑未完成任务。
- 周期性进度报告、超时判死、自动续跑或新的查询/取消 LLM tool。
- 本次文档任务不继续 Spec 0002 剩余实现，不把未完成回归标为通过。

## Further Notes

- 本规格扩展 Spec 0002 的在线终态通知覆盖，不改变其“不承诺重启后补投”决策。
- 现场最后一条 assistant 为 error，旧记录 delivery pending，当前 root 已不同；尚未证明原 parent 有效时确实丢投，需在实施阶段复现并分类根因。
- 需要用户确认测试边界：以 runtime integration + 锁定 SDK gates 为主，是否要求额外真实 CLI 退出/切换验证。
- 用户已确认：parent 自身失败并中断 children 不在本版通知范围内；不增加逐份投递或汇总协议。
- 若希望 root 已关闭后也保证通知，需另行确认持久化与恢复策略；这会改变 Spec 0002 的已批准范围，本规格暂不加入。
