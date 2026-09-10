# ADR-0005：微信 Slash 会话控制与交互仲裁

- 状态：✅ 已接受（Accepted）
- 目标版本：0.6.3
- 日期：见 git 提交时间
- 关联：ADR-0003/0004、`docs/requirements/0003-weixin-slash-session-controls.md`

## 背景

微信端目前只暴露 `/help /status /abort /new /compact`，不能选择模型与思考强度、恢复历史会话、重载资源，也不能显式把以 `/` 开头的文本作为 prompt 发送。微信没有 TUI，选择操作必须跨消息完成，并且必须与已有 Pi Extension UI ask 共存。

## 决策

1. 新增 `/model`、`/thinking`、`/resume [latest]`、`/reload`、`/p:<prompt>`，并支持 `/help <command>`。
2. `/model` 与 `/resume` 每页 5 项；`/thinking` 不分页。选择输入为 `a`～`e`，页码为 `1`～`N`，`q` 退出；`a default` 同时设置项目默认值。
3. 当前没有活动 session 时，`/model` 的任意选择都作为项目默认模型，并在列表中明确提示。
4. 当前 session 的模型/思考强度通过 Pi session API 修改；项目默认值写入 Pi 的 `<cwd>/.pi/settings.json` 语义，不建立 pi-wx 私有配置。
5. `/resume latest` 仅在没有活动 session 时恢复最近会话；已有活动 session 时提示“当前已经在最新的会话中了”。普通 `/resume` 只在非 busy 状态允许，并可替换 ready session。
6. `/reload` 只在非 busy 状态调用 Pi session reload；没有活动 session 时提示无需重载。
7. Slash 选择仅接受发起者 `(accountId, senderId)` 的回复；连续 30 秒无有效活动后主动超时提示，成功翻页、无效页码或无效选项都会重新计时；`q` 取消。
8. 只有 `/resume` 选择是项目级阻塞。其间其他用户的普通消息被拒绝；`/model`、`/thinking` 选择不阻塞其他用户，若新 turn 开始则自动取消。
9. Pi UI ask 优先于 slash 选择：UI 正在等待时，只有原 turn 发起者的普通消息可作为 UI 答复，slash 选择不能抢占。两种机制共享“下一条消息只能有一个消费者”的约束。
10. 未显式映射的 slash 仍不透传 Pi；`/p:<prompt>` 是唯一显式 prompt 逃生口，不展开 daemon slash。

## 后果

- `CommandRouter` 需要保留命令参数并识别 `/p:`。
- `SessionController` 管理短生命周期 slash selector；Pi SDK 枚举模型、切换 session、reload 仍封装在 `src/pi/`。
- 交互超时定时器必须在选择完成、取消、turn 开始、项目停止时清理。
