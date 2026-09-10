# ADR-0003：Pi host 兼容性策略（fail-closed / runtime-key / idle 真关闭 / host 命令域 / UI 降级 / trust 双字段）

- 状态：✅ 已接受（Accepted，`0.6.0`）
- 目标版本：0.6.0
- 日期：见 git 提交时间
- 关联：`docs/requirements/0002-pi-host-compatibility.md`（v2）、ADR-0001/0002
- 修订：依需求目标调整 D-B（cwd 固定，runtime-key = accounts）、D-D（只认 daemon 显式命令，
  未知 `/xxx` 回复「没有该命令」、不做 Pi 透传）、D-F（裁剪：只做 status 双字段），并新增
  D-G（工具不设额外路径边界）

## 背景

`PiRuntime`（`src/agent/runtime.ts`）按 pi 官方文档使用嵌入式 SDK
（`createAgentSessionServices + createAgentSessionRuntime + setRebindSession`），选型正确、
不改为子进程。但对照 `@earendil-works/pi-coding-agent@0.84.4`（当前 pin 即发布版）源码，host
层只实现了部分协议却对外表现成完整 Pi runtime/RPC，产生三类问题：fail-open（extension 加载
失败仍运行、idle 假关闭、session replacement 被取消仍当成功）、状态漂移（accounts 变更不重建
runtime、status 与 active session 的 trust 不一致）、静默失真（extension 命令被吞、
commandContextActions 缺省被 SDK 安装 no-op fallback、UI 原语 reject）。本 ADR 记录为对齐
官方 host 语义而敲定的七项策略（D-A…D-G）。

## 决策

### D-A 诊断 fail-closed：per-project error 态，不崩 daemon

- factory 补齐官方同款诊断收集：`services.diagnostics` + `settingsManager.drainErrors()`
  （warning）+ `resourceLoader.getExtensions().errors`（**error**）。创建后检查
  `runtime.diagnostics`，存在 `type:"error"` 即抛错。
- **fail-closed 粒度是 project**：错误沿 `ProjectRuntime.start()` 落 `state="error"`，
  该 project 拒绝消息（回发原因），其它 project 不受影响。不采用「整个 daemon 退出」——
  与 daemon 多项目故障隔离模型一致，语义上等价「CLI 在单个项目上 exit(1)」。

### D-B project `cwd` 固定；runtime-key = sorted accounts

- **`cwd` 创建后固定、禁止修改**：删除 `project set` CLI 子命令、RPC `project.set`、
  `daemon.setProjectCwd()`；`ProjectStore` 对已存在 project 的 upsert 断言不改 cwd。
  「cfg.cwd ≡ runtime.cwd」恒成立 ⇒ 从构造上消灭 cwd 漂移类问题（不再需要 realpath canonical
  比对）。
- 运行中 runtime 的身份 = **runtime-key = `sorted(accounts)`**（projectId/cwd 固定后唯一变量；
  `ProjectTransport` 的账号集在构造期固定）。key 变化 → stop old → create new。
- 重建自然清空 participant registry ⇒ 解绑账号后立即不再收广播/互通。
- 取舍：accounts 变更会打断运行中 turn（stop/start）并新建 session —— 与「配置即重启」的
  直觉一致、可诊断，接受。

### D-C idle「关闭 session」= 真 dispose；重建 cancelled-aware；host 命令先解析

- `AgentSessionRuntime` 无「只关 session 不建新」操作（`newSession()` 总是立刻建替代 session），
  因此 idle 到期的「真关闭」= dispose SDK runtime（`PiRuntime.closeSession()`，保留 wrapper/
  bridge/participants）；下一条消息经既有懒建 `ensureRuntime()` 重建 **fresh** session。
  **旧 session 物理消失 ⇒ 不存在「newSession 失败仍 ingest 进旧上下文」的路径**（fail-open 从
  构造上消灭）。
- session replacement（/new、extension ctx.newSession 等）一律透传 SDK 的
  `Promise<{cancelled}>`，`session_before_switch` 可取消；取消 → 如实告知，不得当成功。
- 消息处理先解析 host 命令：`/help /status`（纯查询）任何状态不建 session；普通 turn 才触发懒
  建。删除 `sessionExpired` 标志（`hasSession()===false` 即「已关闭」的充分判据）。

### D-D 微信 `/` 输入：只认 daemon 显式命令，未知回复「没有该命令」

- daemon 显式映射 `/help /status /abort /new /compact` 并直接处理；**其它 `/xxx` 一律回复
  「没有该命令」（维持现状）**，不进 Pi、不当普通用户消息。
- **不做 Pi 透传**：Pi 的 extension command / prompt template / skill 不经微信调用（有意简化；
  Pi command system 对 daemon 零暴露）。CommandRouter 只分类
  `daemon-command | unknown-command | message`，执行放 SessionController/ProjectController。
- 边界不变：`/status /abort` 任何状态可用；`/new /compact` 仅空闲；忙时普通消息拒绝。

### D-E UI 降级契约 = `noOpUIContext` 语义：resolve，不 reject

- SDK `noOpUIContext` 的 `editor/custom` 都是 `async()=>{}`（resolve undefined），`theme` 是
  真实 getter；且 `hasUI()` = `uiContext !== noOpUIContext`（与 mode 无关）。本 host bind 了
  uiContext ⇒ extension 会放心调用这些 API，reject 即破坏契约。
- `WeixinUIContext`：`custom()` → resolve undefined；`editor()` → 微信增强版（prefill 提示 +
  下一条普通消息为内容）或最小降级 resolve undefined；`theme` 不再 `{} as Theme` 类型欺骗，
  提供最小合法 Theme getter。其余 TUI 原语维持 no-op 且不 throw。

### D-F trust：status 双字段（裁剪）

- 决策链**维持 0.5.3**：无 trust-requiring 资源 → true；否则 `trust.json` 最近祖先 →
  `defaultProjectTrust`（`always` 信任；`ask/never` 非交互拒绝）。**不触发 `project_trust`
  事件、不允许 extension 参与决策**（保持既有非目标；引入 extension 决策需 spike，非交互
  daemon 收益低）。
- status 分 `configuredTrust`（实时）与 `activeSessionTrust`（session 创建时落定快照，无
  session 为 undefined），消除「实时值 ≠ 实际生效值」的误导。
- 取舍：公司级 policy extension 无法在 daemon 内参与 trust 决策——与 0.5.3 非目标一致、
  文档明示；若后续需要再做最小 `project_trust` 事件支持。

### D-G `weixin_send_file` 不设额外路径边界

- 移除 cwd/tmp containment 检查；仅保留存在性 + 普通文件 + 文件名 sanitize。
- 理由：Pi 官方无 sandbox，agent 已有同权限的 bash/read/write 工具；自设 lexical 边界既非
  真实安全边界（symlink 即可绕过），又制造「工具间权限不一致」的假象。权限模型 = agent 进程
  权限，与其它工具一致、更简单。
- 文档（README/help/doctor）同步声明此权限模型。

## 理由

1. **对齐官方 host 语义**：以上每一项都能在 0.84.4 源码/bundle 中找到精确对应（diagnostics
   收集与 exit(1)、no-op fallback、`{cancelled}` 返回值、prompt() 的 / dispatch、resolveProjectTrust
   签名）。「对外表现成完整 host」就必须在这些点上行为一致。
2. **安全不静默**：extension 加载失败、session 重建失败、trust 决策绕过，都是安全策略
   （permission/policy extension）静默消失的入口——统一走 fail-closed / 显式降级。
3. **最小侵入**：全部落在 `src/agent` + `src/projects` + `src/bridge` 的现有边界内，不换架构、
   不引子进程、不动微信 transport。

## 后果 / 取舍

- D-A：坏扩展会让**整个项目**进 error 态并拒消息（行为收紧）；需要 `project restart` 恢复。
  多项目 daemon 下单个项目自愈不影响其它项目。
- D-B：accounts 变更会打断运行中 turn（stop/start）并新建 session；与控制面操作频率匹配，
  比状态漂移更可诊断。`cwd` 固定后无「cfg/runtime 漂移」可能。
- D-C：idle 后首条消息多一次 SDK runtime 重建开销（与项目冷启动相同）；换来「关闭即真关闭」。
- D-D：微信内只有 daemon 显式命令进入 slash 处理，未知 `/xxx` 回复「没有该命令」（维持现状）；
  Pi extension command / prompt / skill 不经微信透传——比「透传给 Pi 判定」更简单，代价是
  微信无法触发项目 extension 命令（有意取舍）。
- D-E：`editor()` 在微信侧是增强式降级，与真实 TUI 编辑器体验不同——文档注明；至少不再异常。
- D-F：trust 决策仍为 0.5.3 本地链（saved → default），`configured/active` 双字段消除误导；
  policy extension 参与 trust 决策留待后续。
- D-G：`weixin_send_file` 可发 cwd 外文件；安全模型 = agent 进程权限（与 bash/read 一致），
  README 明示。

## 相关实现（预估，见 ADR-0004 目录）

- `src/pi/runtime-factory.ts` / `sdk-host.ts` / `diagnostics.ts`（D-A/D-C/D-F）
- `src/pi/ui-context.ts` / `ui-capabilities.ts`（D-E）
- `src/pi/extensions/weixin-send-file.ts`（D-G：无边界）
- `src/projects/project-manager.ts` / `project-controller.ts`（D-A/D-B/D-C）
- `src/sessions/session-controller.ts` / `session-state.ts`（D-C）
- `src/projects/command-router.ts`（D-D）
- `src/cli/project.ts` / `src/daemon/rpc-server.ts` / `src/daemon.ts`（D-B：删 `project set`）
