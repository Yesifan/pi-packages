# 需求 0004：微信 Agent 中间进度工具

- 状态：✅ 已完成
- 目标版本：0.6.4

## 目标

为 daemon 创建的 Pi Agent 提供 `weixin_send_progress` 工具。长任务执行期间，Agent 可以在合理
间隔向当前微信发起者发送简短进度，避免用户只能等待最终回复。

工具指导语义：仅在需要较多工具调用或包含多个步骤的长任务中使用；每次用一至两句普通语言概括
已完成内容和下一步，尽量不超过 8–10 个词；短任务和最终答复不使用该工具。

## 行为

- 工具只有一个必填字符串参数 `update`，不向 Agent 暴露账号、用户或 context token。
- 消息使用活动 `TurnContext`，只发给本轮微信发起者，不参与项目广播，也不计入最终 Assistant 文本。
- 控制字符和多余空白在发送前清理，清理后的文本最多 200 个字符；空文本拒绝发送。
- 没有活动 turn 时返回错误，防止后台或生命周期调用误发给上一位用户。
- 微信发送失败由工具调用正常抛出，不伪报成功。
- 工具作为 daemon 内存 Extension 注入，项目 `/new`、恢复或其他 session replacement 后仍可用，
  且不写入项目 `.pi/extensions`。

## 验收

1. 正常调用将清理后的文本发送到当前 `TurnContext`，并返回成功结果。
2. 无活动 turn 或清理后为空时不发送并返回错误结果。
3. 发送失败向上抛出。
4. 项目自定义 Extension、`weixin_send_file` 和本工具可以共存。
5. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿。
