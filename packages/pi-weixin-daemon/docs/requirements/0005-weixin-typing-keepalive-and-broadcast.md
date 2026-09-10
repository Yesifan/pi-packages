# 需求 0005：微信正在输入续发与项目广播

- 状态：✅ 已完成
- 目标版本：0.6.7

## 目标

微信 iLink 的输入状态是临时状态。普通 Pi turn 执行期间，daemon 应周期续发正在输入状态，避免长任务中提示提前消失；提示范围应与共享项目的最终文本回复范围一致，使项目参与者能感知共享 Agent 正在工作。

## 行为

- typing 生命周期仍只属于 `SessionController.runTurn()`；命令、selector、busy 拒绝和项目错误回复不创建 typing 生命周期。
- turn 开始时立即发送 `status=1`，此后默认每 5 秒续发一次 `status=1`。
- turn 成功、失败、超时或回复投递异常时均停止定时器，等待在途续发完成，再发送 `status=2`。
- typing 发送给 `ParticipantRegistry` 中已观察到且仍属于项目已配置账号的所有参与者。
- 每次续发使用当时的授权参与者集合；turn 期间新注册的项目参与者可在后续续发中收到状态。
- 每位参与者使用其最近一次消息保存的 `accountId`、`senderId` 和 `contextToken`。
- 单个参与者的 ticket 缺失、transport 缺失或 API 失败不影响其他参与者，也不影响 Pi turn 和最终回复。
- 最终文本仍按现有项目广播规则发送；文件、Extension UI 和 Agent 中间进度仍保持当前定向语义。

## 验收

1. 普通 turn 开始时项目参与者均收到 typing 开始状态。
2. 运行超过保活间隔的 turn 至少续发一次 typing 开始状态。
3. turn 收尾后不再续发，并向项目参与者发送取消状态。
4. 延迟中的续发不会在取消状态之后到达。
5. typing 广播中单个目标失败不使项目进入错误状态。
6. daemon 命令、选择器及 busy 拒绝不单独触发 typing。
7. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿。
