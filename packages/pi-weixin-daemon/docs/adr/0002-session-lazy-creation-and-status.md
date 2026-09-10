# ADR-0002：会话懒创建 + status 暴露 trust + `/new` 不空转

- 状态：✅ 已接受（Accepted）
- 实施提交：`3c4c226`
- 日期：2026-06-（见 git 提交时间）
- 关联：`docs/adr/0001-session-project-trust-resolution.md`、`docs/requirements/0001-session-trust-fix.md`

## 背景

pi 的嵌入式 SDK 中 `createAgentSessionRuntime(createRuntime, options)` 在**调用时就同步建 session**
（`agent-session-runtime.js`：`await createRuntime(options)` → new `AgentSessionRuntime(...)`）。
`PiRuntime.start()` 因此为每个项目立即建 session，daemon 启动 N 个项目即建 N 个 session，
即使项目闲置无消息（资源空转）。同时 status 无 trust 展示，`/new` 在无会话时也建会话。

SDK 不提供「runtime 存在但 session 为空」的形态，故需在 **`PiRuntime` 层**做懒建。

## 决策

1. **session 懒创建**：`PiRuntime.start()` 不再调用 `createAgentSessionRuntime`，只初始化
   cwd/agentDir/扩展等固定输入。新增 `ensureRuntime()`：在**首次 `prompt()`（用户发消息）
   或 `newSession()`（`/new`命令）**时，才真正 `createAgentSessionRuntime` + `bindSession` +
   设置 `setRebindSession`。`abort()/compact()/getStatus()` 在无 session 时优雅降级。

2. **status 暴露 trust**：新增 `trust` 字段（`true | false | "unknown"`）。trust 解析是**纯函数**
   （只读 `trust.json` + `defaultProjectTrust`），**独立于 session 计算**——因此懒建前也能上报，
   trust 不再依赖「session 是否已创建」。

3. **`/new` 不空转（理解 A，已敲定）**：凭 `ensureRuntime()` 的惰性，`/new` 只在已有活跃
   session 时执行真正重置；无 session 时不创建空会话，返回提示
   「当前无会话，直接发送消息即可开始新会话」。

## 理由

- **按需创建**：只有真正会用的项目才建 session，降低 daemon 启动成本与闲置占用。
- **交互语义一致**：session 只在「有人要用」时存在（发消息 / 显式 new），符合资源生命周期直觉。
- **trust 可观测 + 与懒建解耦**：trust 不依赖 session，满足「即便没建 session 也能在 status
  里看到要不要 trust」。
- **`/new` 幂等**：无会话时 new 不产生副作用（不空转）。

## 后果 / 取舍

- 懒建后 `getStatus()` 的 `sessionId/sessionFile/model` 可能为 `undefined`（尚未建），
  调用方需容忍——这是本次明确要接受的「未初始化」状态。
- trust 仍为「创建时快照」：懒建是在首条消息时触发，翻看那时读的 trust.json/defaultProjectTrust；
  会话内仍不热更新（与 ADR-0001 一致）。
- 闲置自动关闭（`checkIdle`）现状只置 `sessionExpired` 标记 + 广播、未真正释放资源；
  与懒建模型整合时可进一步演进，本期不改。

## 相关实现

- `src/agent/runtime.ts`（`start`/`ensureRuntime`/`getStatus`/`abort`/`compact`）
- `src/projects/project-runtime.ts`（`handleMessage` 懒建触发、`getStatus` 透出 trust）
- `src/bridge/commands.ts`（`/new` 空转分支）
