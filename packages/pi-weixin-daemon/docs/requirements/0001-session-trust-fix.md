# 需求：修复 PiRuntime 的 session 管理流程（对齐 pi 官方文档）

- 状态：✅ 已完成
- 完成提交：`3c4c226`（实现）
- 版本：0.5.3
- 涉及 ADR：ADR-0001（project trust 决策链）、ADR-0002（session 懒创建 + status trust + `/new` 不空转）
- 关联 ADR：`docs/adr/0001-session-project-trust-resolution.md`、
  `docs/adr/0002-session-lazy-creation-and-status.md`

## 需求目标

让 pi-wx 嵌入式会话（`PiRuntime`）**按需创建、不空转、trust 可观测、决策链对齐官方**：
1. 修复「项目作用域配置不被 trust」。
2. **项目启动/daemon 启动时不创建 session**，只在「用户发消息」或「`/new` 命令」时懒创建。
3. `status` 中显示项目是否被 trust。
4. `/new` 不空转。

## 背景与现状

- pi 官方通过 `resourceLoaderReloadOptions.resolveProjectTrust` 门控项目作用域资源加载
  （`.pi/*`、项目 `.agents/skills`、项目包、项目扩展）。
- `src/agent/runtime.ts` 的 `enterRuntime` factory 已在 0.5.2 接入该钩子，但决策链不完整。
- **当前每个项目在 `ProjectRuntime.start()` → `runtime.start()` 时就立即建 session**
  （SDK `createAgentSessionRuntime` 调用即建）。daemon 启动 N 个项目即建 N 个 session，
  即使项目闲置没有消息（成本/资源空转）。
- `ProjectRuntime.getStatus()` 目前只返回 `state/sessionFile/sessionId/model/error`，
  **不含 trust 状态**。
- `/new` 命令在项目空闲时立即 `runtime.newSession()`，在「无活跃会话可重置」场景下属于空转。

## 发现（现状缺口）

### A. trust 决策链不完整
`resolveProjectTrust` 写死 `ProjectTrustStore.get(cwd) === true`（等价 `never`），
未读全局 `defaultProjectTrust`，无 saved 决策时项目作用域配置被跳过。详见 ADR-0001。

### B. session 立即创建（空转）
`PiRuntime.start()` 立即 `createAgentSessionRuntime` + `bindSession`。
SDK 无「runtime 存在但无 session」形态，须在 `PiRuntime` 层做懒建。

### C. status 无 trust 展示
`getStatus()` 未暴露 trust；且 trust 是「创建时快照」，懒建前不存在 session。

### D. `/new` 在无会话时也建 session
无活跃会话时 `/new` 调 `newSession()` 会创建无用空会话（空转）。

## 需求范围（本次实施）

### 需求 1（本项目核心）：trust 决策链对齐官方
- [x] `resolveProjectTrust` 读 `SettingsManager.getDefaultProjectTrust()` 作 fallback，
      不再硬编码 `=== true`。（详 ADR-0001）

### 需求 2：session 懒创建
- [x] `PiRuntime.start()` 不再立即 `createAgentSessionRuntime`；仅初始化 cwd/agentDir 等。
- [x] 内部新增 `ensureRuntime()`（或 `ensureSession()`）：首次 `prompt()`（用户发消息）或
      `newSession()`（`/new`命令）时，才调用 `createAgentSessionRuntime` + `bindSession` +
      设置 `setRebindSession` hook。
- [x] `abort()/compact()/getStatus()` 在无 session 时优雅降级（不抛错）。

### 需求 3：status 展示 trust
- [x] `getStatus()` 增加 `trust` 字段（实现为恒 `boolean`，独立计算故无 `unknown`）。
- [x] trust 解析独立于 session 计算（trust 只读 `trust.json` + `defaultProjectTrust`，
      不依赖 session 是否存在），从而懒建前也能正确上报。

### 需求 4：`/new` 不空转（已敲定为理解 A）
- [x] `/new` 仅在「已有活跃 session」时执行真正重置。
- [x] 无活跃 session（项目闲置未建）时，`/new` **不创建空会话**，返回提示：
      「当前无会话，直接发送消息即可开始新会话」。

## 非目标（本期不做）

- 触发 `project_trust` 事件 / 允许扩展决策。
- 提供 `--approve`/`--no-approve` 单次运行覆盖。
- 重写 `ProjectTrustStore` 最近祖先匹配。
- 闲置自动关闭时**真正 Dispose 释放**当前 session（现状仅置 `sessionExpired` 标记 + 广播，
  未释放。整合懒建模型时可纳入，本期先不改）。
- 会话内热更新 trust（仍为「创建时快照」）。

## 验收标准

1. **懒创建**：项目启动/daemon 启动阶段不创建任何 session（可通过日志/计数验证）；
   用户首条消息或 `/new` 才创建。
2. **trust 对齐**：`defaultProjectTrust: "always"` 且无 saved 决策时，项目作用域配置加载；
   `"never"`/`"ask"` 且无决策时，不加载（不放宽）。
3. **status trust**：`status` 返回 `trust` 字段，懒建前后值正确（`true/false/unknown`）。
4. **不空转**：项目闲置未建 session 时执行 `/new`，不产生新 session（无 `sessionId` 新增），
   返回「当前无会话，直接发送消息即可开始新会话」。
5. 保持 0.5.2 已修复的「项目级权限 allow」行为与最近祖先 trust 决策匹配。

## 影响文件（预估）

- `src/agent/runtime.ts` —— 懒建 `ensureRuntime()`、`getStatus()` 加 `trust`、
  `resolveProjectTrust` 读 `defaultProjectTrust`。
- `src/projects/project-runtime.ts` —— `handleMessage` 首条消息触发懒建；
  `getStatus()` 透出 `trust`；`/new` 空转判断（经 `CommandRouter`）。
- `src/bridge/commands.ts` —— `/new` 空转提示分支。
- 可能抽离 `resolveProjectTrust` 为独立函数供 `PiRuntime` 复用。

## 相关文档

- pi 官方 `docs/security.md`（trust 语义）、SDK `core/agent-session-services.d.ts`、
  `core/resource-loader.d.ts`、`core/project-trust.d.ts`、`core/settings-manager.d.ts`
  （`createAgentSessionRuntime`、`AgentSessionRuntime`）。
- `docs/adr/0001-session-project-trust-resolution.md`、
  `docs/adr/0002-session-lazy-creation-and-status.md`

