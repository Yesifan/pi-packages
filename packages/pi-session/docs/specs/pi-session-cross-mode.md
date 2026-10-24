# pi-session 跨模式运行与异步提示

---
status: completed
execution_time: "2026-10-23 / 2026-10-23"
commit: null
version: null
related_documents:
  - "[规格索引](README.md)"
  - "[原已完成规格](pi-session.md)"
  - "[包文档](../../README.md)"
---

## 范围与决策

扩展原规格的 TUI-only 约定；原规格保持不变。仅修改 pi-session，不抽取公共层，不修改任务层协议、后台 print 模式或资源管理。

- 工具在扩展工厂中无条件注册，TUI、RPC、JSON、print 均可发现。session_start 幂等初始化生命周期 runtime；工具在启动前及关闭后不可执行。
- runtime 初始化与补全分离。四模式均调用公开 addAutocompleteProvider，不以 mode 或 hasUI 筛选；SDK 无编辑器环境可 no-op。注册失败仅 best-effort notify，notify 自身失败也不能阻断工具或输入处理。同生命周期仅尝试一次 provider 注册；跨生命周期由宿主负责 reset 旧 provider。本扩展不把 hasUI 或方法存在等同于实际补全能力：pi-web/pi-wx 若仅提供 no-op，不会因此自动出现补全菜单。
- input 按 source 而非 mode 决定：interactive 与 rpc 展开引用，extension 原样通过。枚举失败原样保留并 best-effort 通知。
- shutdown 立即隔离旧 runtime/报告，再等待清理。重复启动不重建活动任务；切换、reload、退出后旧报告不能进入新生命周期。仅支持 SDK 正常 shutdown/replacement 顺序，不兼容任意绕过 shutdown 的上下文替换。
- ask-session 描述保留授权 cwd、原历史、本扩展实例 steering 和调用方生命周期限制。异步部分使用下述简短文本，不在 description 重复详细等待规则。返回第一段 JSON 与 details 协议不变，第二段追加下述状态提示，`<id>` 使用结果中的实际完整 session ID。accepted 禁止轮询、重做、重新委派；等待期间只简短报告尚待哪些 sessions，然后结束 turn；仅在所有相关报告到达后给出最终答案。steered 继续等待原报告，不产生独立报告；handled 表示输入被处理而非排入 steering，不是完成报告，也不证明原任务仍活跃。

### 明确提示文案

Description 异步部分：

```text
Runs in the background and reports completion or failure automatically. Do not poll or repeat accepted work. Use steer=true to adjust an active task; ask again after completion for follow-up work.
```

accepted：

```text
Accepted background task for session <id>.
Reports arrive automatically; do not poll, redo, or re-delegate accepted work.
While relevant reports are pending, give only a brief progress update identifying the pending sessions, then end your turn. Give the final answer only after all relevant reports arrive.
```

steered：

```text
Steering queued for session <id>. Continue waiting for the original task's report; no separate report is created.
```

handled：

```text
Instructions were handled by the target's input handler, not queued as steering. This response is not a completion report and does not confirm that the original task is still active.
```

- completed/failed 报告追加：`For related follow-up work, reuse ask-session with this full session ID.` 保持报告字段与投递方式。

## 生命周期边界

只开放跨模式可用性，不增加 keep-alive、持久队列、父子任务编排、跨实例锁或恢复。accepted 不代表完成；自动报告仅在调用方生命周期仍存活时可投递。print/JSON 短命进程可在后台工作结束前退出；嵌套 ask 的父任务可能先完成并释放后台 session，关闭其子任务。completed 仅指该次执行，不等于全部子任务已完成。后台 loader 仍绑定 print，prompt/steer 仍用 extension source。

报告继续经调用方模型处理，不改为向终端用户原始直投，也不承诺可靠送达；微信路由不变。cwd 授权不是文件系统沙箱，目标 session 使用目标 cwd 的默认 SDK 环境，不继承 caller trust、工具或其他覆盖配置。不新增祖先、循环或深度检查。

本后续规格未明确替代的搜索、引用、授权与 steer 语义继续遵循原已完成规格；本次不扩大这些功能范围，也不改变目标定位、busy/steer 判断、跨实例并发风险和关闭行为。

## 验收

- 精简四模式矩阵覆盖工厂注册、启动前/关闭后拒绝、幂等启动、工具执行、补全成功/no-op/异常、notify 异常。
- 四模式 × interactive/rpc/extension 输入矩阵，以及引用枚举失败。
- 状态提示不改变 JSON/details，报告后续提示与旧生命周期隔离。
- 真实锁定 SDK 离线集成验证 RPC 绑定与生命周期；不请求付费模型或读取用户会话。
- 每阶段 Biome；包级类型检查、测试、lint、tarball allowlist 检查。README 同步边界，patch changeset，不手动改版。

## 实施结果

锁定 Pi 1.4.0 的 extension runner 默认 UI 与 RPC UI 均提供 no-op addAutocompleteProvider；SDK 文档与实现确认工具工厂注册、bindExtensions 启动以及显式 shutdown 清理边界。未改动 tasks.ts，现有后台 print/source/清理行为保持不变。

包级 typecheck、lint 与 5 文件 / 58 项离线测试通过。新增真实 SDK RPC mode 绑定、工具发现/执行、input source 变换及 shutdown 测试；它使用 in-process runner 和默认 no-op UI，不冒称 RPC 子进程/客户端协议端到端测试。原有真实 SDK 离线模型持久化测试继续通过。未进行付费模型、完整终端 UI 或嵌套模型端到端测试。

pnpm pack 验证 tarball 仅含 manifest、README、LICENSE 与 src 下四个运行时文件；无测试、开发配置、内部规格或 AGENTS.md。新增 patch changeset，不手动改版，不执行发布。
