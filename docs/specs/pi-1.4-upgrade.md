# 全仓 Pi 1.4.0 升级与官方调用语义对齐

---
status: completed
execution_time: "2026-10-22 / 2026-10-22"
commit: null
version: null
related_documents:
  - "[规格索引与维护规则](README.md)"
  - "[pi-subagents 领域模型](../../packages/pi-subagents/docs/domain-model.md)"
  - "[Subagents Spec 0002](../../packages/pi-subagents/docs/specs/0002-prompt-and-session-storage.md)"
  - "[Subagents Spec 0004](../../packages/pi-subagents/docs/specs/0004-sdk-builtin-tools-and-mcp.md)"
  - "[ADR-0003](../../packages/pi-subagents/docs/adr/0003-sdk-sessions-and-parent-metadata.md)"
  - "[pi-session 规格](pi-session.md)"
---

## Goal

将四个公开包的开发验证基线及 daemon 内嵌运行时统一升级到原版 Pi 1.4.0，并使用官方支持的调用方式处理提交、steering 和取消，避免依赖 SDK 内部通知回调的异常控制流。

用户仍可创建、继续和调整后台任务，获得准确的接受结果与在线报告；不能为了通过升级测试而吞掉错误、假报已接受、延长超时或放松执行归属检查。

## Solution

统一更新 workspace catalog 与锁文件，保留 Node 和 TypeBox 基线。subagents 收敛为官方 services 初始化、SDK 原生模型恢复、公开 prompt/steer/abort 生命周期；daemon UI 使用公开类型，删除过时说明与可避免的断言。无公开等价 API 的宿主适配保留，不做全面重构。

普通任务在调用 SDK 前先完成本地准备持久化；提交之后按官方运行生命周期处理失败与取消，不再把内部 preflight 通知当作可以回滚的事务提交点。严格 steering 使用公开 `session.steer()`，不以 `prompt({ streamingBehavior: "steer" })` 实现只排队操作。

用户已确认使用原版 1.4.0，优先官方 API，接受不影响主要功能的官方默认行为，包括恢复 fallback 与 steering 输入展开。本规格以简单的后台提交和串行清理边界替代内部 preflight veto，不维护第二套 SDK 接受状态机。

## User Stories

1. 作为仓库维护者，我希望四包在同一 Pi 1.4.0 基线上安装、检查、测试和构建，避免开发与内嵌运行时版本混装。
2. 作为 subagent 调用者，我希望本地准备写入失败时任务不进入 SDK，避免明知无法保存身份仍启动模型。
3. 作为 subagent 调用者，我希望提交失败或取消时不会遗留永久 busy，也不会把已经发生的运行或排队伪装成未发生。
4. 作为正在调整后台任务的调用者，我希望 steering 只影响捕获的当前执行，不因输入 hook 期间原运行结束而另启一次任务。
5. 作为使用输入扩展的用户，我希望 handled、转换和排队遵循 Pi 的公开合同，而不是通过内部异常中断流程。
6. 作为恢复任务的用户，我希望角色工具策略与 history 身份保留，模型及 thinking 由 SDK 恢复；历史选择不可用时遵循官方 fallback 并提供已有诊断，不因升级产生额外任务或旧报告补投。
7. 作为扩展使用者，我希望后台报告触发新回合、启动期取消及会话切换后仍无重复报告、误投或提前释放。

## Implementation Decisions

### 1. 版本与升级范围

- 影响 `@yesifan/pi-weixin-daemon`、`@yesifan/pi-subagents`、`@yesifan/pi-session`、`@yesifan/pi-system-prompt`。
- catalog 的 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 同时精确锁定 `1.4.0`，同步生成根锁文件，检查间接 Pi 依赖解析与目标发行版一致。
- 使用 npm 发布的原版依赖；禁止 pnpm patchedDependencies、fork、vendor SDK、运行时 monkey patch 或修改 SDK 私有 busy 字段。
- Node 下限仍为 `>=22.19.0`，TypeBox 仍为 `1.3.27`；更新 catalog 中旧 Pi 版本注释，不顺带升级无关依赖或迁移包管理工具。
- 安装时产生的 release-age 例外需单独审查，仅保留实际需要的精确条目，不扩大为通配例外。
- 当前 peer 范围已接受 1.4；升级开发基线本身不等于提高最低宿主版本。新增最低版本限制必须有使用新版能力的实际依据，并同步公开兼容性说明。

### 2. 正确归因与调用边界

- `preflightResult` 两版均被声明为供 RPC 观察已接受 prompt 派发结果的内部通知，不是 admission/veto API。
- 当前实现依赖在通知中抛错阻止后续运行，属于未受支持的控制流依赖；必须移除这种用途，而非把既有实现视为 SDK 的公开保证。
- 原版 1.4.0 同时存在通知抛错后的异常清理缺口：prompt reject，但 busy 未释放，abort 等待 idle。该事实用于解释升级故障，不作为本包继续使用通知 veto 的理由。
- 删除本包对内部 preflight 通知的依赖，不用它确认提交、持久化或否决启动；不为保留旧 started/handled 同步握手再建一套通知协议。
- `before_agent_start` 不是取消 gate，不使用未支持的 `cancel` 返回值，也不通过 handler throw 实现可靠否决。输入阶段需要消费输入时沿用公开 `input → handled` 合同，但不假设其能提供较晚阶段的事务原子性。

### 3. 普通创建与 ask

- 保留 name reservation、同步 busy 占用、调用方权限检查、完整角色 snapshot、history identity、目标资源隔离及每个 Agent 同时最多一个 Execution。
- 在调用 `session.prompt()` 之前完成本地必要的 intent/reservation 持久化；写入失败立即返回失败，不调用 SDK、不请求模型。
- reservation 只表示本地准备，不得宣称 SDK 已开始运行。复用现有 opening/running/idle/interrupted 状态，不新增持久任务队列、运行日志副本或多阶段接受状态机。
- 普通工具成功结果改为 `submitted`：必要准备已持久化且 `prompt()` 已调用，completion 已接入后台处理；不等待整轮模型完成，也不保证 SDK 已启动或会调用模型。已有 `steered` 结果仍只表示 SDK queued。
- 提交前持久化 running，含义调整为“本包已承担后台任务责任”，不代表 SDK 正在 streaming；写入失败不调用 prompt。写入成功到实际调用之间退出的微小窗口按 interrupted 恢复，接受保守状态，不增加事务日志或重启对账。opening 的既有准备恢复规则不变。
- 不再要求“SDK started 与本地 durable acceptance 原子提交”。SDK 提交后的失败走既有后台完成/失败及清理流程，不能删除已有 history、声称没有模型活动或回滚第三方扩展副作用。
- 普通输入被扩展 handled 时，submitted 仍只表示已提交，不伪造 started 或 assistant 回答；按本轮实际结果结束，不把旧回复当本轮结果。不要求工具同步返回 PROMPT_HANDLED，不无条件 abort 扩展自行启动的工作，不为识别 handled 使用内部 hook。
- 提交前失败只清理本次可安全撤销的准备资源；提交后保留身份/history，沿现有恢复和报告机制处理。此处不扩张 Spec 0003 的终态通知覆盖。

### 4. 严格 steering

- 发起前仍检查直接所有权、当前 Execution、scope、closing/finalizing、mount 与 streaming 状态；不可调整时保留具体 `SUBAGENT_NOT_STEERABLE` 诊断。
- 使用公开 `session.steer()`，依据 `queued / handled` 返回值反馈，不使用 prompt 的 streamingBehavior 作为 queue-only 保证。
- `queued` 仅保证进入 SDK steering 队列，不保证原 run 仍存活或已经消费。输入 hook 等待期间原 run 可能结束；不得因此启动新 run、创建新 Execution 或为 steering 生成独立最终报告。
- `handled` 表示输入扩展消费，没有本包 steering 入队；保持原执行，不 abort 原任务，不假报 steered。
- 结果和清理始终绑定捕获的 Execution/session。迟到完成不得转投同名 Agent 的后续 Execution，或释放其名额、修改其状态。
- 同一 logical Agent 的 prompt/steer 调用尚未返回或资源清理尚未完成时，仍视为 busy，不允许下一次普通 ask。原 run 结束不等于本包 Execution 已释放；等待 hook 的操作沿现有执行计数/barrier 追踪，不建立多代 session 尾部清理框架。
- 迟到 queued 只能留在捕获的 session，随该 session 最终清理；旧操作结束并清理完成后才允许后续 Execution。不能在旧操作仍可能写入时释放 writer lock，也不能将其队列搬到后续任务。
- 不为了保证消费而自动启动 idle session、转成普通 ask、建立业务补投队列或跨 Execution 搬运消息。
- 公开 steer 没有单次 AbortSignal；不能承诺 input hook 等待期间的取消必然零入队。调用前已取消不提交，调用后已经 queued 不得谎报可撤销。
- 接受公开 steer 的 skill/template 展开及 extension command 拒绝行为，不额外模拟旧 raw-text 行为；工具描述和用户文档明确这一变化。普通 prompt 的模板选项仍使用公开 API，未涉及的现有选项保持不变。

### 5. 取消、失败与关闭

- SDK 提交前可安全拒绝本地请求；提交后在任务停止或 shutdown 时使用公开 `abort()` 停止活动操作，并等待正常生命周期结束，不从内部通知抛错。原工具取消不追溯撤回已提交的后台任务。
- 不在需要 SDK 继续推进才能 settle 的同步通知中等待 abort，不制造自等待。
- 保留执行归属保护：旧请求的取消不得 abort 同一 logical Agent 的新 Execution；普通已接受后台任务不因原工具结束或取消而被追溯撤回。
- root shutdown/replacement 继续关闭 descendants、取消 UI、dispose sessions，最后释放 writer lock。输入 hook 不合作时不能假装已释放所有写入者；不承诺任意第三方 hook 能强制终止。
- 保留既有终态报告覆盖与单次报告/barrier 约束，不借本升级实现尚未开始的 Spec 0003。

### 6. 官方 API 替换自维护适配

| 范围 | 官方 API / 决策 | 删除或收敛的维护内容 |
| --- | --- | --- |
| child services 初始化 | `createAgentSessionServices()` + `createAgentSessionFromServices()` | 手动创建和接线 loader/runtime、遍历并清空三类 pending provider registrations、手动 refresh。 |
| 历史模型与 thinking | session factory 的原生恢复、默认选择及 fallback | 本地 `historicalModel` 分支算法、重复 clamp/选择比较，以及仅为强制历史选择而保留的前后校验。 |
| steering | `session.steer()` 的 queued/handled 返回值 | prompt streamingBehavior + preflight 包装、unexpected started veto。 |
| 提交与取消 | `session.prompt()` completion 和 `session.abort()` | preflight 中的同步 durable acceptance、抛错 veto、started 握手。 |
| daemon UI 类型 | 根导出的 `TerminalInputHandler`、`WorkingIndicatorOptions` 等，或公开接口的参数类型 | 过时“未导出”注释及因此产生的可避免 never/类型断言；不替换微信 UI 行为。 |

- services 每次 mount 独立创建；将现有 loader 配置传入公开 options，保留 trust 前置、own-extension 排除、角色 prompt 顺序与三项 builtin factories。官方 services 不自动注入 codemode/tool-search/MCP，不顺手删除配置。
- 官方 services 将 provider 注册异常汇总到 diagnostics，而非直接抛错。本包必须拒绝 error diagnostics，并保留可定位原因，不能因迁移静默忽略初始化错误。接受 factory 内部创建 runtime/reload 的官方顺序，授权仍须早于目标项目资源加载。
- 恢复时不传 parent/settings 的额外模型覆盖，交由 SDK 解释实际 history。接受官方对历史模型缺失、鉴权不可用、无 model selection 或 thinking entry 时的默认选择、fallback 与 clamp；不再要求缺失即失败或 bind 前后完全相同。
- 有 `modelFallbackMessage` 或其他公开诊断时通过现有日志/UI 机制展示；没有 warning 不自行扫描历史伪造 fallback 判断，也不宣称一定保留原模型。SDK 无可用模型或后续调用失败仍正常报错，不保证 fallback 总能成功。
- 仅移除模型/thinking 选择的额外严格约束；保留 history 文件身份、cwd、损坏数据检查、trust、角色 snapshot、工具策略及所有权检查，不将“接受 fallback”扩大为允许打开错误 history。
- 没有公开等价 API 的适配暂时保留：daemon 的项目级标量设置写入不能换成 global setter；空 session identity 提前持久化不能用假消息替代；微信 UI 路由/超时和 session 搜索授权/限额仍属业务职责。记录局限，不扩大 SDK 私有依赖。
- 不因这些替换创建跨包公共抽象或共享可变 services；优先各边界直接调用公开 SDK。

### 7. 其他包与保留约束

- `pi-session` 保留已有公开 steering 调用与轻量任务映射，不为了统一而引入 subagents 状态框架；回归空闲报告、活动 steering、reload/shutdown 和迟到回报抑制。
- `pi-system-prompt` 的启动事件监听只读取两种 messageType 共有字段时不加无意义的 user-only 限制；验证 custom-triggered 回合也能捕获真实系统提示词及工具。
- daemon 继续把 SDK 适配限制在 Pi 边界，不向领域层引入 SDK 对象；回归 busy/abort、会话更换后的扩展绑定与最终回复投递。
- subagents 保留目标 cwd 当前工具集合重建、角色排除优先、MCP 动态注册过滤、history 恢复、trust-before-resources 与独立 session 打开边界。
- SDK 恢复 active tools、compaction 输出上限、provider 默认值和 codemode worker 最多等待 60 秒属于上游行为，不在本包复制旧 SDK 实现；验证本包承诺而非冻结上游内部算法。

### 8. 文档、架构与发布

- 本规格为跨包升级计划，不改写已完成规格的历史验收结果；实施后有关接受点、取消及 steering 的当前约定由本规格最终确认版本扩展或替代。
- 实施时新增简短包内 ADR，关联 ADR-0003，解释放弃内部 preflight veto、采用 SDK 恢复/fallback 与串行清理的取舍，保留 history/所有权/存储决策及旧理由。
- spec 维护验收，ADR 记录理由，README/工具描述只讲用户可见的 submitted、steering 展开、恢复 fallback 等变化；权威规格顶部、domain model、AGENTS 删除冲突断言并链接权威说明，不重复复制整套协议。同步其他包当前验证基线，历史研究基线不批量替换。
- 所有公开行为变更在 changeset 中明确说明。subagents 若按本规格改变接受、取消或模板展开承诺，标记 BREAKING，按仓库规则升 minor；仅兼容升级的包使用 patch。依赖锁文件变化本身不要求给纯开发依赖包虚增版本。
- 功能阶段不手动修改 package 版本与 CHANGELOG；由 Changesets 版本流程生成。
- 检查各包发布 allowlist；README 直接链接且安装后需要的文档应包含于包，不把全仓内部升级计划强行加入发布内容。

## Testing Decisions

沿用现有工具调用/RootRuntime + 真实 SDK 的集成边界，不建立第二套模拟 SDK 状态机。新增测试聚焦改动路径；其他能力运行既有回归，不复制上游完整测试矩阵。

### 测试实践

- 真实原版 Pi 1.4.0 配合离线可控 provider 和 input hook barrier；不默认调用付费模型或个人 MCP 服务。
- SDK busy、队列、模型是否启动和持久 history 使用真实 SDK 验证，不能只靠 factory mock 判定兼容。
- 延续临时 `PI_CODING_AGENT_DIR`、独立 cwd/session/trust/store；清理 history、worker、MCP fixture、UI 和锁。
- 竞争用可控 barrier，不靠长 sleep 或简单增加超时。已有单元测试保留，新增测试尽量收敛在能观察完整任务结果、报告与关闭行为的既有集成边界。

### 验收矩阵

| ID | 外部可观察结果 |
| --- | --- |
| V01 | 四包解析至目标 Pi 基线，Node/TypeBox 未无故变化，无 SDK 补丁或私有字段恢复逻辑。 |
| A01 | 准备持久化失败时工具明确失败，SDK/provider 未收到任务，未留下阻塞后续请求的资源。 |
| A02 | 正常创建/ask 及时返回 submitted，不等待模型完成；同名/busy/准备失败明确拒绝，提交后 reject 进入后台失败处理；handled 或无新回复不假称 started、不复用旧回答。 |
| A03 | 提交后失败不删除既有 history；状态和报告不冒充未运行，后续允许的普通 ask 可正常执行。 |
| S01 | 正常 steering 返回 queued/handled，复用原 Execution，不另启独立 run/Execution 或生成独立报告；正常消费 steering 可以产生后续模型调用。 |
| S02 | 用 barrier 构造原 run 结束而 steer hook 尚未返回：新的普通 ask 仍 busy；hook 返回 queued 不另启 run、不声称消费；清理完成后新 ask 可正常执行且不收到旧输入。不强制支持 E1/E2 重叠。 |
| S03 | hook 消费输入不入队；调用前取消不提交，hook 期间取消不虚构零入队保证，queued 后不假报可撤回；无 preflight 抛错导致的 busy 泄漏。 |
| S04 | 验证官方 skill/template 展开及 extension command 拒绝行为；普通 prompt 与 steer 不混淆。 |
| L01 | 持久化失败、启动期取消、异常 steering 与 shutdown 可完成；另覆盖 shutdown 与迟到 steering 竞争，hook 未退出时不提前释放 writer lock，合作 hook 释放后旧队列/session 最终释放，无永久 busy、悬挂报告或锁泄漏。 |
| L02 | 旧 Execution/scope 的迟到回调不能修改新执行或新会话；单 report、nested processing barrier 和父子依赖不回归。 |
| R01 | 运行已有工具选择/排除、晚注册、cwd 隔离、身份及私有 history/discovery 回归；模型/thinking 用例改为 SDK 恢复及 fallback 合同，不再冻结本地分支选择算法。 |
| R02 | 最小真实 SDK 用例覆盖正常恢复、历史选择不可用时按配置 fallback、公开诊断展示及无可用模型失败；无 model/thinking entry 时不被旧额外预检拒绝，不强求 SDK 未提供的 warning。 |
| I01 | services 工厂加载目标 cwd 的 provider/native/virtual 注册和 builtins；错误 diagnostics 明确阻止提交，无重复注册、跨 mount 共享或 trust 顺序回归。优先扩展已有 child factory 用例。 |
| P01 | 空闲 custom report 触发 before_agent_start 后，系统提示词捕获准确；无重复报告、递归触发或用户提示字段访问错误。 |
| P02 | pi-session 原会话写入、steering、reload/shutdown 与迟到报告抑制继续正确；daemon 的 abort/扩展绑定/回复投递正常。 |

不新增完整 codemode worker 饱和、compaction 或 provider 默认值专项矩阵；运行既有测试，发现本包回归再补最小复现。超时仍须定位记录，不按上游最长等待窗口直接推断通过。

现有三项 `runtime-sdk-lifecycle` 失败用例须按新合同修订预期后保留其业务保护目标，不能直接删除。原版回调抛错复现可作为研究证据，不要求业务测试永远依赖 SDK 缺陷未修复；业务验收应证明正式路径不再触发它。

### 实施顺序与完成门槛

1. 按已确认的 submitted、SDK fallback、官方 steering 与串行清理合同补充简短 ADR/当前文档，先更新行为测试，再开始源码实现；不另设接受协议设计阶段。
2. 建立针对正式调用方式的失败/竞争回归，完成最小生命周期适配和版本升级。每阶段源码/测试修改后立即用根 Biome 格式化，再运行定向类型检查与测试。
3. 验证相关集成用例后执行 `pnpm check`、`pnpm lint`、`pnpm test:ci`、`pnpm build`；记录失败、警告、超时及未验证项，超时不视为通过。
4. 对实际发布受影响包执行 pack 检查，尤其验证 daemon 的 dist 来自新依赖构建，以及源码发布扩展未携带补丁、测试或内部计划。
5. 独立审查接受/取消/steering、services 与恢复替换、真实 SDK 测试及文档一致性。以离线集成、全仓回归和 pack 为自动验收边界；建议最小 TUI/print smoke，不扩展完整终端 E2E。若未执行手测应明确记录，真实模型测试仍需显式授权。
6. 只有实际实施和确认的验收通过后才将 status 改为 completed，补完成日期与验证摘要；本轮规格编写不代表升级实施完成。

## Out of Scope

- 不修改、替换或修补 Pi 1.4.0，不等待新版 SDK 才实施，不通过私有调用模拟旧时序。
- 不新增业务任务队列、持久 inbox、重启补投、exactly-once 或跨文件事务。
- 不迁移 history、改变 name/cwd 授权/角色 snapshot 或放松 trust、工具策略、writer lock。
- 不顺带实现 Spec 0003 的异常退出通知扩展，不保证撤回第三方扩展副作用或零模型消耗。
- 不扩大所有宿主版本的兼容性保证，不默认更新 provider base URL、个人配置或用户主题。
- 不执行远端 push、发布、tag 或真实模型测试。

## 实施验收（2026-10-22）

- 已使用 npm 原版 Pi 1.4.0，四包及间接 Pi 依赖一致；Node/TypeBox 保持原基线，无补丁或新增 release-age 例外。`pnpm install --frozen-lockfile` 最终通过。
- 已完成 submitted、prompt 前持久化、公开 steer、执行计数/barrier 串行清理与 shutdown 锁保护；移除内部 preflight 及同步 store acceptance。真实 SDK lifecycle 13 项覆盖原三项失败用例的新合同、handled、skill/template 展开、command 拒绝与启动/迟到 steering 的 shutdown 竞争。
- 已使用独立官方 services 和 SDK history 恢复/fallback；error diagnostics 阻止初始化，公开 warning 展示。child-session 39 项包含真实空认证/无可用模型失败；tool-policy 17 项保留身份、trust、角色及工具保护。
- daemon UI 使用公开接口类型；system-prompt 新增离线真实 SDK custom-triggered 回合捕获测试；pi-session 既有 steering/reload/shutdown 回归通过。新增 ADR-0004、当前文档及 subagents minor（BREAKING）/daemon patch changeset，未手工改版本。
- 全仓 `pnpm check`、`pnpm lint`、`pnpm test:ci`、`pnpm build` 均通过。离线测试共 **558 项**：subagents 259、daemon 260、session 38、system-prompt 1。Biome 报告 15 项 non-null assertion 警告，无错误，未顺带重构。
- 四包 pack 均通过；检查 tarball 包含新 ADR、最新构建 dist 或源码扩展，不含测试、AGENTS、开发配置或内部升级/未实施计划。daemon 的 pack 前已重新构建。
- 独立审查覆盖 lifecycle/store、services/history、依赖与其余包、文档/发布链接；文档发现的两个问题已修正，源码未发现明确缺陷。
- 初次安装在下载重试后的 prepare 阶段 200 秒超时，后续自动安装亦有超时；未计为通过。直接编译与最终正常 pnpm 全仓检查、构建、冻结安装均通过，未通过延长测试超时规避问题。
- 未执行建议的交互 TUI/print 手测或真实模型测试；未 push、发布或创建 tag。以上完成状态以规格约定的离线集成、全仓回归、pack 和独立审查为边界，不承诺强制终止不合作第三方 hook。

### PR #28 关闭窗口修复（2026-10-23）

审查发现此前启动取消测试暂停在 `before_agent_start`，未覆盖更早的普通 `input` hook。新增真实 SDK 离线 barrier 用例，先确认旧实现于 shutdown 后仍调用 provider 一次；修复后为零次。

关闭中的 scope 收到捕获 session 的公开 `agent_start` 时再次调用公开 `abort()`，不等待事件监听器内的 idle，不复用首次 abort 缓存，不使用内部通知 veto。原 pending/dispose/writer-lock barrier 保留：hook 暂停时锁不可获取，关闭完成后可重新获取。零 provider 仅指该普通输入启动路径，不保证第三方 hook 自身零副作用。

修复后 subagents 全包 22 文件 / 260 项通过，真实 SDK lifecycle 14/14、源码及测试类型检查通过；独立审查未发现明确缺陷。此前 558 项是 2026-10-22 全仓运行记录，不混同本次包级复验。远端 PR CI 仍停在安装依赖失败，本轮没有重跑或将其记为通过。

## Further Notes

### 已确认的收敛决定

用户确认其他简化建议均可采用，并明确：历史选择不可准确恢复等非核心额外约束，应优先让位于官方 API；daemon UI 公开类型替换也纳入本轮。

因此采用 submitted 而非原子 started 接受、公开 steer 的展开/排队边界、SDK 默认恢复及 fallback、官方 services 初始化，以及“旧调用和清理未完成仍 busy”的简单执行边界。取消先前 spec 中要求 E2 已建立后再处理 E1 hook 的强制场景，不建设多代执行清理框架。

测试聚焦官方 API 替换与升级故障的最小真实 SDK 集成、既有全仓回归和 pack；TUI/print smoke 属建议补充，报告实际执行状态，不把历史规格的延期记录冒充本次验证。实施若发现公开 API 无法满足本文核心行为，应停止并提交证据讨论，不恢复内部 veto 或暗加状态框架。

### 已完成研究，不等于实施验收

2026-10-22 在独立临时副本仅升级两个 catalog：安装、四包类型检查和构建通过；离线测试 554 通过、3 失败。失败均在 subagents 的真实 SDK lifecycle 测试，涉及 durable acceptance 失败、hook 期间 steering 取消和 unexpected started。相同文件在 1.1.0 为 10/10 通过，在 1.4.0 为 7 通过、3 失败。

进一步使用原版 1.4.0 完成离线最小验证：preflight 抛错导致 busy 泄漏；公开 steer 在 hook 后原 run 结束时只排队，不启动新 run；handled 不入队；prompt streamingBehavior 在相同竞态下会启动第二个 run。研究产物仅在本地临时目录，不将其绝对路径作为维护者必须具备的验收依赖。

固定版本依据：

- [1.4.0 PromptOptions 与 session 声明](https://unpkg.com/@earendil-works/pi-coding-agent@1.4.0/dist/core/agent-session.d.ts)
- [1.4.0 session 实现](https://unpkg.com/@earendil-works/pi-coding-agent@1.4.0/dist/core/agent-session.js)
- [1.1.0 session 实现](https://unpkg.com/@earendil-works/pi-coding-agent@1.1.0/dist/core/agent-session.js)
- [1.4.0 SDK 文档](https://unpkg.com/@earendil-works/pi-coding-agent@1.4.0/docs/sdk.md)
- [1.4.0 扩展文档](https://unpkg.com/@earendil-works/pi-coding-agent@1.4.0/docs/extensions.md)
- [集中 CHANGELOG](https://unpkg.com/@earendil-works/pi-coding-agent@1.4.0/CHANGELOG.md)

实施已以实际安装的锁定产物核对类型与实现。以上研究发生于规格编写阶段，当时没有修改依赖或源码；临时验证不计为正式验收，本轮实际结果见上方实施验收摘要。
