# 需求 0011：运行时代码与状态精简

---

status: not-started
execution_time: "2026-10-21"
commit: null
version: null
related_documents:
  - "[需求 0009：项目微信用户与消息投递简化](0009-project-weixin-user-simplification.md)"
  - "[需求 0010：默认会话、CLI 与 MCP（本次不实施）](0010-project-session-cli-mcp.md)"
  - "[领域模型](../domain-model.md)"
  - "[消息路由](../routing.md)"
  - "[ADR-0004：分层与依赖方向](../adr/0004-layering-and-dependency-direction.md)"
  - "[ADR-0005：Slash 命令与交互仲裁](../adr/0005-weixin-slash-session-controls.md)"
  - "[ADR-0006：会话级回复](../adr/0006-session-wide-agent-reply-routing.md)"
  - "[ADR-0007：统一投递](../adr/0007-project-weixin-users.md)"
  - "[Issue #23：logout RPC 错误回退（独立处理）](https://github.com/Yesifan/pi-packages/issues/23)"

---

## Goal

维护者希望在保留 pi-wx 当前行为的前提下，减少无人使用的运行时代码、重复状态和重复处理步骤，让账号生命周期、微信投递与 Pi 适配更易理解和维护。

优化以消除维护负担为目标，不以 PR 总删行数为验收条件；必要测试可以增加，但不得为了压缩代码引入更复杂的通用框架。

## Solution

分两阶段实施：先删除已确认的闲置代码、只写字段和测试兼容分支，再合并具有同一生命周期的状态与重复步骤。每阶段独立验证、可单独回滚。

用户已确认：`dist` 内部模块的深层导入不属于承诺的公开 API，可以删除无消费者的内部导出。CLI、RPC、微信命令、配置文件和实际收发行为仍须保持兼容。现有 SDK 隔离边界继续保留。

## User Stories

1. 作为维护者，我希望删除无人使用的 Pi 门面和能力声明，使代码中的有效实现与文档契约一致，不必同步维护两套描述。
2. 作为微信用户，我希望实际使用的图片、文件、登录和消息投递不受死代码清理影响，也不因删除未使用的下载支线失去现有媒体能力。
3. 作为维护者，我希望登录状态和账号生命周期只保存必要数据，避免只写不读字段或两个同键集合发生漂移。
4. 作为运维人员，我希望启动与 reload 按一致步骤恢复 token、创建 transport 和注册账号，同时保留各自的日志及账号增删语义。
5. 作为运维人员，我希望业务失败与网络失败遵守同一退避策略，但 stale-token 暂停、成功后清零和中止行为不变。
6. 作为项目用户，我希望会话切换、busy、UI 回答关联、typing 清理、错误隔离和广播规则完全不变，优化不引入默认会话或 MCP 等新功能。
7. 作为维护者，我希望通过现有离线测试观察行为是否保持，而非为每个被删除的 helper 再建一套测试。
8. 作为维护者，我希望所有 daemon 发起的 Pi 运行会话业务统一经过 PiSdkHost，避免上层绕过同一 SDK 适配入口，也避免将必要的 SDK 内部回调误判为业务绕过。

## Implementation Decisions

### 范围与兼容性

- 以需求 0009 及后续 #19/#20/#21 修复后的代码为基线，不重复实施已经删除的 participant、账号推断函数、广播 `isCurrent` 参数或 resolver fallback。
- 内部导出不提供深层导入兼容承诺；删除前仍检查本仓库源码、测试和运行时资源中的引用，不能仅凭单个文件的导入判断无消费者。
- 不改变公开命令和 RPC 的参数、输出、错误语义，不改变账号/token 磁盘格式、配置默认值或现有会话生命周期。
- 不将类型重复或转发方法一概视为冗余；只删除没有运行职责的副本，保留 SDK 领域边界、异步生命周期和错误处理所需的适配。

### 独立优化：Pi 运行会话业务入口统一

目标调用链：**所有 daemon 发起的 Pi 运行会话业务操作 → SessionRuntimePort → PiSdkHost → SDK**。该优化在第一阶段完成，不另建一层通用门面。

#### 统一入口的范围

- 会话创建、prompt、中止、等待空闲、新建/切换/恢复、压缩、重载，以及模型/thinking 选择、项目默认值写入、相关列表和状态查询，统一通过 SDK-free 的 `SessionRuntimePort`；生产实现为 `PiSdkHost`。
- 项目、会话、CLI/RPC 等上层不得持有或直接操作 SDK 的 AgentSession、AgentSessionRuntime、SessionManager、ModelRuntime 或 SettingsManager。组合根负责构造和注入，不成为另一套会话业务实现。
- 保留 `PiSdkHost` 作为实际入口。`PiSessionHost` 不是另一个必须接入的业务层：目前仅 prompt 经它转发，其他方法无人调用。删除其闲置转发方法和临时对象层，将有效 prompt/图片转换逻辑保留在 PiSdkHost 或其内部小函数中。
- 已经直接通过 PiSdkHost 执行的 abort/new/compact/reload 等操作无需重新绕进 PiSessionHost。优化只消除内部冗余，不删除这些功能，也不改变懒创建、异常传播和当前 session 选择。

#### 合法的内部适配与诊断入口

- PiSdkHost 可以委托 Pi 边界内部适配。由其安装的 runtime factory、session rebind 和 extension command callbacks 可以直接使用 SDK，不要求每个内部调用再次经过 host 公共方法；不得把 SDK 实例泄漏到业务层。
- 扩展 command callbacks 具有 fork/navigateTree 及完整 options 等 SDK 契约，不能机械替换为参数面不同的现有 host 方法。将扩展全部操作再次转接 host 公共方法不在本次范围内。
- SDK 事件转换、trust/diagnostics、UI 和微信工具的反向 ports 属于边界内部职责；不得为了调用图看似统一而移除它们。
- 版本、环境和模型可用性诊断可以通过独立的 Pi diagnostic 入口执行，不需要创建 PiSdkHost；该入口不得执行 prompt、创建活动 AgentSession、修改项目模型配置或操纵 daemon 会话。
- 诊断入口不等于整个 doctor 命令纯只读：现有 doctor 有目录写入探测；保持原有行为。不扩大为“SDK 初始化没有任何 I/O”的承诺。

#### 当前核查与最小约束补齐

- 2026-10-21 静态核查未发现上层直接导入 SDK 或操纵 SDK session 的实际绕过。真实生产会话路径已经经过 SessionRuntimePort/PiSdkHost，PiSessionHost 是冗余内部转发，不是绕过。
- 当前 Biome 禁止上层直接导入 coding-agent 及 pi-ai 子路径，但遗漏精确根包名 `@earendil-works/pi-ai`。实施时补齐此禁用项，保持规则仅作用于本包 Pi 边界之外；目前根包实际导入位于边界内，不声称存在越界缺陷。
- 现有 import 限制不等于已强制全部内部调用路径。实施时检查业务调用和 SDK 对象泄漏；不为静态约束新建复杂入口框架，也不一刀切禁止组合根导入其所需适配工厂。
- CLI doctor 当前自行读取全局 Pi settings 后调用诊断入口，这是诊断配置读取，不是活动会话绕过；本次不顺手改成项目有效 merged settings 或另一套配置解释。

### 第一阶段：删除闲置代码与兼容分支

1. **完成 Pi 运行会话业务入口优化。** 按上面的独立章节收缩 PiSessionHost、保留有效 prompt/图片转换和 PiSdkHost 单入口，并补齐直接 SDK import 防线。
2. **删除未接线的契约副本。** 移除无消费者的诊断类型/helper 和 UI 能力常量；实际 fatal diagnostics 判断、UI 实现及 SDK 包装回归保持。不得为“用上 helper”反而添加新的转换层。
3. **删除孤立的远程图片下载支线。** 移除未调用的 `downloadRemoteImageToTemp` 及仅服务它的临时文件名、反向 MIME 推断等 helper/import。保留真实入站下载、加解密、出站上传和文件名到 MIME 的映射，不删除共享依赖。
4. **删除 QR 登录只写状态。** 从私有登录记录移除没有读取用途的 sessionKey/id/status/botToken/error 等字段及赋值。公开返回值、验证码、二维码刷新、TTL、重定向和登录状态机不变，不在内存多留无意义的 token 副本。
5. **统一内部命令调用签名。** 命令入口仅保留生产使用的 `(command, args, message)`；旧测试显式传空参数字符串，不再用联合参数解析和两参数重载兼容测试。微信命令语法及选择器行为不变。
6. **清理已确认的小型残留。** 删除无消费者的 `ReconcileResult`、RPC `StatusResult` 类型、会话控制器无调用的 current-turn getter、从未赋值的 AgentRun.messageId；不删除仍承担公开状态职责的 `AccountStatus` 等类型。异常路径已有 messageId 仍保留，不借机新增日志关联行为。CLI 复用项目层的广播结果类型，移除始终为 true 的 passthrough 选项，直接保持当前 stdout/stderr 输出行为。

每项删除都以实际引用证据为前提；若发现动态使用或有效消费者，保留并报告，不为达成删行目标扩大修改。

### 第二阶段：收口同生命周期状态与重复步骤

1. **账号生命周期单一记录。** 将 unsubscribe 回调纳入内部账号记录，删除独立同键订阅 Map。公开账号状态不暴露该回调，也不缩减状态字段/枚举。remove 保留先取消订阅、删除注册记录，再等待 transport.stop 的顺序；重复删除和 stopAll 行为保持。
2. **共享账号启动步骤。** daemon 启动与 reload 共用恢复精确 token、读取账号、检查凭据、创建 transport 和注册的私有步骤。各自保留枚举、已注册账号检查和缺 token 日志策略；不得直接让 start 调用包含账号移除 reconcile 的 reloadAccounts。
3. **共享 monitor 失败退避。** 用文件内局部函数收口失败计数、阈值日志和等待，业务失败/异常分支保留各自的安全分类。不把业务错误统一改成 throw。成功后重置、业务/网络混合累计、三次失败退避、stale-token 专用暂停及等待期间 abort 均保持现有语义。

不为上述三项建立新的账户服务、通用执行管线或重试框架。

### 必须保留的机制

- activeRun、inboundRun、pendingInboundOrigin 各自的回合关联职责；generation、pendingDeliveries、delivery 的旧事件隔离、busy 和串行投递职责。
- 已开始广播继续尝试后续目标；尚未开始的旧投递及过期事件仍被隔离。
- selector 的超时 generation、typing 的 closed/inFlight，以及项目错误锁存和 fail-closed 行为。
- SDK session 重绑、UI own/enumerable 方法绑定、领域事件翻译和 trust 配置/实际状态区别。
- 原始 sender 保留、不新增普通入站过滤、出站绑定账号 userId 与精确 token 关联、UI 回答者与收件人一致。
- API 失败诊断的安全字段规则、AbortError 控制流、已有超时和重试行为。

### 文档与交付

- 每阶段同步删除现状文档中已失效的内部结构说明，不将计划写成已实现。
- Pi 门面收缩涉及 ADR-0004 的结构描述；实施时新增关联旧 ADR 的简短决策记录，说明仅收缩 SDK 边界内部，不修改历史理由。
- 完成各阶段后按仓库要求格式化、类型检查和运行相关测试；修改根 Biome 规则时执行全仓 check/lint 验证作用范围。最终运行完整包离线测试及构建，并检查删除模块没有残留在发布构建中。
- 每次提交聚焦一个可独立验证的清理主题；按仓库 release 规则为影响发布内容的变更提供 changeset，不手动改版本，不自动发布。

## Testing Decisions

用户已确认沿用现有离线测试边界：daemon/project/session 集成、mock 微信 API、Pi adapter/UI 回归。只补保护外部可观察行为所需的用例，不逐模块新建测试体系，不调用真实模型或发送真实微信。

1. **Pi 业务入口、适配与死代码删除：** 验证无图、空图片列表、多图的 prompt 输入和图片映射；拒绝异常正常传播，session 替换后使用新 session。现有 abort/new/compact/reload/模型与 thinking 操作继续经同一 host；保留真实 SDK UI 包装、diagnostics fail-closed 与既有媒体收发测试。通过引用检查、类型检查和 Biome 确认上层不直接导入 SDK、不持有 SDK 实例；补齐 pi-ai 根包限制后验证规则范围不误伤内部适配和组合根。必要新增 adapter 用例仍在现有边界内，不触发模型，不把 SDK 内部回调全部直调 host 作为验收要求。
2. **登录状态：** 通过 mock API 验证 confirmed、已绑定返回、重定向、验证码以及刷新/过期限制；确保删私有字段不改公开返回或流程。不得为测试执行真实扫码。
3. **命令与 CLI：** 现有 compact/status/new/abort 和 selector 回归继续通过；测试显式使用统一命令签名。CLI 输出与退出行为不因移除恒定选项改变。
4. **账号生命周期与 reload：** 在 daemon + fake transport 边界验证注册、移除、stopAll、取消订阅一次、停止失败、reload 新增账号及缺 token 路径；移除一个账号不影响其他账号，原有停止顺序不变。
5. **monitor 退避：** 使用 mock fetch/可控等待验证业务和网络失败交错累计、达到阈值的退避、成功清零、stale-token 清零并暂停以及等待期间 abort；长轮询接收仍不等待 Agent 回合结束。
6. **全局回归：** 继续验证重启后精确 token 恢复、定向/广播用户范围、UI 关联、异步投递和跨项目隔离；删除代码后的引用搜索、类型检查、构建和完整离线测试均通过。

测试报告区分“当前基线通过”和“修改后通过”；审查时的基线结果不能代替实施验证。无调用死代码不再保留只验证自身存在的测试，但不得删除有用行为覆盖以降低行数。

## Out of Scope

- 需求 0010 的默认会话、CLI prompt、MCP、OAuth、历史查询或多 runtime。
- logout 任意 RPC 错误触发本地删除的修复：单独在 issue #23 处理，不作为纯精简混入。
- GET/POST 安全响应处理合并、token 缓存改嵌套 Map：记录为后续候选，本 spec 不授权实施。
- 修改 stale-token “暂停所有请求”的范围或删除未接线的 session-guard API；此处存在文档/实现契约需另行核实，不能借精简选择一种新行为。
- 真实服务配置、认证部署、真实凭据操作、自动发布或其他包重构。
- 无必要的统一框架、纯压行、减少安全校验或牺牲诊断/测试覆盖。
- 将 SDK 内部 extension command callbacks 强制重新接入 PiSdkHost 公共方法，或将环境诊断改造成活动会话业务。

## Further Notes

- 本规格来自 2026-10-21 的只读分区审查；Pi 适配核查基于当时锁定 SDK 1.1.0。实施时若依赖升级，应重新核对涉及的类型和实现，不照搬旧版本结论。
- 用户已确认内部 dist 深层导出不属于承诺 API，以及使用现有离线测试边界；不存在因此阻塞第一、第二阶段的未决产品选择。
- sessionRef 看似复制 runtime.session，但首次 binding 早于 runtime 赋值；尚不能证明可直接替换，保留。AccountManager 公开状态字段也不因 setter 暂无调用而删除。
- 后续候选的收益与风险：GET/POST 响应 helper 可集中安全规则，但要保留业务错误返回时点和不同超时条件；嵌套 token Map 可删除复合键扫描，但必须保持磁盘格式、restore merge 和账号独立清理。另行决定后再实施，不预建抽象。
- 不承诺固定删行数。优先验收无调用路径、冗余状态和测试专用运行分支确实消失，且原有用户可观察行为保持。
