# ADR-0005：执行周期整树锁与同 root 多窗口

- 状态：已接受并实施；验证记录见 [Spec 0005](../specs/0005-execution-scoped-root-lock.md)。
- 关联：[ADR-0003](0003-sdk-sessions-and-parent-metadata.md)、[ADR-0004](0004-official-sdk-lifecycle.md)、[领域模型](../domain-model.md)。
- 扩展：整树 writer lock 从 root 窗口生命周期缩短为执行周期。保留旧 ADR 原文及理由，exact root 身份、最小 metadata、角色 snapshot、trust、报告与串行清理合同不变。

## 背景

窗口一打开就持有整树锁，会阻止同一 exact root 的其他空闲窗口继续已有 subagent；启动时的锁失败还会把工具永久绑定到失败 runtime。用户要求无需关闭或重载其他窗口即可继续，并明确选择整树执行互斥，不采用 IPC 转交任务。

## 决定

1. `initialize` 只建立窗口 scope、配置及资源工厂，不取得锁、不恢复持久化树。真正的 create/普通 ask 先获取整树锁，读取并校验最新 owner/history/归属，重建 Agent 树与每周期 store 缓存，再判断 name、所有权、busy 和 live limits。不能将窗口旧缓存写回；恢复 running→interrupted、opening→idle 仅在取得锁后执行。
2. 同窗口的并行首次请求共享本次 acquisition；恢复结束后各自按原有原子 reservation 规则执行。这不是任务队列，不等待另一窗口执行完成。整树锁仍由 `proper-lockfile`、`retries: 0`、既有 30 秒 stale 与 heartbeat 机制负责；竞争失败只影响本次工具调用，下一次明确请求可重试。
3. 持锁期间本窗口及 descendants 可并行。其他窗口的 create/ask/steer 返回 ROOT_SCOPE_IN_USE，即使目标是另一 idle child。无本地活动执行时，steer 仅短暂探测锁冲突，不恢复树、不建立执行周期、不产生新 Execution；无竞争时返回 SUBAGENT_NOT_STEERABLE。
4. openingTasks、executions、deliveries 和 finalizations 共同构成释放屏障。prompt/steer 调用、等待 child/nested report、最终写入、dispose 和报告 history 校验均包括在内。不能按 streaming 或 live 数单独释放；root sendReport 返回 void，成功只证明 submitted，不等待模型消费的虚构 receipt。投递失败亦须清理本次 delivery，不能泄漏永久锁。
5. 全部工作结束后关闭 store、释放锁，窗口 scope 保持可用。下一周期重新获取和恢复；旧 Execution 已 closed，迟到事件不能修改新执行。获取/恢复或准备失败在必要清理后释放，不缓存永久不可用状态；同窗口仍有工作时不提前释放。
6. shutdown 标记 closing、取消 UI、拒绝新工作、abort descendants，等待 opening、调用、dispose 和在线 finalization 收尾后最后释放。非合作 hook 可阻止关闭，不为可用性强拆活锁。崩溃只沿既有 stale 机制恢复，不自动接管执行、不续跑、不补投报告。

## 取舍

- 每个新执行周期重新恢复整树，增加 metadata/history 读取成本，换取明确的最新状态与单 writer 约束。
- 同 root 不同 idle child 也不能跨窗口并行；不同 root 仍独立。
- 报告只沿执行窗口内捕获的 direct-parent 链返回；不跨窗口广播或转发。
- 不保证宿主 root JSONL 多窗口写入安全，也不协调独立打开 child 的直接写入。锁与 cwd admission 都不是 filesystem sandbox。
- 不引入新持久字段、运行 ID、inbox、IPC 服务、任务队列或跨文件事务；不实施 Spec 0003。

## 验证

用户批准离线 runtime fake SDK 生命周期竞争测试及真实双进程锁集成测试，不调用真实模型。另保留已有真实 SDK（假 provider）生命周期回归。子进程测试从当前 store 源码转译，不依赖陈旧 dist；测试控制 IPC 仅用于构造竞争，运行时代码无 IPC。崩溃用 SIGKILL，确认进程退出后才模拟 stale 时间；不人为陈旧化活锁。实际 CLI 多窗口手测未执行，不将自动测试冒充手测。
