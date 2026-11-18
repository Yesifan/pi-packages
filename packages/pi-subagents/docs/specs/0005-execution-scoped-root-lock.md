# 执行周期整树锁与同 root 多窗口使用

---

status: completed
execution_time: "2026-10-23 / 2026-10-23"
commit: null
version: null
related_documents:
  - "[权威规格](yesifan-pi-subagents-spec.md)"
  - "[Spec 0002](0002-prompt-and-session-storage.md)"
  - "[领域模型](../domain-model.md)"
  - "[ADR-0003](../adr/0003-sdk-sessions-and-parent-metadata.md)"
  - "[ADR-0004](../adr/0004-official-sdk-lifecycle.md)"
  - "[ADR-0005](../adr/0005-execution-scoped-root-lock.md)"

---

## Goal

允许多个 Pi 窗口同时打开 exact same root session，在没有后台工作时由任一窗口继续使用已有 subagents，不必关闭或重启另一个窗口。仍保证同一时刻只有一个窗口管理并执行整棵 subagent 树，避免并发写入与陈旧缓存覆盖。

本规格扩展 Spec 0002 §7.1、§8.5、§9 及 ADR-0003/0004 的锁与恢复合同：整树锁从 root 窗口生命周期缩短为执行周期；其余身份、持久化与清理安全约束保留。已完成规格与 ADR 的历史正文不改写。

## Solution

窗口打开本身不长期占用整树 writer lock，也不能因另一窗口正持锁就永久禁用委派工具。一个执行周期从空闲窗口的第一次 create（`subagent`）或普通 ask（`ask_subagent`，非 steer）取得锁开始，覆盖初始化、该窗口提交的所有并行任务及子孙工作，直到全部任务、报告依赖和资源清理完成才释放。

取得锁后必须重新读取最新 metadata 并按现有规则恢复状态，再根据新树处理请求；不能复用上次持锁或窗口打开时的旧树缓存。持锁窗口 A 可按现有上限继续并行；其他窗口 B 的所有 create、普通 ask、steer 都立即忙碌失败，不排队，即使目标是另一空闲 subagent。A 完全收尾后，任意窗口可在下一次明确 create/普通 ask 时竞争锁、刷新状态并继续。

结果沿执行窗口内已有的直接 parent 报告链返回，不转发给其他窗口。此方案取代此前 IPC 方向，不引入执行代理窗口或跨窗口请求转交。

## User Stories

1. 我在 A、B 同时打开同一 exact root；A 空闲时，B 能直接继续已有 subagent，无需关闭 A。
2. A 正在执行任意子孙任务时，B 尝试创建、询问另一空闲 agent 或 steer 都立即得到忙碌诊断，不会悄悄排队。
3. B 忙碌失败后，A 全部结束；B 再次调用即可取得锁继续，不需要重启、reload 或重新打开会话。
4. A 释放后 B 新建了 subagent，随后 A 再次取得锁时能看到最新身份与状态，不覆盖或丢失 B 的更新。
5. A 的结果只回到 A 的有效直接 parent；关闭 A 按现有 shutdown 停止其工作，B 不自动接管或收到旧报告。

## Implementation Decisions

- **边界仍是 exact root 整树。** 保留 Pi session ID + 规范化实际绝对 session file 派生的 root identity、锁定位及归属校验；不同 root 仍可独立并行。复制、fork、导入或移动文件不因此取得原树管理权。不改成每 agent 锁。
- **打开与执行分离。** 未持锁窗口不执行会修改 metadata 的恢复，尤其不能把另一窗口的 `running` 标为 `interrupted`。一次锁冲突只拒绝本次请求，不使工具永久失效。
- **先取得锁，再刷新，再执行。** 每个新执行周期均从持久化数据重建有效树状态，校验 owner/history/归属并完成现有恢复后，才做依赖树状态的 name、ownership、busy 与 live-limit 判定和写入。首次与再次获取均遵守此顺序；不从旧缓存覆盖最新 owner JSON。同 owner 串行原子写入保持不变。
- **整树互斥不等于执行串行。** A 持锁期间自身及其 descendants 可沿当前 direct ownership、depth、live limit、单 agent busy 约束并行。B 无权向 A 转交请求或修改其执行；竞争锁失败立即返回明确的整树忙碌诊断，不等待 A 结束或自动重试任务。
- **忙碌覆盖完整生命周期。** opening、所有未结束的子孙 Execution、等待 children/reports、在线报告提交及现有处理 barrier、尚未 settle 的 prompt/steer 调用、持久化收尾与资源 dispose/清理均阻止释放。不能仅以 SDK streaming 结束、单个 agent idle 或 live 数归零判断整树空闲。
- **报告语义不扩大。** nested report 继续遵守现有处理 barrier；root 的 void `sendReport` 成功只代表 submitted，没有 processed receipt。这里的报告处理完成按既有合同判定，不新增等待根 Pi 消费报告的确认协议。报告和迟到 callback 仍绑定捕获的执行/接收方，不能污染下一周期。
- **steer 只属于当前执行。** A 仅能 steer 自己当前可 steering 的 Execution，原有 queued/handled 与拒绝诊断不变。B 遇另一窗口持锁立即忙碌失败；无活动执行时 steer 不为启动工作而获取执行周期、不恢复旧轮次、不新建 Execution，返回不可 steering 诊断。
- **空闲释放与失败重试。** 全部工作和清理完成后释放锁，窗口保持可用。获取后的 metadata 初始化/恢复或首次任务准备失败，必须完成本次必要收尾后释放锁，不留下永久失败缓存；问题消除后下次明确调用可重试。若仍有本窗口其他任务或未完成清理，不得因此提前释放。
- **关闭与崩溃沿现有安全规则。** 执行窗口关闭、替换或 reload 仍关闭其 scope、拒绝新工作、取消 UI、abort/dispose descendants、保存终态后最后释放锁；不是 IPC 的“发起窗口断连后远端继续”规则。仅停止 root 当前模型响应不停止已接受工作。不合作 hook 未退出时保留锁，不为可用性强制删活锁。崩溃后的锁恢复沿用现有安全机制，取得有效锁后才恢复 `running → interrupted`、清理 opening；不自动续跑或补投。
- **实施时新增关联 ADR。** 锁生命周期属于架构决策，实施时需新增 ADR，关联本规格及 ADR-0003/0004 并说明扩展关系，同步领域模型、当前契约与用户文档。关联决策见 ADR-0005；保留旧规格与 ADR 的历史正文。

## Testing Decisions

**测试方案已获本轮用户确认：** 以现有 runtime fake SDK 生命周期测试覆盖执行与清理竞争，辅以真实双进程锁集成测试验证跨进程互斥和交接；不调用真实模型。fake 测试不冒充真实进程锁验证。使用临时 `PI_CODING_AGENT_DIR` 和隔离目录，生命周期竞争用可控 barrier 构造。

验收以下行为；本轮不调用真实模型，不要求实际 CLI 多窗口手测，也不把自动测试冒充手测：

- T01：同时打开 exact root 不永久禁用工具；A 持锁时 B 的 create/普通 ask/steer（含另一个空闲 agent）立即忙碌失败，磁盘状态不被 B 恢复或修改。
- T02：A 内部按原有上限并行；A 全部结束后 B 再次调用成功，无需重启；结果仅回执行窗口。
- T03：两个进程同时竞争同一 root 锁仅一个成功，失败方不排队；不同 root 不互相阻塞。
- T04：A→B→A 交接后均读取最新 metadata；新增身份、name 占用、分支与状态更新不丢失，不能用旧树覆盖新数据。
- T05：分别阻塞 opening、子孙任务、nested report barrier、prompt/steer settle 和 dispose/持久化清理；任一未完均不释放。root 报告不假造 processed receipt。
- T06：取得锁后初始化/恢复或准备失败，安全收尾后释放；消除故障后同窗口及另一窗口可重试，不能因早期异常泄漏锁或提前绕过清理。
- T07：steer 不启动新执行或恢复旧轮次；迟到 callback 不影响下一周期。关闭执行窗口沿现有 shutdown 中止任务，不发生跨窗口自动接管或补投。
- T08：持锁进程崩溃后遵守现有锁恢复机制；活锁不强制删除，重新取得有效锁后才进行 interrupted/opening 恢复，保留 exact identity、损坏/不安全路径 fail-closed 检查。

## Out of Scope

- IPC、跨窗口执行转发、自动报告广播、自动接管、等待队列或自动重试请求。
- 根 Pi 历史的多窗口并发协调、宿主直接写 child JSONL 的竞争治理；本锁仍只保护本包管理边界。
- 每 agent 锁、新持久 inbox、结果副本、事务日志、跨重启报告补投或自动续跑。
- 改变 name/角色 snapshot/授权/上限/存储布局，或顺带实施 Spec 0003 的异常退出通知扩展。
- 修改已完成规格的历史正文、发布版本。

## Implementation and Validation

已实现窗口初始化与执行所有权分离。`RootScope` 仍是窗口生命周期对象；每次取得锁重新创建 Agent 树和 store 缓存，不用旧对象覆盖持久数据。并行首次请求共享 acquisition，清理期间的新请求先等待本窗口已经开始的 lock release，再进行一次新的竞争；不等待其他窗口的任务结束。idle steer 只短暂探测锁，不恢复或启动工作。shutdown 额外等待在线 finalizations（包含报告 history 校验），root 报告提交抛错也清除 delivery，避免空树永久持锁。

2026-10-23 离线验证：

| 验收 | 证据 |
| --- | --- |
| T01/T02/T04 | `runtime-execution-lock.test.ts`：同时打开、busy 单次拒绝、idle sibling busy、磁盘 running 不被竞争窗口修改、A→B→A 新身份/占名刷新、报告留在执行窗口；原 concurrency/recovery suites 保留并行上限、分支/角色/状态递归恢复。 |
| T03/T08 | `store-process-lock.test.ts`：从当前 store 源码转译的真实双子进程同时竞争仅一个成功、失败不排队、不同 root 独立、双向交接；SIGKILL 后未过期锁仍拒绝，确认进程死亡后模拟 stale 时间再恢复。原 store suites 保留 exact identity、损坏/unsafe fail-closed 验证。 |
| T05 | 新 runtime suite 逐项阻塞 opening、最终持久化、dispose、报告校验、prompt settle、steer settle、nested report barrier，验证竞争失败与完整清理后释放。原真实 SDK（离线假 provider）suite 保留非合作 input hook/关闭竞争。root 报告仍无 processed receipt。 |
| T06 | 新 runtime suite 验证损坏 metadata 修复后重试、失败准备释放、root 报告提交失败不泄漏锁；原 lifecycle suites 保留持久化准备失败不调用 SDK、并行 opening 和 shutdown 竞争。 |
| T07 | 新 runtime suite 验证 idle steer 不恢复/执行；原 steering/report-history suites 保留捕获 Execution、迟到 callback、sender 下一次执行、shutdown/replacement 不补投；关闭等待悬挂报告校验后释放。 |

- `pnpm --filter @yesifan/pi-subagents typecheck`：通过。
- `pnpm --filter @yesifan/pi-subagents test`：24 个文件、279 项通过。
- `pnpm exec biome check packages/pi-subagents`：通过；runtime 原有 15 条 non-null assertion warnings，无 error。
- `pnpm --filter @yesifan/pi-subagents build`：通过。
- `pnpm --filter @yesifan/pi-subagents pack --pack-destination /tmp`：通过；tarball 包含当前 dist、Spec 0005 与 ADR-0005，不含测试、AGENTS 或开发配置。
- 新增 patch changeset；不手动改版本，不发布。实际 CLI 多窗口手测、真实模型调用未执行，符合已确认测试范围；已完成本次独立审查，修复解锁失败导致当前窗口永久无法重试的问题，并补充真实 close 失败恢复、获取/恢复中 shutdown、释放期间新请求的竞争测试；PR 由主代理创建。

## Further Notes

- 已确认产品方案是执行周期整树锁，不保留旧 IPC 方案的发起窗口断连语义。
- 用户已批准 runtime fake SDK 生命周期测试 + 真实双进程锁集成测试、不调用真实模型的测试方案，并要求实施后创建 PR。
- 创建日期保留 `2026-10-23`；执行与验证状态以顶部 metadata 为准。
