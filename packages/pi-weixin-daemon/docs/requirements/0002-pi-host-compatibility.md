# 需求：Pi host 兼容性重构 —— 架构优先，五阶段（对齐 pi 0.84.4 host 语义）

- 状态：✅ 已完成（`0.6.0`，五阶段逐步提交）
- 目标版本：0.6.0（删 `project set` 按 BREAKING → minor）
- 涉及 ADR：`docs/adr/0003-pi-host-compatibility-policies.md`（行为策略）、
  `docs/adr/0004-layering-and-dependency-direction.md`（分层与依赖方向）
- 关联：`docs/requirements/0001-session-trust-fix.md`、ADR-0001/0002
- 基准：`@earendil-works/pi-coding-agent@0.84.4`（当前 pin 即发布版）

## 需求目标

不引入 RPC、继续直接嵌 Pi SDK；把散落在业务层里的 Pi host 职责收拢成完整的 **SDK Host 层**，
并借此把已知 bug 从「靠记得处理」变成「架构上不容易写出来」：

1. **收口**：只有 `src/pi/` import Pi SDK（含类型），对外只用领域类型（ADR-0004 Invariant 1）。
2. **正确性**：diagnostics fail-closed（W1）；idle 真关闭 + cancelled-aware 重建（W3）；
   project 生命周期与配置一致（W2/W10）。
3. **host 契约**：完整 `bindExtensions`（W5）；UI 降级契约（W6）；trust 双字段（W7）；
   微信 `/` 输入只认 daemon 显式映射的命令，未知回复「没有该命令」（W4）。
4. **简化**：project `cwd` 固定不可改；`weixin_send_file` 无路径边界；删 `sessionExpired`、
   `project set` 全链路。

架构选型不变：`createAgentSessionServices + createAgentSessionRuntime + setRebindSession`，
分层见 ADR-0004。

## 修订说明 v3（相对 v2）

- 由「按 P0/P1/P2 平铺」改为「**架构优先、五阶段**」：先收口 SDK import，再在边界内修 host
  行为，再立 SessionController 状态机，再改 CommandRouter，最后 ProjectController + snapshot。
- 确认 `weixin_send_file` **维持无边界**（ADR-0003 D-G）：不建 `security/path-policy`。
- 确认 slash 语义（原 W4 ⚠️ 项，二次修订）：只有 daemon 显式映射的命令（`/help /status
  /abort /new /compact`）进入 slash 处理；未知 `/xxx` 回复「没有该命令」（**维持现状**），
  **不做 Pi 透传**（extension command / prompt / skill 不经微信调用）。
- 新增 ADR-0004 作为架构骨架；W 编号沿用 v2（W1–W10），归入对应阶段。

## 架构结论（ADR-0004 摘要）

- 分层：`ProjectController → SessionController → PiSdkHost → SDK`；旁路能力经 port 反向注入
  （`InteractionPort` ← weixin 交互控制器、`FileSenderPort` ← weixin 文件发送）。
- 三 invariant：① 只有 `src/pi/` import SDK（含类型，lint 强制）；② session 生命周期单一状态机
  `inactive/ready/busy/replacing/faulted`，无第二份 busy/turn 信号（`src/bridge/` 消失）；
  ③ project 只持有 immutable snapshot，`sync()` = desired → diff → restart（本期无 hot-update）。
- `PiRuntimeFactory` 是 **createRuntime 回调**（幂等可重入），`bindExtensions` 挂在
  `setRebindSession` rebind 路径。

## 五阶段实施

每阶段退出条件 = 既有 `test/`（unit + fake 集成 + 真 Pi SDK + UDS RPC）全绿 + 阶段验收项。

### 阶段 1：建立 PiSdkHost / PiRuntimeFactory / PiExtensionHost（不改外部行为）

- 新建 `src/pi/`：`sdk-host.ts`、`runtime-factory.ts`、`session-host.ts`、
  `extension-host.ts`、`diagnostics.ts`、`project-trust.ts`、`ui-context.ts`、
  `ui-capabilities.ts`、`events.ts`、`ports.ts`。
- 把现有 `PiRuntime` 的 SDK 调用平移进来，**行为不变**（懒建、bindSession、prompt/abort/
  newSession/compact/getStatus、resolveProjectTrust 语义均保持）。
- 上 eslint `no-restricted-imports`：除 `src/pi/` 外禁 import `@earendil-works/pi-coding-agent`
  与 `@earendil-works/pi-ai/compat`；把 `src/agent/events.ts`、`src/bridge/response.ts` 的
  `AgentSessionEvent`/`ImageContent` 消费改为领域类型（`PiHostEvent` / `HostPromptInput`）。
- 退出条件：lint 全绿；既有行为等价（真实 SDK 集成、fake 集成用例不改断言即可过）。

### 阶段 2：在 Pi Host 边界内修 host 行为

- **W1 诊断 fail-closed**：`PiRuntimeFactory` 收集 `services.diagnostics` +
  `settingsManager.drainErrors()`（warning）+ `resourceLoader.getExtensions().errors`
  （`type:"error"`）；`hasFatalDiagnostics` → `runtime.dispose()` + throw `PiInitializationError`。
  `PiSdkHost.start()` 只在 ready 后返回；失败沿 `ProjectRuntime.start()` 落 `state="error"`，
  `handleMessage` 拒消息（per-project fail-closed，不崩 daemon）。
- **W5 完整 bindExtensions**：`PiExtensionHost.bind(session, controller)` 唯一收口
  `bindExtensions({ uiContext, mode, commandContextActions, onError })`；六动作绑公开 API
  （`waitForIdle→session.waitForIdle`、`newSession→runtime.newSession`（透传 cancelled）、
  `fork→runtime.fork`、`navigateTree→session.navigateTree`、`switchSession→runtime.switchSession`、
  `reload→session.reload`）；`onError` 结构化日志。**bind 挂在 rebind 路径**（ADR-0004）。
- **W6 UI 降级契约**：`ui-context.ts`（适配器）+ `ui-capabilities.ts`（`confirm/select/input/
  editor=true；custom=false`）。`custom()` → resolve undefined（不 reject）；`editor()` →
  微信增强版或最小 resolve undefined；`theme` 改只读 getter 返回最小合法 Theme 对象（弃
  `{} as Theme`）；其余 TUI 原语 no-op 不 throw。
- **W7 trust 双字段**：`project-trust.ts` 为 SDK adapter，决策链**维持 0.5.3**（saved →
  defaultProjectTrust，不触发 `project_trust` 事件）；`getStatus()` 输出 `configuredTrust` 与
  `activeSessionTrust`（session 创建时落定快照）。
- **W8 runner-level settings（裁剪版）**：不实现 sessionDir 贯通；README 措辞改为
  「resourceLoader 层生效；runner-level settings（sessionDir 等）不支持」。

### 阶段 3：SessionController 单一状态机（修 idle / busy / replacement）

- 新建 `src/sessions/`：`session-state.ts`（`inactive/ready/busy/replacing/faulted`）、
  `session-controller.ts`（turn 串行化 + idle timer + 状态机）。
- 把 `ProjectRuntime` 的 `busy/sessionExpired/idleTimer/newSession/abort/compact` 与 `Bridge`
  的 `turnPromise`/状态搬入；**删除 `sessionExpired`**；拆掉 `src/bridge/`。
- **W3**：`ready →(超时)→ inactive` 执行 `closeSession()`（dispose SDK runtime，保留 wrapper/
  bridge/participants）；`inactive →(newSession 成功)→ ready → prompt`；失败 → `faulted`（
  **不 prompt**）；`newSession` 透传 `{cancelled}`；host 命令先解析（`/help /status` 不建 session，
  `/new` 仅 `ready` 时重置）。顺带修掉「`/new` 双 newSession」。
- 退出条件：状态机对非法组合有编译/断言级保障；idle 后旧 session 不复用（新 sessionId）；
  `session_before_switch` 取消 `/new` 时如实回复。

### 阶段 4：CommandRouter → classifier（保持未知命令提示，不做 Pi 透传）

- 新建 `src/projects/command-router.ts`，只返回 `RoutedInput`：
  `{ kind:"daemon-command", command }`（`/help /status /abort /new /compact`）、
  `{ kind:"unknown-command", text }`（其它 `/xxx`）、`{ kind:"message", text }`（非 `/` 开头）。
- **W4（修订）**：只有 daemon 显式映射的命令进入 slash 处理；未知 `/xxx` 回复
  「没有该命令 / 输入 /help 查看」（**维持现状**），不进 Pi、不当普通用户消息。
  daemon 命令的**执行**放 `SessionController/ProjectController`，router 对 Pi command system
  零知识。Pi 的 extension command / prompt template / skill **不经微信透传**（非目标，见下）。
- 边界不变：`/status /abort` 任何状态可用；`/new /compact` 仅空闲；忙时普通消息拒绝。

### 阶段 5：ProjectController + immutable snapshot + reconcile（修配置漂移）

- 新建 `src/projects/project-controller.ts`、`project-config.ts`（snapshot）、
  `participant-registry.ts`；`ProjectRuntime` 变轻量 `ProjectController`（组合
  SessionController + CommandRouter + ParticipantRegistry + snapshot）。
- **W2 + W10**：`cwd` 仅 create 时设，**删除 `project set` CLI/RPC/`daemon.setProjectCwd()`**，
  `ProjectStore` 对已存在 project 断言不改 cwd；runtime-key = `sorted(accounts)`，变更 → restart；
  `sync()` = desired → diff → `none | restart`；`listStatuses()` 报 effective。
- **participant 授权**：`getBroadcastTargets() = observed ∩ configuredAccounts`（即使 restart
  已清空 observed，仍保留 intersect 防御）。
- **W9 weixin_send_file 无边界**：`src/weixin/file-sender.ts` 实现 `FileSenderPort`；
  `src/pi/extensions/weixin-send-file.ts` 只做 tool 适配 + `exists/isFile/sanitizeFilename`；
  删 cwd/tmp containment 与相关单测；README/doctor 声明权限模型 = agent 进程权限。

## 非目标（本期不做）

- 不改为 `pi --mode rpc` 子进程；不引入 RPC。
- 不实现 TUI 全集（TUI 专属原语 no-op 且不 throw、theme 可安全访问）。
- 不实现 Pi 内置 host 命令全集（`/model`、`/themes` 等）。
- 不把 Pi extension command / prompt template / skill 经微信透传（slash 只认 daemon 显式命令，
  未知回复「没有该命令」）。
- 不触发 `project_trust` 事件 / 不允许 extension 决策 trust（W7 维持 0.5.3 决策链）。
- 不实现 runner-level settings（sessionDir 等，W8 文档声明不支持）。
- 会话跨重启恢复仍不支持；会话内 trust 热更新仍不做。
- 不引入额外文件沙箱：`weixin_send_file` 权限 = agent 进程权限（无边界）。
- 不引入 Actor/mailbox、不做完整 hexagonal；不做 hot-update 分支。

## 验收标准（总体）

1. **架构**：lint 确认只有 `src/pi/` import Pi SDK；`src/bridge/`、`src/agent/` 消失；
   领域事件/类型在边界翻译；无第二份 busy/turn 信号；project 只读 immutable snapshot。
2. **P0 正确性**：坏 extension → 该项目 error 态 + 拒消息 + 其它项目不受影响（W1）；accounts
   变更 → restart、解绑账号立即不再收广播（W2）；idle → dispose + 全新 sessionId、`/new` 被
   取消如实回复（W3）。
3. **P1 契约**：微信 `/help /status /abort /new /compact` 正常；未知 `/bar` 回复「没有该命令」
   （W4，维持现状、不做 Pi 透传）；测试 extension 调 `ctx.ui.editor/custom` 不抛异常、
   `ctx.newSession/reload/navigateTree/switchSession/fork/waitForIdle` 真实生效（W5/W6）；
   `/status` 展示 `configuredTrust` 与 `activeSessionTrust`（W7）。
4. **简化**：`project set` 已移除；send_file 可发 cwd 外 agent 可读文件、拒绝不存在/目录（W9）；
   无 `sessionExpired` 残留；README 措辞如实（W8）。
5. **回归**：0.5.4 全部既有行为不回退（真实 Pi SDK 集成、fake 集成、UDS RPC、`/new` 不空转、
   trust 决策链回归、`pi-wx doctor`）。

## 影响文件（新目录）

- `src/pi/`（新增，阶段 1/2）
- `src/sessions/`（新增，阶段 3）
- `src/projects/`（project-controller/config/participant-registry/command-router 新增；
  project-manager/project-runtime/project-store 改造，阶段 4/5）
- `src/weixin/`（interaction-controller、file-sender 新增，阶段 5）
- `src/cli/project.ts`、`src/daemon/rpc-server.ts`、`src/daemon.ts`（删 `project set`，阶段 5）
- 删除：`src/agent/`、`src/bridge/`（逐步，阶段 1/3/4）
- `README.md`（W4/W8/W9 措辞，阶段 2/5）
- 测试：`test/unit`（commands、send-file、ui-context、session-state）、`test/integration`
  （project-manager / project-runtime→project-controller / Pi SDK / UDS RPC）

## 版本与变更记录（计划）

- 0.5.4 → **0.6.0**（minor；删 `project set` 按 BREAKING 处理，需手动升级的项目重建）。
- 实施完成后：本文件置 ✅、ADR-0003/0004 置 Accepted、`docs/requirements/README.md` 索引、
  CHANGELOG 新增 0.6.0。

## 相关文档

- pi 0.84.4：`docs/README.md`、`docs/rpc.md`、`docs/security.md`；SDK `agent-session.d.ts`
  （prompt/PromptOptions/reload/navigateTree/waitForIdle/promptTemplates）、
  `agent-session-runtime.d.ts`（newSession/switchSession/fork、diagnostics、services、
  setRebindSession）、`resource-loader.d.ts`、`settings-manager.d.ts`、
  `extensions/runner.d.ts`、`extensions/types.d.ts`（ExtensionCommandContextActions）。
- `docs/adr/0001…`、`0002…`、`0003-pi-host-compatibility-policies.md`、
  `0004-layering-and-dependency-direction.md`、`docs/requirements/0001-session-trust-fix.md`。
