# Spec 0002：Subagent 提示优化与按父会话存储

---

status: completed
execution_time: "2026-10-08 / 2026-10-09"
commit: null
version: null
related_documents:
  - "[权威规格](yesifan-pi-subagents-spec.md)"
  - "[领域模型](../domain-model.md)"
  - "[ADR-0003](../adr/0003-sdk-sessions-and-parent-metadata.md)"
  - "[后续 Spec 0003](0003-terminal-exit-reporting.md)"

---

- 实施状态：completed，完成日期 2026-10-09。用户明确要求“先标记为完成，然后提交 PR”，接受在实际交互 TUI/print 手动验收前关闭本规格；手测未运行，延期跟进，不宣称 §14 全部验收通过。
- 未合并 PR 内修订：PR #11 尚未合并，按用户要求将新 history 的私有目录与普通 discovery 边界直接整合进本规格和 ADR-0003，不另立后续规格/ADR，也不把 PR 内目录试选写成已发布历史决定。原完成日期与手测延期决定保留；最新验证见 §15。
- 影响包：`@yesifan/pi-subagents`。
- 需求来源：[Notion 需求](https://app.notion.com/p/alan66/pi-subagents-prompt-optimize-3eb0f77a346d8016ab08d23fc00fd084)及后续讨论。
- 当前术语与权威索引：[领域模型](../domain-model.md)、[实现规格](yesifan-pi-subagents-spec.md)；其中 V1 大节仅为历史资料。
- 存储决策：[ADR-0003](../adr/0003-sdk-sessions-and-parent-metadata.md) 替代 [ADR-0001](../adr/0001-project-local-subagent-storage.md) 的相关存储决定，保留旧理由。
- SDK 基线：最新 `origin/main`（`0fabea0`）catalog / lockfile 的 Pi `1.0.0`。本次 SDK 核对使用同版本发布产物；实施时安装产物须与 lockfile 一致。

本文是当前重写的权威行为与验收规格。工作区已实现 description/role/history 路径展示、name 工具接口、SDK 原生私有目录 history、按直接 parent 最小 metadata 和 Execution/RootScope 对象生命周期；旧 ID 工具接口、独立 run/mount/report identity、project-local store 与补投恢复契约不再是当前行为。最新目录修订已通过 typecheck、21 个文件 / 245 项测试、build 与 pack；此前 runtime 独立最终复审确认 5 项问题已解决、未发现新的具体缺陷，不将该旧复审冒充最新目录修订已复审。实际交互 TUI/print 手动验收仍未运行，不据此宣称 §14 全部通过。“必须”“不得”为验收要求，“建议”为可选选择，不由批准/代码存在自动推导验收通过。D1–D6 均已确认；冲突处以本文和 ADR-0003 为准。

[Spec 0003](0003-terminal-exit-reporting.md) 是仍未开始的异常退出通知扩展；其现场证据和测试/日志计划原样保留，本文不宣称该扩展已实施。

优先采用简单的 SDK 行为和有用诊断日志。不为手动打开、discovery 或额外 crash-window 政策增加 owned-child guard、全局索引或状态框架；未批准的边缘策略延后，遇到 SDK 无法支持的核心契约时提供证据再讨论。

## 1. 目标与范围

### 1.1 已确认的目标

1. 从 `subagent` tool description 删除指定两句，不删除 steering 功能。
2. 模型可见的直接 children 状态列表携带 role。
3. 自动 report 直接附完整 JSONL 实际路径，不增加 `Full session` 标题。
4. 模型通过 name 创建、查看和 ask，不通过 ID 操作 agent。
5. 新 child JSONL 通过 SDK 显式创建于 `<getAgentDir()>/subagents/histories`，不在普通 discovery/picker/continue 扫描根内；独立打开与显式目录 discovery 仍允许。存量默认目录 history 不搬迁、迁移或删除，按已有实际路径恢复。
6. `<getAgentDir()>/subagents/` 内每个父 session 一个 JSON，只保存直接 children；孙子保存于其直接父 session 的 JSON。
7. 元数据仅保留恢复需要、Pi 历史没有完整表达的信息；不重复保存 cwd、model、thinking、消息或结果。
8. 不生成 `sa_*`、run ID、mount ID、report ID 或 root epoch；Pi session ID 只用于内部定位。
9. 用内存 Execution / RootScope 对象身份保护执行归属、迟到 callback 和报告路由。
10. 不保存历史 runRecord、结果副本或 delivery 状态，不承诺重启后补投报告。
11. 整树仍由一个 root runtime 和一个整树 writer lock 管理；同文件写入串行并原子替换，不新增跨文件事务。
12. 重启只恢复新实现的身份、从属关系和历史，未完成已接受任务标 interrupted；不自动续跑。
13. 不兼容或迁移旧实现；接受旧 agent 在新实现中不可恢复、无法继续 ask。旧文件不自动删除。

### 1.2 保持不变

- 公开工具仍只有 `subagent` / `ask_subagent`，任务均后台运行。
- caller 只能 ask 自己的直接 children，猜测 name 不授予跨 parent 权限。
- 创建角色来自 caller registry；恢复角色使用完整创建时 snapshot。
- 首次创建继承 parent model/thinking 的现有优先级；ask 不采用 parent 后来更换的 model/thinking 覆盖 child 历史。
- target resources、tools、配置和 delegation registry 按目标 cwd 当前状态重建。
- 项目 trust、cwd 精确授权、same-cwd 叶节点、external child 的角色/depth 限制和 canonical cwd cycle 检查不变。
- root-only limits、busy 立即拒绝、steering 复用当前执行、等待后代保留 mount、在线唯一最终报告、UI FIFO、进度 widget 和 shutdown 不变。
- 非持久 root 不支持可恢复 subagent。

### 1.3 非目标

不新增查询/读取/取消/迁移 LLM tool、全局配置层、权威全局关系表、数据库、事件溯源框架、冷父节点调度、自动重放、持久化报告 inbox、exactly-once 投递或多文件事务。不复制 parent 对话给 child，不把 JSONL 正文展开进 report，不顺带清理旧用户数据。

## 2. Name 工具接口与模型展示

### 2.1 工具参数

`subagent` 参数保持：

```ts
interface SubagentParams {
  name: string;
  prompt: string;
  agent_type?: string;
  thinking?: SubagentThinkingLevel;
  cwd?: string;
}

interface AskSubagentParams {
  name: string;
  prompt: string;
  isSteer?: boolean;
}
```

`ask_subagent.id` 删除，改为必填 `name`；不接受旧 id 参数，不实现 alias、旧 store fallback 或迁移。历史消息中的旧 ID 不授予新实现的 ask 权限。

```json
{ "name": "reviewer", "prompt": "继续检查测试", "isSteer": false }
```

### 2.2 Name 约束

- 创建与 ask 均去掉 name 首尾空白，结果必须非空。
- name 按大小写敏感的完整字符串匹配，不做前缀、模糊或全树搜索。
- 同一 parent 的直接 children 中 name 唯一；不同 parent 可以重名。
- name 创建后不变，已完成或 interrupted child 仍占用 name。
- 同名创建返回明确重复名称错误，提示使用 ask；不得自动改名、自动复用或覆盖历史。
- 并发同名创建在首次异步等待前完成 name reservation，仅一个请求可继续。
- name 不参与文件路径生成。用户可读状态标签仍按现有规则单行化/截断，但结构化 name 保留可直接 ask 的完整值，不能把截断标签当作新名字。
- JavaScript 对象索引须使用安全 own-key 访问；如 `__proto__` 等名称不应改变 registry/schema。可以用 Map 内存索引和安全 JSON 序列化，不因此引入额外命名框架。

### 2.3 模型可见结果

成功结果提供 name、角色、cwd、实际 thinking、started/steered 和 delegation status；移除公开 `id` / `run_id`。状态项使用 name / agentType / state，不暴露 session ID。

错误通过 name 定位，不在内容或 details 中附内部 agent/run identity。若报告 details 需要内部 identity，应由宿主侧内部 bookkeeping 持有，不把它作为模型工具结果契约。

模型可见列表：

```text
- reviewer (role: explore): done
```

- 所有成功、busy、limit、steering 和 report 状态列表携带创建时 snapshot 的角色 ID。
- 列表只展示直接 children，计数等于对应列表长度，running 包含 opening/executing/waiting/closing。
- 在 name、role 已解析且合法创建占位建立后，opening 即可按 name 展示，不必等待 Pi session ID。
- shared live usage 包含尚未形成可见 child 的初始化名额；若此时列表少于 shared usage，文案说明用量包含初始化。
- accepted result 可继续提供实际 cwd/thinking，这是运行结果，不表示 metadata 重复保存。

### 2.4 Tool description

仅删除以下两句：

```text
Create a new subagent only for independent context or parallel work.
Set isSteer to true to steer an actively executing run.
```

保留 `For related follow-up work, prefer ask_subagent to reuse a directly owned idle subagent.`，以及异步、并行、任务边界、shared limit、不轮询、等待报告等提示。

`ask_subagent` 的 name 参数说明和相关 steering 示例同步更新。其 description、`isSteer` 说明及结果的 steering 提示不因本需求删除。

### 2.5 报告中的完整会话路径

报告来源信息后、结果正文前直接增加一行，无独立标题：

```text
Complete conversation: `/absolute/path/to/session.jsonl`. Read it if more context is needed.
```

报告展示 name/role/outcome，可保留 cwd；不展示独立 agentId/runId/reportId。runtime 提供已验证的实际路径，不让模型猜路径。JSONL 文件名可能包含 Pi session ID，这属于保留完整读取路径的固有结果，不承诺隐藏文件名中的 ID 字符串。

root、嵌套 parent 的正常/失败报告使用相同规则。历史不可用时明确说明，不伪造可读路径。不复制文件正文、不新增读取工具。

“完整会话”表示已持久化 JSONL，不代表完整 system prompt/tool definitions 快照；分支和 compaction 也可能使文件内容不同于当前模型 request。报告内容是 worker 结果，不是更高优先级指令。

## 3. 内部身份与 owner 文件定位

Pi session ID 是历史身份，不生成第二套业务 ID。内部使用 SessionIdentity 定位：

```ts
interface SessionIdentity {
  sessionId: string;
  sessionFile: string; // 规范化绝对路径
}
```

```text
sessionKey = SHA256(sessionId + "\0" + normalizedAbsoluteSessionFile)[0:32]
rootKey = sessionKey(root)
```

sessionKey/rootKey 仅用于文件和锁定位，不展示给模型，不作为 ask 参数。规范化策略在创建、恢复、锁和写入口一致；保留 ID+file identity 以避免相同 ID 的复制文件接管原 children。会话文件移动不自动重定位。

Pi session ID、文件身份在持久化内部保留，不与“移除 run/mount/epoch”混淆。当前 tree 内重复 Pi ID、循环或不匹配归属拒绝恢复，不能覆盖另一节点。

## 4. 按父 session 保存最小元数据

### 4.1 布局

```text
<getAgentDir()>/subagents/
  sessions/
    <A-sessionKey>.json             # A 的直接 children：B、C
    <B-sessionKey>.json             # B 的直接 children：D
  locks/
    <A-rootKey>/                    # A 整棵树的 writer lock target
  histories/
    <Pi 实际会话文件>.jsonl          # 新 child，普通 discovery 扫描根之外
```

对于 A→B→D、A→C：A 保存 B/C，B 保存 D；B 自身的 child 元数据只在 A 文件。叶节点无需空 owner 文件。B 首次创建 D 时就可创建自己的 owner JSON，不等待 B 完成任务。

全部 metadata 在全局目录，不在 external projects 保存镜像，不另外维护一份权威 relations.json。新 child history 使用 D4 批准的 SDK 显式 privateDir，不追加 cwd 分组、不传 CLI/env/settings sessionDir override。存量新 schema 记录中的实际 history 路径原样保留，default-directory history 仍可恢复；这不改变 D1 对更早 legacy stores 的排除。

### 4.2 Schema

```ts
type ChildState = "opening" | "running" | "idle" | "interrupted";

interface ParentSessionRecord {
  schemaVersion: 1;
  root: SessionIdentity;
  owner: SessionIdentity;
  parent: SessionIdentity | null; // root owner 为 null
  children: Record<string, ChildRecord>; // key 为未截断、已 trim 的 name
}

interface ChildRecord {
  sessionId: string;
  sessionFile: string;
  roleSnapshot: AgentDefinitionSnapshot;
  state: ChildState;
  // 当前实现记录曾初始化 owner 文件，用于分支缺失诊断。
  hasChildren?: true;
}
```

仅 roleSnapshot 表达 Pi 普通历史未完整保存的角色身份，包括 prompt、description、tools/disallowedTools、source/hash 和角色默认 thinking 等现有定义字段。角色默认值属于完整 snapshot，不是另存一份当前有效 thinking。

不保存 child cwd、当前 model/thinking、ancestor chain、depth、历史 runs、结果副本、delivery、report identity、created/updated 时间戳、SDK 对象、credentials 或 delegation registry。name 是 parent 文件的 key；parent/root 放在 header，不在各 child 重复保存。

### 4.3 最新状态的含义

- opening：已准备身份，但本包 task 尚未接受。
- running：task 已接受，包含执行/等待/终结清理阶段。
- idle：本次执行终结且可再次 ask；不表示上次一定成功，结果/outcome 由历史或在线报告表达。
- interrupted：root 结束或恢复发现 accepted task 未完成。

state 只表达可恢复的最新事实，不包含持久化依赖或调度器。恢复遗留 opening 不制造 phantom accepted task；如何清理新 child 与普通 ask 的 prepared 状态，见 §7.3。

## 5. Pi 历史承担的恢复信息

### 5.1 已核实的 1.0.0 目录行为

- CLI 优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > 启动 cwd 合并 settings 的 sessionDir > 内建 cwd 分组目录；project settings 覆盖 global。
- SDK factory 未传 SessionManager 时，直接使用 `SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))`，不自动应用上述 CLI/env/setting 覆盖。
- getDefaultSessionDir 不读取 sessionDir setting/env；显式传入 SessionManager 的目录是最终目录，不再追加 cwd 分组。

**D4 已批准：** 新 child 使用 public `SessionManager.create(cwd, privateDir)`，privateDir 为 `<getAgentDir()>/subagents/histories`，位于普通 `<agentDir>/sessions` 扫描根之外。显式目录不追加 cwd 分组，目标 cwd 仍存于 SDK header；SDK 管理原生 JSONL 文件名、entries 和恢复上下文。不读取或传播 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、global/project settings 的 `sessionDir`，也不继承 root CLI override。`PI_CODING_AGENT_DIR` 仍决定 SDK agentDir；其余目标 cwd 的 settings/resources 正常加载。

root 与已有 child 文件不搬迁、迁移或删除，记录中实际路径不重写；不硬编码 `~/.pi/agent` 或手写 cwd 编码。§5.2 的私有文件适配使用 SDK 在显式 privateDir 分配的实际路径，不重实现 CLI 优先级。

### 5.2 ID、header 和权限

SDK 自动生成 ID 时从新建 manager 获取；NewSessionOptions.id 也支持显式 ID，本方案不要求自行生成。

create 会立即分配 ID、内存 header 和预定路径，但 setup entries 不触发新文件落盘；首个 user 或 assistant message 才创建文件。

本包保存可恢复 child identity 前建立有效 header，POSIX JSONL mode 为 0600。当前采用排他预创建 0600 空文件再 `SessionManager.open(file, directory, cwd)` 的适配，由 SDK 写有效 header 并保留权限；不调用私有 flush，也不把权限保证归给 SDK 默认 create。

检查实际 privateDir 及其 ancestor chain 为普通非 symlink 目录；SDK 创建后仅将本次新建目录设为 0700，既有目录权限不改。不扫描无关普通 sessions/cwd groups，其 symlink 不应阻止 private history 创建。不安全、非目录或不可写的实际路径 fail closed；这些校验不是 sandbox 或全部 TOCTOU 防护。

### 5.3 History 恢复

- 通过已存实际 sessionFile 打开，不用 recent discovery、ID 前缀或默认目录扫描猜历史。
- 打开前验证普通非空文件和不受支持的 symlink；打开后核对 Pi ID 与记录一致。
- canonical cwd 从 session header 获取，验证目录存在、header cwd 对应身份、caller 当前授权和 trust。元数据不再复制 cwd。
- depth/ancestor chain 从当前树各节点历史 cwd 推导；canonical cycle、same-cwd 和 external 分类照常校验。
- 首次创建仍显式使用 parent model 和 thinking 优先级；SDK 将模型/thinking 的变化写入自己的 history。
- ask 使用 SessionManager 的恢复上下文和 SDK 正常模型/thinking恢复机制，不再传 metadata 或 parent 当前值覆盖历史。
- 角色 snapshot 仍追加到当前 target system prompt construction，不插入新的角色 conversation message；当前 resources/tools/delegation config 重新建立。

**实施验证门槛：**用 Pi 1.0.0 真正验证 model/thinking 已有 history entries 和 factory 的恢复行为，包括 parent 后来换模型、首次回复前取消、模型不可用/认证失败，以及旧 history 缺少有效值。不允许 SDK 默认 fallback 后仍声称恢复了固定模型。缺少有效恢复值时应给明确诊断；若需要改变产品 fallback 策略，应先确认，而不是重新加一份 metadata 绕过问题。

普通资源加载发生在 target trust 后；读取会话 header 不等于信任或执行该项目资源。

### 5.4 普通发现、显式访问与存量路径

默认 `list(cwd)` 扫描普通 cwd group，默认 `listAll()` 只扫描普通 sessions 根的直接子目录及其中 JSONL，默认 `continueRecent(cwd)` 从其选定目录找历史。因此新 privateDir histories 不成为普通 discovery/picker/continue 候选，包括 header-only 文件；不新增过滤 hook、owned-child guard、marker/index 或 mtime 隐藏。

允许 `list(cwd, privateDir)`、`listAll(privateDir)`、`continueRecent(cwd, privateDir)` 等显式目录查询，以及 `--session /explicit/file.jsonl` / public open 后独立 resume、继续聊天。用户显式把 CLI/env/settings sessionDir 指向 privateDir 时也能发现；本包新建 child 不继承这些 overrides。不承诺隐藏于所有第三方 discovery，也不提供访问隔离。

已有新 schema metadata 引用的 default-directory histories 保持实际路径/内容/权限，不迁移、搬迁、删除、marker backfill 或重写 identity；恢复仍按已存 ID+file 验证后 exact-path 打开，它们可能继续被普通 discovery 列出。新旧位置可共存；D1 对旧 project-local/legacy store 不加载的边界不变。

## 6. 无 run/mount/epoch 的内存执行模型

### 6.1 对象结构

以下是解释性内部类型，可合并实现，不引入状态机框架：

```ts
interface RootScope {
  closing: boolean;
  children: Map<string, Agent>; // root 的直接 name 索引
  agents: Set<Agent>; // 整树内存实体；各 Agent 自有 children name 索引
  deliveries: Set<ReportDelivery>; // nested 持有至处理确认；root 持有至宿主提交成功；scope 关闭则释放
}

interface Agent {
  name: string;
  identity?: SessionIdentity; // opening 占位可尚未分配 Pi identity
  roleSnapshot: AgentDefinitionSnapshot;
  parent: Agent | null; // null 表示 root；Execution 捕获具体发起方
  children: Map<string, Agent>;
  currentExecution?: Execution;
}

interface Execution {
  scope: RootScope;
  agent: Agent;
  parent: Execution | RootScope; // 创建/ask 时捕获，不事后重新查询
  session?: AgentSession;
  phase: "opening" | "executing" | "waiting" | "closing" | "closed";
  pendingChildren: Set<Execution>;
  pendingReports: Set<ReportDelivery>;
  finalizing: boolean;
  reportSubmitted: boolean;
}

interface ReportDelivery {
  source: Execution;
  target: Execution | RootScope;
  submitted: boolean;
  processed: boolean; // nested SDK barrier 确认；root 不据此证明模型已处理
}
```

Execution、ReportDelivery 都是内存对象，不写 JSONL metadata，不生成公开或持久 ID。完整 SDK history entry/message IDs 可用于宿主确认事件；使用 Pi 原有 entry identity 不等于新增本包 run/report ID。

### 6.2 Execution 替代 run 和 mount ID

普通创建/ask 为同一 Agent 建立新的 Execution，并设置 currentExecution。一个 Execution 只有一个本次 mount；下一次 ask 创建新 Execution 和 AgentSession。

执行结果生成、agent 状态变更和 mount 回调捕获 execution/session 引用，业务更新前检查：

```ts
runtime.currentScope === execution.scope &&
!execution.scope.closing &&
execution.agent.currentExecution === execution &&
execution.phase !== "closed"
```

E1 完成后 E2 成为 currentExecution，E1 迟到的 callback 不能更新 E2。实例引用挂在执行对象上，无需独立 mount ID。steering 使用同一个 Execution，不创建新对象。

清理回调可幂等收尾其捕获的旧资源，但不得释放新 currentExecution 的名额/状态。

**已提交报告的投递/确认不使用上述 sender currentExecution guard。** finalizing 阶段将最终 envelope 移交给 scope.deliveries 中的 ReportDelivery；sender 随后可退出 busy、清除 currentExecution 并释放 mount。nested target 是 Execution，delivery 持有至公开 SDK 消息/Pi entry + settled barrier 确认处理或 scope 关闭；root target 是 RootScope，宿主 `sendReport` 返回 void，无 processing receipt，成功返回仅表示 submitted，不能证明 recorded/processed，随后释放 scope 中的 delivery。root 没有本包管理的 parent mount finalize 依赖，不为此新建 inbox 或 receipt 协议。

投递/确认只检查当前 scope 有效、delivery 仍归该 scope、捕获的 target Execution 仍是对应 parent 当前执行（root target 则校验 scope）。即使 sender E2 已开始，E1 的已提交报告仍可送给原 parent，但不得修改 E2。

### 6.3 RootScope 替代 epoch

每次 root initialize/switch/reload 创建新的 RootScope 对象，不复用旧对象重新设 closing=false。关闭旧 scope 时置 closing，再停止旧 executions；新 root 使用新 scope。

对比对象身份即可拒绝旧 root callback，不需要数字 epoch。即使复用外层 RootRuntime，也必须替换 scope。

### 6.4 父子执行归属

child Execution.parent 直接捕获发起它的 parent Execution，root caller 则捕获 RootScope；parent.pendingChildren 保存具体 child execution 对象。

同名 child 的后续 ask 产生新对象，不能解除上一执行的依赖；只按 name/session 查询 parent 当前任务重新路由是禁止的。

parent 等待 children 时保留 AgentSession，SDK settled 不直接代表 logical execution 结束。child 不可继续失败时，取消其本次执行的活跃后代，不留下无接收方的任务。

### 6.5 在线报告唯一性和处理 barrier

以下 pendingChildren/pendingReports 与处理确认要求适用于 nested parent Execution；root submission 边界按 §6.2，不把 void 宿主返回视为 processing receipt。

- 同步取得 finalizing 权后才提取/提交最终结果；重复 settled/callback 不再终结一次。
- 每个 Execution 最多设置一次 reportSubmitted，ReportDelivery 在内存中防止重复投递。
- child 完成时，必须同步从 parent.pendingChildren 转入 pendingReports，不能先删完依赖再 await 投递。
- 只有 report 已进入 parent 处理链且相关 SDK processing 结束，才移除 pendingReports；发送函数返回或队列接收不等于 processed。
- 多份报告乱序到达或 parent 重新 idle 时，全部 pendingReports 清空且 SDK 真正 settled，才允许 finalize。
- 宿主确认方式必须以 1.0.0 公开消息/lifecycle语义和集成测试固定；不得假设对象引用经过 SDK 序列化/clone 后保持不变，不将 Execution 引用塞进持久化 custom details。
- 可以使用 Pi 已有 message/session entry identity，或经过验证的批次 processing barrier；不新增本包持久化 report ID/inbox。
- parent 已关闭或 scope 已替换时不投递，也不把报告转交同名 parent 的下一次 execution。

不取消这些保护，只取消独立字符串 ID。实施前 barrier 测试必须证明发送成功不触发提前完成；若公开 API 无法支撑方案，应提供具体证据再讨论，不凭假定减少检查。

## 7. 接受、并发与文件锁

### 7.1 整树 writer lock

`locks/<rootKey>/` 是锁库 target，具体目录形式是实现细节；锁解决两个 Pi 进程同时管理同 original root 的问题，不是单个 child 的业务锁。

- root initialize 取得，shutdown 清理完释放。
- 同 original root 第二 writer 被拒绝；不同 root 可以并行。
- descendants 不创建新的独立 root runtime/lock owner。
- 进程内队列不能替代跨进程锁；原子 rename 也不能防止两个进程各自覆盖状态。
- 整树锁只保护本包对原 root 树的 metadata 管理；D2 允许用户独立打开 child，不增设 owned-child guard 或索引，不承诺排除宿主直接写 JSONL 的竞争。

### 7.2 更新串行化与接受

同一 owner JSON 的变更基于最新状态，经 store 队列串行执行并同目录临时文件原子替换。不同 owner 可独立更新，也可沿用简单整树写队列；模型执行不经过磁盘队列。

name reservation、live 名额和普通 ask 的 currentExecution 占用在首次 await 前同步完成，busy 请求立即拒绝，不能等写队列后变成隐式任务队列。opening 时已知 name/role，状态列表无需临时 ID。

Pi 1.0.0 preflight 参数是 `"handled" | "queued" | "started"`：

- 普通任务仅在 started 提交 running 并返回 started。
- steering 仅在 queued 返回 steered；started 不能假装追加到了原 execution。
- handled 表示 input extension 消费请求，不等于本包任务已启动/排队，不能 truthy 判断。
- 普通任务意外收到 queued，或 steering意外收到 started，是受控异常disposition，必须明确结束工具等待并诊断，不伪装成预期成功。SDK已实际排队/启动，不按纯未接受rollback删除history/identity；执行进入失败收尾，保留可能已变的历史，不能声称撤销排队、历史或extension副作用。具体停止行为须限于本包可安全管理的mount，不能不加检查取消别的执行。
- rejection 按异常处理，不能等待不存在的 boolean false callback。
- **D6 已批准：** handled 返回明确“未启动/未排队”的工具错误/诊断，不返回 started/steered，不生成 accepted Execution 或报告。普通请求按 §7.3 清理 prepared；steering 保持原 Execution、状态及名额不变，不 abort 原任务。仅清理本包可确认的未接受准备资源；不声称回滚 input extension 的历史或外部副作用，也不无条件 abort 扩展自行启动的处理。

当前 `src/runtime.ts` 已按 disposition 类型分支处理，不沿用旧 boolean/truthy 判断。可靠 running 提交采用 `store.setChildSync`，基于同一 child 已持久 opening；普通写队列通过 revision 防止被同步接受超越的旧 child mutation 覆盖新状态。

接受线性化点必须完成对应 owner record 的可靠 running 提交；不可把失败持久化伪装为接受前无事发生。提交方法需兼容 preflight 同步回调与写队列，不仅把 callback 改成异步后立即返回成功。

### 7.3 Prepared 与 rollback

新 child 保存 opening 后才提交 task；普通 ask 可暂将既有 child state 设 opening，但内存保留其先前状态。接受前失败：

- 新 child：清理其新 mount、新 identity record 和本次明确创建的 JSONL，释放 name/live reservation。
- 普通 ask：恢复先前 child state，不删除既有会话/角色/从属关系。
- 跨重启仅凭 opening 和 header/setup 无法可靠区分新建 child 与普通 ask，因此不删除 child 身份、JSONL或name。清除 prepared 执行状态、置为 idle；这仅表示无执行占用，不声称发生过 accepted task。原先若为 interrupted，该展示状态无法从最小schema精准恢复，这是明确限制；不新增prepared历史记录来掩盖它。已知 history 缺失或模型状态不足仍需明确诊断，不能伪造恢复。
- 只有当前进程仍持有明确的“本次新建且尚未接受”事实时才执行新 child rollback。跨重启不猜测旧状态或新建归属，不扫描目录清理“孤儿”。

只有 header+state 的最小结构无法证明所有 crash window 中用户/extension副作用的接受归属；不承诺回滚历史或外部副作用。采用最小 schema 的目标是避免 phantom accepted 执行，不是历史原子事务。

accepted 后失败保留 history，终结为 idle 或 interrupted 并在线报告可得错误，不伪装成未接受 rollback。单 child rollback 不能删除包含 sibling 的 owner 文件。

### 7.4 无跨文件事务

D 完成后更新 B 文件中 D 的 state；B 真正完成后再更新 A 中 B 的 state。这是不同事件，不要求两文件同时提交。

parent 等待集合和 report barrier 全在内存；不新增两阶段提交、全局事务日志、跨文件回滚或恢复调度器。

## 8. 创建、ask、完成与 shutdown

### 8.1 创建

```text
trim/验证 name，同步占用 name/live 名额
→ caller registry 解析 role，校验 cwd/depth/cycle/model/trust
→ 创建 Pi SessionManager 和有效私有 history，获得内部身份
→ 在 caller owner JSON 保存 name-keyed child opening record
→ 构建 target mount、role snapshot、当前资源和 UI
→ preflight started，可靠提交 running
→ 返回 name/role/started/status，后台执行
```

owner JSON 按需创建；已存在时每个写入口必须校验 root/owner/parent header，不匹配不得重写 header“修正”归属。

### 8.2 普通 ask

```text
在 caller 的直接 children 按精确 name 查找
→ 首次await前同步创建并安装一个opening Execution为currentExecution，捕获parent；busy立即拒绝
→ 打开并核对 child history identity
→ 从 header 取 cwd，验证 caller 当前授权/trust/父链
→ 通过 SDK 恢复 child model/thinking，用 snapshot 恢复 role
→ target 当前资源重新建立，为同一个opening Execution填充新AgentSession，不替换执行对象
→ preflight started，提交 running，返回 name/status
```

不新建 Pi session、不覆盖 child 历史模型、不从当前同名角色定义替换 snapshot。

### 8.3 Steering

只在当前 Execution executing/streaming 时接受；普通 prompt 的 slash/template 展开禁用保持现有行为。queued 后返回原 name/steered，不新建 Execution、history 或独立报告。其他状态拒绝，不修改原执行；handled 返回未排队诊断且原 Execution 不变（D6）。

**异步 input hook / 取消边界（修正、自动测试与复审已完成）：** prompt 调用前检查 signal 与捕获的执行归属；hook 等待期间状态可能变化，未排队路径需再次校验，不能把意外 started 当成成功 steering。Pi 1.0.0 的 queued preflight 在 `_queueSteer` 完成后调用，因此 queued 是不可逆接受边界：即使 tool signal 在异步 hook 期间取消或 callback 到达时已取消，也不能据此返回“未排队”/ABORTED、撤销原执行或宣称 rollback；应返回已排队 steered。root shutdown 仍可按正常生命周期中止工作，但不改写已发生的排队事实。不新增独立任务、队列撤回或持久 inbox；相关取消、SDK prompt disposition 与竞争顺序已由当前自动测试及独立复审验证，不代替实际交互 TUI/print 手测。

### 8.4 完成

```text
确认 SDK settled + children/reports 已处理完毕
→ 同步取得唯一 finalizing 权
→ 提取本次 execution 最终 assistant 结果
→ 保存 child 最新 idle state
→ 完成必要 mount 清理，退出 busy
→ 向仍有效的直接 parent execution/scope 投递一次报告
→ 清理内存 execution/delivery 引用
```

最终文本按本次执行的 Pi entry 范围提取，不用整个历史最后一次成功替代本次失败。result 只用于本次在线报告，不另存 metadata 副本；没有文本/失败/取消/incomplete 如实说明。

保存 idle 后、报告写入 parent 前退出，报告可能未投递。该窗口被明确接受：保留 child 已有历史，但不自动补投、不恢复旧执行链。未落盘内容也不宣称可恢复。

### 8.5 Shutdown

旧 scope 标 closing并拒绝新任务/报告触发；取消 UI、abort/dispose 整树 executions、保存 interrupted/终态、清理订阅/状态/widget，最后释放整树锁。关闭幂等，超时不等于底层扩展已停止。

scope 失效后 callback只能幂等收尾自己的资源，不更新新 scope。shutdown 不删除完成 history/metadata，不把停止 root 当前模型回复等同整树 shutdown。

## 9. 恢复与缺失诊断

### 9.1 递归读取关系

取得 root lock后定位 root owner 文件，校验 header；逐个 name-keyed child，依据内部 ID+file定位其 owner文件（存在时递归）。校验每个 root/owner/parent 一致、name 唯一、无循环/重复 Pi ID。

不扫描全局目录拼树、不自动接管未链接记录。恢复 tree 需要读取 header来得到 cwd/父链，不加载 target extensions/模型，不批量 mount。

leaf 无 owner JSON 正常。当前实现采用可选 hasChildren 历史标记诊断已存在分支丢失；首次创建下一层顺序：

1. 创建并校验空 owner文件；失败不继续。
2. 直接 parent 中提交该 child 的 hasChildren=true；失败不写新 child，允许留下空 owner。
3. 才保存下一层 opening record并提交任务。

每步独立原子写，不是事务；空文件或标记已写但尚无 children 均合法。标记不因最后 child rollback 而清除；标记为 true 但 owner 丢失时拒绝恢复。该标记不是独立打开防护或全局索引。

首次加载 root owner不存在，无法区分从未初始化与两次运行之间被删除，只能按空树处理，不承诺诊断；运行中已加载 owner或目录消失须 fail closed。

### 9.2 恢复状态与报告

- running → interrupted，不自动继续旧 prompt、工具、等待链或报告处理。
- opening 按 §7.3清理prepared状态，不能生成phantom run。
- idle/interrupted 保留身份、name和role，可由直接 parent明确ask。
- 不恢复 Execution、AgentSession、pending集合、UI或旧闭包。
- 不保存delivery/reportId，不对账或补投旧报告，不因恢复自动调用模型。
- 已写入 parent 的报告正常属于其Pi历史；仅写在child历史而未报告的结果可通过完整会话路径读取，必要时明确 ask新任务。

这是用户明确接受的恢复边界，取代旧规格 §10.4/§13.4的pending report恢复对账/背景补入要求。禁止实现阶段又默认为补投恢复添加持久 inbox。

## 10. 配置、安全与错误

### 10.1 配置作用域

项目配置仍在 `<callerProjectRoot>/.pi/subagents/setting.json`，缺失用现有默认值。root-only limits与caller-local external_directory不变；全局metadata不等于新增global配置。

配置读取与runtime存储初始化解耦，不再强制创建项目sessions/ignore。不自动改旧setting/.gitignore/sessions；global store不可写不退回旧project store。未trust先不读项目config/agents/resources、不执行扩展。

新全局history不会随项目删除自动删除，但cwd不存在时ask拒绝，不自动重定位。metadata 0600、新建本包目录0700；history敏感性与非sandbox边界照常说明。

### 10.2 错误契约

保留现有业务错误分类，模型可见错误使用name，不附内部ID：

- 重复 name：`SUBAGENT_NAME_EXISTS`，说明直接 parent 作用域并提示 ask。
- name不存在：`SUBAGENT_NOT_FOUND`；不跨parent搜索。
- `SUBAGENT_BUSY` / `SUBAGENT_NOT_STEERABLE`：状态限制不变。
- `SUBAGENT_NOT_STEERABLE` 必须在模型可见 message 中解释当前具体拒绝原因，而不只重复“不可 steering / not actively streaming”：区分 idle（无当前执行）、interrupted（已停止/中断）、实例已释放、opening、等待 children、等待 reports、closing/finalizing，以及 SDK 当前未 streaming。多个等待条件同时存在时须说明 children 和 reports；SDK 未 streaming 且已 settled 时须如实说明。不得仅凭该错误码声称任务已停止，也不得对尚在执行/等待的任务建议当作 idle 重新 ask。诊断不改变原执行、队列、名额或报告契约，不暴露内部 identity。
- `ROOT_SCOPE_IN_USE`：另一进程管理同original root。
- `STORE_ERROR`：owner header不匹配、损坏、不可写或不安全路径。
- `SESSION_HISTORY_UNAVAILABLE`：history缺失/空文件/ID mismatch/cwd不可恢复。
- 模型不可恢复/认证不可用使用现有明确模型错误，不悄悄fallback。

读取全局记录或知道child session路径不授予ask权。不同root引用同一既有非叶owner时，写入口和恢复都拒绝错误归属。

## 11. 与旧规范和兼容的关系

| 历史契约（不再实现） | 当前 Spec 0002 契约 |
| --- | --- |
| sa ID、ask.id、公开run_id | name接口，无模型操作ID，Pi ID仅内部定位 |
| run/mount UUID、root epoch | Execution / RootScope 对象身份保护 |
| 独立agent/run JSON与投递记录 | 每父owner JSON最小child record，无历史runRecord |
| metadata model/thinking/cwd | Pi history/header/SDK恢复，不重复保存 |
| root项目保存全树JSONL | SDK privateDir 新 history + 全局每父直接children JSON；存量实际路径不搬迁 |
| pending report恢复对账/补入 | 不补投、不自动续跑，完整历史按需读取 |
| role-free列表 | name + 创建时role |
| report无完整会话定位 | 一行实际JSONL路径，无Full session标题 |

这是 **BREAKING**：ask参数、成功/错误details、存储、恢复承诺均改变。功能PR用Changeset按仓库规则minor，不在文档任务手动改package版本。

[ADR-0003](../adr/0003-sdk-sessions-and-parent-metadata.md) 已关联并替代 ADR-0001 相关存储决策，不覆盖旧理由。权威 spec 顶部与领域模型已同步当前实现，V1 全部大节/附录仅为历史资料；ADR-0002 进度 widget 继续有效。独立最终复审已完成；2026-10-09 用户明确接受手动 CLI 验收延期并关闭本规格，status 为 completed，不将关闭状态解释为全部验收已通过。

## 12. 最终批准的选择

D1–D6 均已决定，不再阻塞实施：

- **D1：不兼容旧实现、不迁移旧数据。** 新实现不读取、复制或转换旧项目 store / 旧 agentDir store，不双写、不 fallback、不维护旧 ID 或参数别名。升级后旧 agents 不进入新 registry，无法继续 ask；恢复旧 root 时仅加载新布局记录，未初始化新记录则从空的 subagent registry 开始。旧 name 可以在新 registry 重新创建，但得到独立新 history，不继承旧角色/任务。旧 JSONL / metadata 不自动删除；“会话丢失”指新实现不再恢复管理，不要求破坏性擦除磁盘文件。用户文档必须明确该 BREAKING 边界。
- **D5：不保存 runRecord/delivery，不承诺恢复后补投。**

| ID | 最终选择 | 边界 |
| --- | --- | --- |
| D2 | 允许 child 被独立打开、resume 和继续聊天。 | 不新增 owned-child guard、标记或索引，不禁止普通 Pi 管理。独立打开不会接管原 root 的 metadata/ask 权限；整树锁不覆盖宿主直接写 child JSONL，不承诺此类并发无冲突。 |
| D3 | 普通 discovery/picker/continue 不选取新 child histories；独立打开与显式目录 discovery 仍允许。 | 用 privateDir 在普通扫描根之外的目录位置实现，不加 filter/guard/marker/index、不改 mtime。显式 custom-directory 查询仍能发现；存量默认目录 history 可能仍被普通发现，不搬迁、迁移或删除。 |
| D4 | 新 child 采用 SDK `SessionManager.create(cwd, privateDir)`；privateDir 为 `<getAgentDir()>/subagents/histories`，不追加 cwd 分组。 | `PI_CODING_AGENT_DIR` 仍作用于 agentDir；不应用 CLI `--session-dir`、`PI_CODING_AGENT_SESSION_DIR` 或 settings `sessionDir`，不继承 root CLI override。root 及存量 child 按已有实际路径保留与恢复。 |
| D6 | handled 是未接受，不是假 started/steered。 | 普通请求清理 prepared（新 child rollback、既有 ask 恢复先前 state）；steering 不改原 Execution、不 abort 原任务。不保证回滚 extension 历史或外部副作用。 |

采用简单 SDK 原生行为与显式目录并记录有用诊断；不为 D2/D3 添加额外边缘防护策略。当前采用 §9.1 的可选分支缺失标记；它不是 owned-child 索引，不用于拒绝独立打开。

恢复model/thinking和在线处理barrier的SDK验证属于实施门槛，不是增加产品功能；若无法支持已定目标则停止并提供证据讨论。

## 13. 实施阶段与当前进度

阶段 1–4 的 runtime 已实现；阶段 5 最新 typecheck、21 个文件 / 245 项测试、build 与 pack 均成功。此前 runtime 的独立最终复审已完成；本 PR 内 privateDir 修订的独立审查由主代理记录，不在本文冒充已执行。用户于 2026-10-09 接受关闭本规格，实际交互 TUI/print 手动验收未运行、延期跟进；不把关闭或已完成的自动验证/复审等同 §14 全部通过，也不实施后续 Spec 0003。以下保留实施顺序供审查定位。

1. **展示**：`delegation.ts`删两句；`status.ts`/types/runtime增加role和无标题history路径。
2. **SDK/架构门槛**：落实已批准 D2/D3/D4/D6 与 ADR-0003；验证 history model/thinking 恢复、preflight disposition、report 处理 barrier。
3. **工具与内存生命周期**：tools改name；runtime实现name reservation、Execution/RootScope对象guards和capture parent；删除公开IDs及原UUID/epoch依赖，保留现有并发/清理保护。
4. **持久化**：store改owner文件最小schema/整树锁/递归恢复；child-session创建批准的Pi目录history；config/project-storage/index解耦项目runtime写入。不读取或迁移旧store，不保留兼容分支；旧文件原样保留。
5. **回归与文档**：验证cwd/roles/tools/steering/UI/widget/shutdown，更新当前行为文档、Changeset、tarball。每阶段源码改动立即按根Biome格式化，之后类型检查/测试。

## 14. 验收标准

| ID | 要求 |
| --- | --- |
| P01 | description仅删指定两句；ask/name/steering说明一致，无误删其他限制。 |
| P02 | 工具/报告/错误content和details以name寻址，无主动展示session/run/mount/reportID；仅实际文件路径可含Pi ID。 |
| P03 | 所有状态列表含准确role、完整可ask的结构化name；计数与列表一致，shared usage说明初始化。 |
| P04 | 同parent name唯一、trim/case-sensitive；并发同名create仅一成功，完成后同名仍拒绝；不同parent可重名。 |
| P05 | name截断只影响标签不影响ask；特殊对象key不污染registry；不按前缀/全树搜索。 |
| H01 | 首次parent model/thinking优先级不变；parent更换模型后ask的实际mount model/thinking与child历史预期一致，不只检查factory成功；metadata无重复值，缺失/不可用明确失败。 |
| H02 | cwd来自header，当前授权/trust/depth/cycle按父链重校验；snapshot保留，当前资源重建、不插角色history消息。 |
| H03 | history为有效0600JSONL，首次回复前失败/取消可诊断；空文件/ID mismatch/symlink/错误身份拒绝，不猜recent。 |
| F01 | A→B→D、A→C中A只存B/C，B只存D；无runRecord/result/delivery副本，无项目镜像。 |
| F02 | 多child并发更新不丢字段，无半截JSON；同root跨进程冲突，不同root并行。 |
| F03 | 创建/写入口已存在owner必须校验归属，错误root不可覆盖；name不用作文件路径。 |
| F04 | preaccept rollback只清本次新数据；普通ask不删旧history，sibling不误删；opening恢复不制造accepted任务。 |
| E01 | 普通ask创建新Execution+session实例，Pi identity/name不变；steering复用原Execution。 |
| E06 | steering 拒绝返回 SUBAGENT_NOT_STEERABLE 和具体状态原因，覆盖 idle/interrupted/released/opening/waiting children/reports/closing/finalizing/SDK not streaming（含 settled）；不能把所有拒绝等同停止，拒绝不修改原执行或调用 SDK prompt。 |
| E02 | E1迟到callback不能改E2，旧session清理不能释放新execution名额；root新scope拒绝旧回调；E1退出busy且E2已开始后，E1已提交报告仍投给原parent、不修改E2。 |
| E03 | dependency绑定具体Execution，不按name重新路由；parent已关闭时不把旧report转交新任务。 |
| E04 | 重复settled/finalize只提交一次report；pendingChildren到pendingReports无空窗，不把send返回当processed。 |
| E05 | 多report乱序、连续同child ask、最后report与settled竞争不提前finalize；SDK对象clone不破坏处理确认。 |
| R01 | exactresume递归恢复关系/最新state/history，running→interrupted，不mount/不续跑/不补投。 |
| R02 | 保存idle后投递前退出，child历史仍可读但不自动补报告；parent已持久报告保持正常history。 |
| R03 | header/parent/root不匹配、循环/重复ID/已声明分支丢失明确失败；root首次缺文件诊断限制有文档。 |
| C01 | trust先于项目读取/执行；缺setting不强制建project sessions/ignore，旧数据不自动删除。 |
| C02 | global不可写/损坏/运行中文件或目录删除failclosed，不退回旧store。 |
| D01 | 有旧store时新registry不加载旧agent，旧ID不能ask，旧name可创建独立新会话；不读取/迁移/删除旧数据，无兼容参数/alias/fallback，README明确旧agents无法继续使用。 |
| D02 | 独立打开/resume child 不被本包 owned-child guard 拒绝；无 owned-child 索引，不接管原 root metadata，直接 JSONL 写入竞争边界有文档。 |
| D03 | 临时 agentDir/真实锁定 SDK 下验证新 header-only/有消息 child 都在 privateDir；默认 list/listAll 不列出、continueRecent 选普通 session；显式 private-directory 查询/continue 和独立 open 正常。CLI/env/settings sessionDir、root override 不传播；存量 default-directory history exact-path 恢复且原文件不改，仍可普通发现。 |
| D05 | 实际 privateDir ancestor symlink/non-directory 拒绝，无关普通 sessions symlink 不拒绝；新目录 0700、history 0600，既有目录权限保留，metadata schema/identity 不变。 |
| D04 | started/queued按类型接受，handled按D6处理；非预期queued/started不挂起工具、不假成功、不按纯preaccept删除已变history，无phantom execution/report或假steered。 |
| G01 | 原permissions/cwd/tools/roles/steering/UI/progress/shutdown回归通过；不用mock声称真实CLI验证。 |

测试使用临时PI_CODING_AGENT_DIR，不写真实用户store/session/trust。竞争测试用可控barrier，不靠sleep；跨进程lock使用独立进程。

## 15. 验证和交付

最新验证记录（2026-10-10）：tests-first 确认目录修订前 9 项相关测试失败；修订后 39 项 child-session 测试通过，包 typecheck、完整 21 个测试文件 / 245 项测试、build 与 pack 成功。默认/显式 discovery、存量 exact-path 恢复、私有路径/权限使用隔离状态和真实锁定 SDK API 验证，未调用真实模型、未运行实际交互 TUI/print 手测。此前 runtime 的独立最终复审确认 5 项问题已解决、未发现新具体缺陷；不以该旧复审冒充最新 privateDir 修订已复审，主代理另行记录该审查。本次文档同步只检查链接/围栏/差异与定向 package.json 格式，不冒充重跑 runtime 测试，根 Biome 不处理 Markdown。

实现、自动验证与独立复审已完成。用户于 2026-10-09 明确要求先标记完成再提交 PR，并接受在实际交互 TUI/print 手动验收前关闭本规格；status 为 completed，execution_time 记录创建日期 / 完成日期。手动验收实际未运行，延期跟进，不声称 §14 CLI 全验收、发布完成或 Spec 0003 已实现。已知边界：

- root void sendReport 成功仅为 submitted，无 processing receipt；nested Execution 才使用 SDK 处理 barrier，不新增 inbox。
- queued callback 在实际排队后发生，取消不能撤回已排队 steering；接受后不假报未接受。
- 不合作的异步 input hook 仍未退出时，shutdown 保留整树 writer lock，避免新 writer 接管仍可能写入的旧工作；不保证任意扩展可强制终止或关闭立即完成。
- symlink/realpath/header 检查是正常路径与身份校验，不是 filesystem sandbox，也不承诺抵抗恶意并发路径替换的全部 TOCTOU 攻击。

后续手动验收及复验可使用以下命令；关闭本规格不补造验证记录：

```bash
pnpm exec biome check --write <本阶段实际修改的源码与测试路径>
pnpm --filter @yesifan/pi-subagents typecheck
pnpm --filter @yesifan/pi-subagents test
pnpm --filter @yesifan/pi-subagents build
pnpm --filter @yesifan/pi-subagents pack --pack-destination /tmp
```

后续必要 CLI 手测需记录实际结果/失败/超时/未验证范围；D2/D3/D4/D6 的既定边界不变。本次 completed 是用户在实现、自动验证与独立复审完成后明确接受手测延期的关闭决定，不是 §14 全通过证明；PR #11 尚未合并，本次按用户明确要求直接更新原 Spec 0002/ADR-0003；合并后的行为变更再遵守新建规格规则，未运行手测继续列为延期事项。本次文档同步不执行 commit、push、PR 创建、发布或 tag 操作。

## 16. Pi 1.0.0 核对记录

版本依据为origin/main `0fabea0`及已核实version为1.0.0的发布产物，已独立只读审查。固定版本依据：

- [main.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/main.js)：CLI目录优先级和初始选择。
- [sdk.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/sdk.js)：factory默认manager及历史恢复。
- [settings-manager.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/settings-manager.js)：settings合并。
- [session-manager.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/session-manager.js)：ID/header、持久化、恢复上下文和discovery。
- [agent-session.d.ts](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/agent-session.d.ts)、[agent-session.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/agent-session.js)：disposition与input hook。
- [extensions/types.d.ts](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/extensions/types.d.ts)、[agent-session-runtime.js](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.0/dist/core/agent-session-runtime.js)：switch cancellation和能力边界。

此前实际运行的临时目录smoke test（未调用模型、结束清临时目录）：

1. create分配ID/path，首user message才落盘有效header：通过。
2. 0600排他空文件open立即写header并保留权限：通过。
3. list发现header-only文件；可控mtime下recent选择对应文件：通过。

这些早期 smoke test 仅证明 SDK 目录/header/discovery 事实，不是当前 history 采用默认目录的契约。当前新 child 使用 SDK 显式 privateDir；最新 typecheck、21 个文件 / 245 项测试、build 和 pack 成功记录见 §15，其中普通/显式 discovery 与存量 exact-path 恢复由真实 SDK API 测试覆盖。实际交互 TUI/print 手测未运行，不据自动验证声称 §14 CLI 全面通过。D2 明确不实现 child 防护，不将独立打开的已接受边界重新变成防护要求。Spec 0003 仍为未开始计划。
