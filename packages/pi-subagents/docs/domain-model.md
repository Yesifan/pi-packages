# 领域模型（Domain Model）

> 定义 `@yesifan/pi-subagents` 中实体、值对象、标识与生命周期的确切含义，作为代码、测试、日志和讨论的术语基准。

---

## 1. 模型总览

```text
Root Session (1)
  │ owns
  ▼
RootRuntime (1)
  │ manages
  ├── LogicalSubagent (*) ── owns ── LogicalSubagent (*)
  │        │
  │        ├── has history ── Child Session File (1)
  │        ├── accepts over time ── LogicalRun (*)
  │        └── mounts while busy ── AgentSession Instance (0..1)
  │                                  │
  │                                  └── performs ── SDK Run (1..*)
  ├── routes ── SubagentReport (*)
  ├── owns ── DelegationContext (one per delegation-capable session instance)
  ├── serializes ── Blocking UI Request (*)
  └── locks ── Root Store Scope (1)
```

最重要的区分是：

```text
LogicalSubagent ≠ AgentSession Instance
LogicalRun      ≠ SDK Run
Steering Input  ≠ LogicalRun
CurrentRole     ≠ DelegationAgentRegistry
```

logical subagent 是可恢复身份；AgentSession instance 是一次加载到内存中的执行载体。一次 logical run 可能因为 child report 触发多个 Pi SDK run，但最终只生成一个 subagent report。

---

## 2. 核心实体

### 2.1 Root Session

用户正在操作的最外层 Pi session，也是整棵 subagent 树的持久化和权限边界。

标识由两部分共同确定：

- `rootSessionId`：Pi SessionManager 的 session ID；
- `rootSessionFile`：该 file-backed session 的规范化文件路径。

两者共同派生 `rootKey`。`rootProjectRoot` 是 root session 初始化时确定的 canonical project root，承载整棵树唯一的权威 store；它不是 root identity，同一项目中的不同 root 仍由不同 `rootKey` 隔离。复制、导入、fork 或新建出来的 root session 不得凭相同内容接管原树。没有 file-backed session 的 root 不能启用可恢复 subagent。

### 2.2 RootRuntime

一个 root session 内唯一的运行时协调者。它不是持久化业务身份，而是当前进程中的 aggregate coordinator，负责：

- logical subagent 与 active mount 索引；
- direct ownership 校验；
- logical run ID、parent run dependency 和报告路由；
- root project 配置的 `max_depth`、`max_live_agents`、cycle 和 root shutdown；
- 固定 `rootProjectRoot` 及其 `<rootKey>` store writer lock；
- 所有后代共享的 UI broker；
- 活动 logical run 最新进度的聚合与 root 原生 widget 生命周期。

RootRuntime 可以看见整棵树以便统一清理，但不能把全树合并成一个 agent registry 或 cwd allowlist。

### 2.3 LogicalSubagent

可跨多次普通 ask 和 root resume 存活的稳定业务实体。标识为 `agentId`，外部格式为 `sa_*`。

其固定身份包含：

| 属性 | 含义 | 后续普通 ask 是否可变 |
|---|---|---|
| `rootSessionId` | 所属 root | 否 |
| `parentAgentId` | 直接 parent；root 为 `null` | 否 |
| `name` | 显示标签，不是权限键 | 否 |
| `cwd` | canonical 工作目录 | 否 |
| `ancestorCwds` | 创建时的 canonical cwd 祖先链 | 否 |
| `agentType` | 创建时选择的角色 ID | 否 |
| `agentDefinitionSnapshot` | 创建时解析的完整角色快照 | 否 |
| `depth` | 在 root 树中的深度 | 否 |
| `model` | 固定的 provider/model identity | 否 |
| `thinking` | 实际生效的 thinking level | 否 |
| `sessionId` / `sessionPath` | child Pi history identity；路径相对于 root scope | 否 |

`lastRunId`、`activeRunId`、`interrupted` 和时间戳属于可变生命周期元数据。

logical subagent 完成一项任务后仍存在，但其 AgentSession instance 会释放；下一次普通 ask 从 root scope 安全解析 `sessionPath` 后恢复历史。

### 2.4 LogicalRun（Delegation）

一次被成功接受的 `subagent` 或普通 `ask_subagent` 请求。标识为 `runId`，外部格式为 `run_*`。为跨越持久化与 Pi preflight 边界，磁盘可短暂存在 `state = "opening"` 的 prepared run record；它尚不是 LogicalRun，恢复时必须清除而不是标记 interrupted。preflight 成功后状态变为 `accepted`，终结后变为 `completed`。

一个 run 固定关联：

- 一个 `agentId`；
- 发起它的 `parentRunId`，root 直接发起时为 `null`；
- 接受、完成、结果、错误和 report delivery 元数据。

依赖必须绑定到 `(agentId, runId)`，不能只绑定 logical subagent。后续 ask 产生的新 run 不得满足旧 parent run 的等待条件。

`isSteer: true` 只是给当前 executing run 增加输入：复用当前 `runId`，不创建 LogicalRun，不增加 accepted run 数，也不产生独立 report。

### 2.5 AgentSession Instance（Mount）

logical subagent 当前加载到内存中的 Pi `AgentSession`。同一 logical subagent 同时最多有一个 mount；无活动 logical run 时通常为 0 个。

mount 负责承载：

- 从 child scope-relative `sessionPath` 恢复的 Pi history；
- target cwd 当前加载的 Pi resources、extensions 和 tools；
- snapshot-backed current role system prompt；
- 当前 mount 独立的 ModelRuntime 与 UI proxy；
- 当前 run 及其等待中的 child/report 状态；
- 当前 run 的模型调用计数和一条最新 thinking/tool 活动摘要。

mount 是临时运行态，不持久化。run 真正完成后必须 dispose；parent 已从 SDK settled 但仍等待 child/report 时必须继续保留。

### 2.6 SDK Run

Pi AgentSession 的一次 processing 链。初始 task prompt 会启动 SDK run；child report 作为 custom message 送回 idle parent 时，可能触发后续 SDK run。

因此：

```text
一个 LogicalRun = 一个初始 SDK Run + 零到多个报告触发的 SDK Run
```

Pi 的 `agent_settled` 只表示当前 SDK processing 已结束；如果还有 `pendingChildRuns` 或 `pendingReportIds`，logical run 尚未完成。

### 2.7 SubagentReport

LogicalRun 的唯一最终结果信封，标识为 `reportId`。它携带 agent/run/parent identity、cwd、outcome、最终文本、可选错误和完成时间。

投递目标只能是直接 parent：

- parent 为 root：通过 root extension custom message 投递；
- parent 为 subagent：投递到与 `parentRunId` 对应的 live parent mount。

report 不能迁移到同一 parent logical subagent 的后续 run。delivery 状态为 `pending → submitted → recorded`；它描述投递过程，不改变 run outcome。

### 2.8 Blocking UI Request

child extension 发起的一次 `confirm`、`select` 或 `input` 请求。它属于一个活动 `agentId`，由 root-scoped UI broker 串行化。

所有后代共享一个 FIFO；任一时刻最多一个 blocking dialog 占用 root UI。owner 被 dispose、tool signal abort、timeout 或 root shutdown 时，请求必须结束并返回该能力的确定 fallback。

---

## 3. 值对象与注册表

### 3.1 DelegationContext

绑定到某个具有 delegation capability 的 session instance，包含：

```text
canonical cwd
projectRoot
AgentTypeRegistry
canonical externalDirectories
```

它回答“这个 caller 现在能创建什么 child”，不是整棵树的全局配置。`externalDirectories` 来自 caller project 的 `.pi/subagents/setting.json`；父 session 不预读 external 项目的下一层配置。`max_depth`、`max_live_agents` 和 `ui_timeout_ms` 则由 root project 固定，不接受 descendant caller-local 覆盖。任何项目配置都必须在该项目通过 trust 后才能读取。

例如：

```text
A config allows B
B config allows C

A.DelegationContext = { cwd: A, external: [B], agents: A agents }
B.DelegationContext = { cwd: B, external: [C], agents: B agents }
```

所以 `A → B → C` 合法，即使 A 不知道 C；A 也不能绕过 B 直接使用 B 的 agent registry。

### 3.2 AgentTypeRegistry

caller 当前可选择的角色定义表，按以下层级构建：

1. package built-ins；
2. Pi global agents；
3. caller 当前 project agents。

同名后层定义完整覆盖前层定义，不做字段级 merge。registry 只用于创建下一层 child；它不重新定义 caller 自己的 current role。

### 3.3 AgentDefinitionSnapshot（CurrentRole）

创建 logical subagent 时从 caller AgentTypeRegistry 复制的不可变角色定义，包括 prompt、tools、thinking、source 和 content hash。

后续恢复关系为：

```text
CurrentRole(child) = stored AgentDefinitionSnapshot
Future child choices = current target-cwd AgentTypeRegistry
```

即使磁盘上出现同名新角色，已有 logical subagent 的 current role 仍不改变。target cwd 当前 tools/resources 可以变化，这是恢复时应重新加载的运行环境，不是角色身份变化。

### 3.4 CanonicalCwd 与 AllowedCwdSet

`CanonicalCwd` 是对存在目录执行 realpath 后的路径。caller 当前允许的集合为：

```text
AllowedCwdSet = { caller.cwd } ∪ caller.externalDirectories
```

tool 的显式 `cwd` 必须已经是绝对路径，canonicalize 后与集合元素精确相等。父目录授权不蕴含子目录授权，字符串前缀也不是授权。

`ancestorCwds` 用来拒绝 canonical cwd 重复，例如 `A → B → A`。

### 3.5 ModelIdentity 与 ThinkingLevel

logical subagent 只持久化 `{ provider, id }`，不持久化 API key 或 mutable model registry。每次 mount 根据 target cwd 当前资源和 agentDir auth 重新构造独立 ModelRuntime，并恢复同一 identity；无法恢复模型或鉴权时，在接受新 run 前失败。

thinking 的创建优先级为：

```text
调用参数 > agent snapshot 默认值 > parent 当前 thinking > off
```

创建后保存实际生效值，普通 ask 不重新继承 parent 设置。

---

## 4. 所有权、能力与基数

| 关系 | 基数 / 规则 |
|---|---|
| Root Session → RootRuntime | 当前加载期间 1:1 |
| Root Session → LogicalSubagent | 1:N，包含所有后代 |
| LogicalSubagent → direct children | 1:N |
| LogicalSubagent → direct parent | 恰好 1；root 用 `null` 表示 |
| LogicalSubagent → LogicalRun | 1:N，按时间顺序发生 |
| LogicalSubagent → live mount | 1:0..1 |
| live mount → active LogicalRun | 1:1 |
| LogicalRun → final report | 正常终结时 1:1；root shutdown 造成的 interrupted run 可只持久化结果；steering 不增加 report |
| parent LogicalRun → child LogicalRun | 1:N，依赖按 run ID 绑定 |

工具实例在创建时绑定 `CallerBinding`，模型不能通过参数指定 `rootSessionId`、`parentAgentId`、depth 或内部能力。`ask_subagent` 只允许访问 `stored.parentAgentId === caller.agentId` 的直接 child。

Delegation capability 还受 cwd 类型约束：

- same-cwd child：始终是叶节点；
- external child：只有角色允许 `subagent`、尚未达到 max depth 且 target session 成功构建自己的 DelegationContext 时才能委派。

---

## 5. 生命周期状态

### 5.1 Logical subagent / mount 状态

```text
Stored Idle
   │ subagent / normal ask
   ▼
Opening ──失败/接受前取消──▶ rollback
   │ Pi preflight accepted + durable run metadata
   ▼
Executing ◀────────────── child report triggers parent processing
   │ SDK settled
   ▼
Waiting for Children/Reports   (mount retained; logical subagent remains busy)
   │ dependencies empty
   ▼
Finalizing / Closing
   │ result persisted + report routed + mount disposed
   ▼
Stored Idle
```

实现中的 `LiveAgent.phase` 使用 `opening | executing | idle | closing`；其中 `idle` 可能表示“SDK 已 settled 但 logical run 仍等待 child”，不等于 logical subagent 可接受普通 ask。

是否 busy 以存在 live delegation/mount 为准，而不是只看 `session.isStreaming`。

### 5.2 LogicalRun outcome

| outcome | 含义 |
|---|---|
| `completed` | 最终 assistant 文本正常完成 |
| `incomplete` | 达到长度限制或没有完整文本结果 |
| `failed` | 模型、runtime、报告处理等失败 |
| `aborted` | Pi run 明确以 aborted 结束 |
| `interrupted` | root shutdown/crash 前未完成；恢复时只标记，不重放 |

### 5.3 普通 ask 与 steering

普通 ask：

```text
Stored Idle → new runId → new mount → one LogicalRun
Busy        → SUBAGENT_BUSY（立即失败，不排队）
```

steering：

```text
Executing + session.isStreaming → reuse current runId → status=steered
其他状态                         → SUBAGENT_NOT_STEERABLE
```

steering input 不改变 logical identity、snapshot、cwd、model、thinking 或 parent dependency。

---

## 6. 持久化模型

项目通过 trust 后按需初始化本地目录。每个 root scope 使用单 writer lock，并包含：

```text
<rootProjectRoot>/.pi/subagents/
  setting.json
  .gitignore
  sessions/<rootKey>/
    root.json
    agents/<agentId>/
      agent.json
      runs/<runId>.json
      sessions/<pi-session-file>.jsonl
```

root project 是整棵 delegation tree 的唯一事实来源。对于 `A → B → C`，B、C 不保存 branch、ledger、mirror 或 child history。`sessions/` 必须被 Git ignore 且不得已 tracked，局部 `.gitignore` 的 `/sessions/` 必须是最后一条有效规则；初始化或写入遇到权限、unsafe symlink、path escape、Git 暴露或 lock 冲突时 fail closed，不回退到 agentDir。

| 数据 | 持久化 | 恢复策略 |
|---|---|---|
| logical identity / ownership | 是 | 原样恢复 |
| role snapshot/hash | 是 | 原样恢复，不重解析替换 |
| child Pi history | 是，SessionManager JSONL | 验证 scope-relative path 后打开 |
| run result/outcome/delivery | 是 | 用于审计和恢复状态 |
| active mount / SDK object | 否 | 普通 ask 时重新创建 |
| run-local progress / root widget | 否 | 新 run 从零开始；只展示当前活动状态 |
| DelegationContext | 否 | 根据 target cwd 当前配置重建 |
| tools/extensions/ModelRuntime/UI proxy | 否 | 每个 mount 重新加载/绑定 |
| 未完成 tool 副作用 | 否 | 不自动重放 |

metadata 使用 `0600` 与原子 rename，生成目录在 POSIX 上使用 `0700`。已初始化 scope 在运行中消失后不得递归重建。`root.json` 必须与当前 root identity 一致。恢复发现 `activeRunId` 时，将对应 run 标记为 `interrupted` 并清除 active identity；用户可以再次普通 ask，但旧 run 不会继续执行。旧 agentDir store 不迁移也不作为 fallback。

---

## 7. 关键流程

### 7.1 创建 child

```text
caller tool
  → root/caller project trust 后初始化或验证 `.pi/subagents`
  → 从 caller AgentTypeRegistry 解析角色 snapshot
  → 按 caller AllowedCwdSet 校验 canonical target cwd
  → 校验 depth/live/cycle/trust
  → 在 root project scope 创建 logical identity 与私有 child SessionManager
  → 从 target cwd 加载当前 Pi resources
  → 创建独立 ModelRuntime、工具集、UI proxy 和 AgentSession
  → Pi preflight 接受 prompt
  → 持久化 run active metadata
  → 返回 { id, run_id, status: "started" }
```

接受前失败必须 rollback；接受后的最终成功或失败通过 report 返回。

### 7.2 普通 ask

```text
direct owner
  → 验证 logical subagent 存在且无 live mount
  → 用 caller 当前 AllowedCwdSet 重新验证 stored cwd
  → 验证 relative/containment/symlink/session identity 后打开原 child SessionManager/history
  → current role 使用 stored snapshot
  → target resources/tools/delegation config 使用当前状态
  → 创建新 runId 并执行
```

### 7.3 Child report

```text
child SDK settled
  → 等待 child 自己的 descendants/reports 清空
  → 提取本 logical run 最终 assistant 输出
  → 保存 run outcome + report envelope
  → dispose child mount
  → 向直接 parent 的绑定 run 投递 custom message
  → parent 处理报告并在所有依赖清空后 finalize
```

### 7.4 Root shutdown / resume

shutdown 使 runtime epoch 失效，取消 UI、abort 和 dispose 全部 live mounts，把未完成 run 标记为 interrupted，最后释放 root writer lock。

同一 file-backed root 从同一 project-local scope resume 后恢复 logical identities 和 histories，但不恢复旧 SDK objects，不自动重放 interrupted prompts 或工具调用。项目移动不自动重定位 canonical cwd，也不搜索 agentDir 或其他项目作为 fallback。

---

## 8. 关键不变量

1. **Root isolation**：不同 root scope 不共享 logical identity、writer ownership 或 ask 权限。
2. **Single authoritative project store**：整棵 tree 只存在于 root project scope，external descendants 不保存副本。
3. **Trust before storage**：读取 project-local config、agents 或写入 store 之前必须完成对应 project trust。
4. **Relative session containment**：child session path 必须相对 root scope 且绑定自己的 agent sessions 目录。
5. **Direct ownership**：caller 只能 ask 自己的直接 child。
6. **Session-local delegation**：每个 caller 只暴露自己的 agents 与 cwd allowlist。
7. **Snapshot identity**：已有 logical subagent 的 current role 永远来自创建时 snapshot。
8. **Current resources**：每次 mount 使用 target cwd 当前 Pi resources/tools；不复用旧 mutable registry。
9. **Exact cwd admission**：canonical 精确匹配，不继承子目录或前缀。
10. **Acyclic cwd chain**：external delegation 不得重复 canonical ancestor cwd。
11. **Single active run**：同一 logical subagent 同时最多一个 logical run；普通 busy ask 不排队。
12. **Steering is not delegation**：steering 复用 run 和 Pi queue，不产生新 run/report。
13. **Run-bound dependencies**：child completion 只能解除创建它的 parent run dependency。
14. **One final report**：每个 accepted logical run 最终至多生成一个业务 report envelope。
15. **No early release**：等待 child/report 的 parent mount 不得释放。
16. **No replay**：interrupted work 和工具副作用不得自动重放。
17. **Fresh mutable runtime**：ModelRuntime、tools、extensions、DelegationContext 和 UI proxy 按 mount 隔离。
18. **Acceptance boundary**：接受前取消/失败要 rollback；接受后工具返回成功对象，最终执行错误走 report。

---

## 9. 代码术语对照

| 领域术语 | 主要代码类型 / 字段 |
|---|---|
| RootRuntime | `RootRuntime` |
| Project-local Root Store Scope | `SubagentsConfig.storageDirectory`, `PersistentSubagentStore.rootKey/rootDirectory` |
| Root project identity | `SubagentsConfig.projectRoot` |
| Child history path | `StoredSubagent.sessionPath` |
| LogicalSubagent | `StoredSubagent` |
| LogicalRun | `StoredRun` |
| live mount | `LiveAgent` + `OpenedChild` |
| run-local progress | `LiveAgent.progress` |
| AgentSession Instance | `OpenedChild.session` |
| CurrentRole snapshot | `StoredSubagent.agentDefinitionSnapshot` |
| AgentTypeRegistry | `AgentTypeRegistry` |
| DelegationContext | `DelegationContext` |
| direct owner binding | `CallerBinding.agentId` |
| parent run dependency | `StoredRun.parentRunId`, `LiveAgent.pendingChildRuns` |
| pending report processing | `LiveAgent.pendingReportIds` |
| SubagentReport | `SubagentReport` |
| UI queue owner | `QueueItem.ownerId` |
| root lifecycle invalidation | `RootRuntime.epoch` |

当“agent”“run”“session”等简称可能产生歧义时，代码评审和文档应优先使用本表中的完整术语。
