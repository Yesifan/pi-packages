# ADR-0002：使用 Pi 原生 Widget 展示后台 Subagent 进度

- 状态：✅ 已接受（Accepted）
- 实施提交：待提交
- 日期：2026-09-11
- 关联：`docs/specs/bykwp-pi-subagents-spec.md`

## 背景

`@BYKWP/pi-subagents` 的 `subagent` 和普通 `ask_subagent` 会在 Pi 接受任务后立即返回，
实际模型调用、thinking 和工具执行继续在后台 child `AgentSession` 中发生。用户需要在不改变
后台语义的前提下看到这些活动，并能同时观察多个 subagent 的进度。

Pi 的 tool `onUpdate()` 只在对应 `execute()` Promise 尚未结束时有效。当前 delegation tool 在
preflight accepted 后即结束 `execute()`；此后继续调用原回调会被 Pi 忽略。因此，后台执行期间
不能继续更新已经结束的 `subagent` tool row，也不能为了使用 `onUpdate()` 而让 delegation tool
等待整个 child run 完成，否则会破坏“始终后台”的公开契约。

Pi 0.85.1 原生提供 `ctx.ui.setStatus()`、`ctx.ui.setWidget()` 和 `ctx.ui.notify()`。其中：

- status 将所有扩展状态拼成 footer 中的一行，空间有限，不适合并发 subagent；
- notify 会为每次活动产生独立通知，频繁更新会刷屏；
- widget 可用字符串数组原地替换多行内容，不进入模型上下文，适合聚合后台进度。

## 决策

本项目启用 **Pi 原生字符串 Widget** 展示后台 subagent 进度。

由 `RootRuntime` 订阅每个活动 child `AgentSession` 的原生事件，维护 root-session-local、
run-local 的瞬时进度状态，并通过 root `ExtensionContext` 调用：

```ts
ctx.ui.setWidget("pi-subagents-progress", lines, {
  placement: "belowEditor",
});
```

显示形式例如：

```text
worker[3]：bash npx install ...
reviewer[2]：thinking
```

其中：

- `turn_start` 用于累计当前 logical run 的模型调用次数；
- 每个活动 subagent 只保留一条最新信息，不累计活动历史；
- thinking 事件将最新信息设为阶段标签，不展示模型 reasoning 正文；
- tool execution 事件将最新信息替换为工具名和经过折叠、截断的关键参数，例如 bash command 或文件 path；
- 多个活动 subagent 由 `RootRuntime` 聚合到同一个 widget，每个 subagent 占一行；
- 同一个 widget key 的更新替换当前视图，不向聊天记录追加消息；
- 活动 subagent 数量和单行长度必须有界，避免占满编辑区；
- 最后一个活动 run 结束以及 root shutdown、reload、new、resume 或 fork 时清除 widget。

Widget 只能由本包持有的 root runtime 更新。`SubagentUiProxy.setWidget()` 继续保持不转发，
child 项目扩展不能借此修改 root widget。该决定不增加公开工具参数，也不改变 delegation、
steering、report 或持久化语义。

## 理由

1. **保留后台契约**：delegation tool 仍在任务被接受后立即返回，parent 可以继续独立工作。
2. **只使用 Pi 原生能力**：字符串 widget 由 Pi 自带组件渲染，不引入第三方 UI 库，
   不实现自定义 TUI component。
3. **适合并发最新状态**：多行区域比 footer 单行 status 更适合同时展示多个 subagent；
   每个 subagent 原地替换最新信息，也不会像 notify 一样刷屏。
4. **不污染上下文**：widget 是瞬时 UI 状态，不进入 parent 模型上下文，也不写入 child history。
5. **权限边界清晰**：root runtime 统一聚合和清理；child 的任意扩展仍无权直接操作 root widget。

## 取舍 / 边界

- **不是原 tool row 的流式更新**：后台任务开始后，已完成的 `subagent` tool row 保持原 accepted
  result；进度显示在编辑器下方的独立原生区域。
- **不是通用 dashboard**：只展示当前 root 下活动 logical run 的简短只读快照，不增加交互、
  任务控制、历史查询或新的调度能力。因此，规格中的“不实现 dashboard、自定义组件”继续成立；
  本 ADR 仅批准一个用途受限的原生字符串 widget。
- **不持久化进度**：resume 后不会重建已结束或 interrupted run 的旧快照；最终结果仍以现有
  `SubagentReport` 和 child session history 为准。
- **不展示 thinking 正文或工具输出**：避免将 reasoning、长日志或潜在敏感输出复制到 root UI。
  工具摘要只取必要参数并进行单行清理与截断。
- **受宿主模式约束**：Pi TUI 直接显示 widget；RPC 模式发出原生 `setWidget` UI 请求，由客户端
  决定如何呈现；print/JSON 模式没有可视 widget。
- **遵守原生容量限制**：Pi 0.85.1 的字符串 widget 最多渲染 10 行。实现应在活动 subagent
  超出容量时显示明确的省略行，而不是依赖宿主的最终截断提示。

## 后果

- 正向：用户可以在 parent 继续工作时观察后台 subagent 的模型轮次和当前活动。
- 正向：多个 subagent 使用一个固定区域，更新不会增加会话消息或模型 token。
- 正向：不新增运行时依赖，不改变 tool schema、system prompt 或 provider prompt cache。
- 风险：widget 会占用编辑器附近的垂直空间；必须限制行数，并在生命周期结束时可靠清理。
- 风险：工具参数可能很长或包含敏感信息；formatter 必须使用 allowlist、单行化和截断，
  不得直接序列化完整参数或展示 tool output。
- 兼容性：其他扩展可能同时使用 widget；本包使用固定 namespaced key，交由 Pi 原生 widget map
  与其他扩展并存，不替换 footer、editor 或其他扩展的 widget。

## 相关实现

涉及：

- `src/runtime.ts`：订阅 child session 活动、维护进度并触发聚合更新；
- `src/types.ts`：定义 run-local progress 状态；
- `src/ui.ts`：由 root broker/runtime 持有固定 widget，统一更新和清理；
- `test/unit/`、`test/integration/`：覆盖模型调用计数、最新 thinking/tool 摘要替换、并发聚合、
  旧 mount 事件隔离以及 finalize/shutdown 清理。
