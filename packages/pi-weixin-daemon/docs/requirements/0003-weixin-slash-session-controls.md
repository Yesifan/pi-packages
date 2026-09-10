# 需求 0003：微信 Slash 会话控制

- 状态：✅ 已完成
- 目标版本：0.6.3
- 决策：[`ADR-0005`](../adr/0005-weixin-slash-session-controls.md)

## 范围

### 命令

- `/model`：列出已配置凭据的可用模型，每页 5 个；`a-e` 选择，`a default` 同时写项目默认。无活动 session 时提示选择将修改项目默认。
- `/thinking`：列出当前模型可用思考强度，不分页；选择及 default 语义同上。
- `/p:<prompt>`：把冒号后的原文作为普通 prompt 交给 Pi。
- `/resume`：列出当前 cwd 最近会话，每页 5 个并恢复；busy 时拒绝。
- `/resume latest`：无活动 session 时恢复最近会话；有活动 session 时提示当前已在最新会话。
- `/reload`：非 busy 且有活动 session 时重载 Pi 资源。
- `/help` 与 `/help model`：总览或单命令帮助。

### 交互

- 选项绑定发起者的 `accountId + senderId`；连续 30 秒无操作后超时，翻页和无效输入会重新计时。
- 支持字母选择、数字页码和 `q` 退出。
- Pi UI ask 优先，slash selector 不消费其回复。
- 只有 `/resume` selector 阻塞项目；其他账号此时收到项目正在选择恢复会话的提示。
- model/thinking selector 不阻塞其他账号；新 agent turn 开始时取消该 selector。
- 超时主动告知原发起者。

## 验收

1. router 正确保留参数、识别 `/p:`，未知 slash 仍拒绝。
2. model/resume 分页边界和错误输入有单元测试。
3. default 写入 Pi 项目 settings，新 session 使用该默认值。
4. resume 替换后重新绑定事件和 Extension UI。
5. selector 的来源隔离、30 秒超时、`q`、Pi UI 优先级和 resume 独占均有测试。
6. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿。
