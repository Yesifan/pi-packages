# ADR-0004：分层与依赖方向（PiSdkHost / SessionController / ProjectController）

- 状态：✅ 已接受（Accepted，`0.6.0`）
- 目标版本：0.6.0
- 日期：见 git 提交时间
- 关联：`docs/requirements/0002-pi-host-compatibility.md`（v3）、ADR-0001/0002/0003

## 背景

当前把 Pi host 职责散落在业务层：`ProjectRuntime` 同时管微信消息、project 生命周期、idle、
participant、调 `PiRuntime`；`PiRuntime` 里又混着 SettingsManager / ResourceLoader / trust /
SessionManager / createAgentSessionRuntime / bindExtensions / 部分 UI。此外 SDK 类型已经漏到
业务层（`src/bridge/response.ts` import `AgentSessionEvent`、`src/bridge/router.ts` import
`ImageContent`）。结果：Pi SDK 的初始化/重载/session replacement 与业务状态机互相缠绕，多类
bug（fail-open、idle 假关闭、状态漂移、command 被吞）都因此而来。

本 ADR 确定「分层 + 依赖方向」，作为本次重构的骨架；行为策略见 ADR-0003。

## 决策

### 分层与依赖方向

```text
Weixin Transport
      │（旁路能力，经 port 反向注入）
      ▼
ProjectController ──▶ SessionController ──▶ PiSdkHost ──▶ @earendil-works/pi-coding-agent

PiSdkHost ──▶ InteractionPort   ◀── WeixinInteractionController
Pi tool    ──▶ FileSenderPort   ◀── WeixinFileSender
```

**只有 `src/pi/` import Pi SDK（含类型）。** 上层只见领域类型。

最终目录（本项目规模，不上完整 hexagonal）：

```text
src/
├── daemon/daemon.ts            # 组合根 + UDS RPC
├── projects/                   # 「哪个项目拥有哪个 session」
│   ├── project-manager.ts      # desired → diff → restart
│   ├── project-controller.ts   # 组合 SessionController + CommandRouter + ParticipantRegistry
│   ├── project-config.ts       # immutable snapshot（desired/effective）
│   ├── participant-registry.ts # 历史 participant ∩ 当前授权账号
│   └── command-router.ts       # 只分类，不执行 Pi 操作
├── sessions/                   # 「我们怎样使用一个 Pi session」
│   ├── session-controller.ts   # 单一状态机 + turn 串行化
│   └── session-state.ts
├── pi/                         # 「怎样正确地嵌入 Pi SDK」（唯一 import SDK 处）
│   ├── sdk-host.ts             # PiSdkHost：对外唯一门面
│   ├── runtime-factory.ts      # createRuntime 回调 + 首次构建 + diagnostics 硬约束
│   ├── session-host.ts         # 已构建 AgentSessionRuntime 的操作门面
│   ├── extension-host.ts       # bindExtensions 唯一收口（含 commandContextActions/onError）
│   ├── diagnostics.ts          # 诊断收集 + hasFatalDiagnostics
│   ├── project-trust.ts        # ProjectTrustResolver（SDK adapter）
│   ├── ui-context.ts           # ExtensionUIContext 适配器（依赖 InteractionPort）
│   ├── ui-capabilities.ts      # capability matrix（unsupported 显式声明）
│   ├── events.ts               # SDK 事件 → 领域事件翻译
│   ├── ports.ts                # InteractionPort / FileSenderPort 接口
│   └── extensions/weixin-send-file.ts  # Pi tool adapter（依赖 FileSenderPort）
├── weixin/                     # 「怎样通过微信与用户交互」（不 import Pi SDK）
│   ├── transport.ts / monitor/ / messaging/ / media/ / auth/
│   ├── interaction-controller.ts  # InteractionPort 实现（等下一条消息）
│   └── file-sender.ts             # FileSenderPort 实现
└── config/ accounts/ util/
```

> `weixin_send_file` 维持**无路径边界**（见 ADR-0003 D-G），因此**不存在** `security/path-policy`；
> 路径校验退化为 `exists + isFile + sanitizeFilename`，直接内联在 Pi tool adapter。

### Invariant 1：只有 `src/pi/` import Pi SDK（含类型）

- 禁止 `src/pi/` 之外 import `@earendil-works/pi-coding-agent` 与
  `@earendil-works/pi-ai/compat`（`ImageContent` 也须隔离）。
- 用 eslint `no-restricted-imports` **强制**，不是约定。
- `pi/` 对外只暴露领域类型：`PiHostEvent`（`text_delta/agent_settled/tool_*/ui_*/extension_error/…`）、
  `HostPromptInput`（text + images 领域形状）、`HostStatus`、`SessionSwitchResult`、
  `Diagnostic`（自有的，非 SDK 类型）。

### Invariant 2：session 生命周期由 `SessionController` 单一状态机表达

- 状态：`inactive | ready | busy | replacing | faulted`（含 `lastActivityAt`）。
- 操作只允许在合法状态：`prompt` 要求 `ready`；idle：`ready →(超时)→ inactive`（真 dispose）；
  下一条普通消息：`inactive →(newSession 成功)→ ready → prompt`；失败 → `faulted`（**绝不
  prompt**）。
- **不存在第二份 busy/turn 信号**：原 `Bridge` 的 `turnPromise`/`state`/UI waiter/响应累加
  全部拆入 `SessionController`（turn 串行化 + 状态机）、`WeixinInteractionController`
  （UI waiter）、`sessions/` 的 accumulator（消费领域事件）。`src/bridge/` 层消失。

### Invariant 3：project 运行时只持有 immutable snapshot；sync = diff → restart

- `ProjectController` 生命周期内只读构造期传入的 `ProjectRuntimeConfig` snapshot（`cwd` 用
  realpath 归一化、`accounts` 快照）。
- `ProjectManager.sync()`：desired → diff → `none | restart`。本期**无 hot-update**（cwd 固定、
  accounts 变更即 restart），不为未来 web/scheduler 预先造分支。
- `listStatuses()` 报 effective（与 desired 恒等），不出现「cfg 与 runtime 漂移」。

### 构建/运行拆分：PiRuntimeFactory 是回调，不是一次性 builder

- SDK 的 `createAgentSessionRuntime(createRuntime, opts)` 会**存下** `createRuntime`，后续
  `/new`/`fork`/`switchSession`/`import` 每次 session 替换都重跑它（0.84.4 bundle 已核实）。
- 故：`PiRuntimeFactory` = 该 createRuntime 回调 + 首次构建，必须**幂等可重入**；
  `PiSessionHost` = `AgentSessionRuntime` 之上的操作门面。
- **`bindExtensions`（PiExtensionHost）挂在 `setRebindSession` 的 rebind 路径**，每次 session
  替换都重绑；不如此，`/new` 之后 extension 会落回 SDK 的 no-op fallback（复现本次 bug）。

## 理由

1. **版本升级只改一处**：SDK 初始化流程变化（0.85/0.9x）只落在 `src/pi/`；类型翻译层同时挡住
   了 `AgentSessionEvent`/`ImageContent` 的隐性泄漏。
2. **把 bug 变成"写不出来"**：单一状态机消掉 `busy/sessionExpired/runtime?` 的非法组合；immutable
   snapshot + restart 消掉漂移；diagnostics 硬约束消掉 fail-open（见 ADR-0003 D-A）。
3. **比例匹配**：不引入 Actor/mailbox、不搞完整 hexagonal；一个 project 同时最多一个 active turn、
   busy 直接拒绝，lifecycle mutex + 状态机足够。

## 后果 / 取舍

- 引入一层事件/类型翻译（SDK event → 领域 event）——有一次性成本，但换来边界可被 lint 强制。
- `src/bridge/`、`src/agent/` 两个目录消失，`turn-context`（回源标记）→ `sessions/`，
  account→transport 路由 → `projects/`；迁移期间旧文件需逐阶段删除，不能两套并存。
- `weixin_send_file` 无边界（ADR-0003 D-G）：可发 cwd 外文件，安全模型 = agent 进程权限，
  README 明示。
- 迁移分五阶段、每阶段保持可运行 + 既有测试全绿（见 requirements/0002 v3）。

## 相关实现（迁移路线）

见 `docs/requirements/0002-pi-host-compatibility.md` v3「五阶段」。
