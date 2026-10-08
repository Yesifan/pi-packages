# Spec 0002：Subagent 提示优化与按父会话存储

- 状态：草案；已确认目标与待决策项分别标注，尚未实施。
- 影响包：`@yesifan/pi-subagents`。
- 需求来源：[Notion 需求](https://app.notion.com/p/alan66/pi-subagents-prompt-optimize-3eb0f77a346d8016ab08d23fc00fd084)及后续讨论。
- 当前实现基线：[领域模型](../domain-model.md)、[实现规格](yesifan-pi-subagents-spec.md)、[ADR-0001](../adr/0001-project-local-subagent-storage.md)。
- SDK 基线：最新 `origin/main`（`0fabea0`）catalog / lockfile 的 Pi `1.0.0`。本次 SDK 核对使用同版本发布产物；实施时安装产物须与 lockfile 一致。

本文定义目标方案，不描述当前已实现行为。“必须”“不得”为目标验收要求，“建议”为实现选择。第 12 节未确认决策阻塞对应实现，不得把推荐选项当成用户授权。本文不立即替换现行实现规格；实施前按第 11 节同步规范，避免两个权威版本冲突。

## 1. 目标与范围

### 1.1 已确认的目标

1. 从 `subagent` tool description 删除指定两句，不删除 steering 功能。
2. 模型可见的直接 children 状态列表携带 role。
3. 自动 report 直接附完整 JSONL 实际路径，不增加 `Full session` 标题。
4. 模型通过 name 创建、查看和 ask，不通过 ID 操作 agent。
5. child JSONL 遵循批准的 Pi 会话目录规则，不再保存在项目私有 subagent scope。
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

<Pi 批准的会话目录>/
  <各会话的实际文件>.jsonl
```

对于 A→B→D、A→C：A 保存 B/C，B 保存 D；B 自身的 child 元数据只在 A 文件。叶节点无需空 owner 文件。B 首次创建 D 时就可创建自己的 owner JSON，不等待 B 完成任务。

全部 metadata 在全局目录，不在 external projects 保存镜像，不另外维护一份权威 relations.json。目录策略受 D4 决策，显式 Pi sessionDir 不一定按 cwd 分组。

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
  // 若采用 §9.1 的分支缺失诊断建议，记录曾初始化 owner 文件。
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

D4 决定 child 使用哪一层配置、是否继承 root CLI override、external child setting 来源和相对目录基准。不能把“遵循 Pi 配置”与“无条件调用内建目录 helper”当同义。

root 现有会话不搬迁；不硬编码 `~/.pi/agent` 或手写 cwd 编码。

### 5.2 ID、header 和权限

SDK 自动生成 ID 时从新建 manager 获取；NewSessionOptions.id 也支持显式 ID，本方案不要求自行生成。

create 会立即分配 ID、内存 header 和预定路径，但 setup entries 不触发新文件落盘；首个 user 或 assistant message 才创建文件。

本包要求保存可恢复 child identity 前已有有效 header，POSIX JSONL mode 为 0600。经 smoke test 验证，排他预创建 0600 空文件再 `SessionManager.open(file, directory, cwd)` 会通过 SDK 立即写有效 header并保留权限。可采用此适配，不调用私有 flush，也不把权限保证归给 SDK 默认 create。

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

## 6. 无 run/mount/epoch 的内存执行模型

### 6.1 对象结构

以下是解释性内部类型，可合并实现，不引入状态机框架：

```ts
interface RootScope {
  closing: boolean;
  agents: Map<string, Agent>; // 内部按 Pi ID，caller 下另有 name 索引
  deliveries: Set<ReportDelivery>; // 持有已提交在线报告，直到确认或 scope 关闭
}

interface Agent {
  name: string;
  identity: SessionIdentity;
  roleSnapshot: AgentDefinitionSnapshot;
  parent: Agent | RootScope;
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
  processed: boolean;
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

**已提交报告的投递/确认不使用上述 sender currentExecution guard。** finalizing 阶段将最终 envelope 移交给 scope.deliveries 中的 ReportDelivery，由它持有至确认或 scope关闭；sender 随后可退出 busy、清除 currentExecution并释放mount。投递/确认只检查当前scope有效、delivery仍归该scope、捕获的target Execution仍是对应parent当前执行（root target则校验scope）。即使sender E2已开始，E1的已提交报告仍可送给原parent，但不得修改E2。

### 6.3 RootScope 替代 epoch

每次 root initialize/switch/reload 创建新的 RootScope 对象，不复用旧对象重新设 closing=false。关闭旧 scope 时置 closing，再停止旧 executions；新 root 使用新 scope。

对比对象身份即可拒绝旧 root callback，不需要数字 epoch。即使复用外层 RootRuntime，也必须替换 scope。

### 6.4 父子执行归属

child Execution.parent 直接捕获发起它的 parent Execution，root caller 则捕获 RootScope；parent.pendingChildren 保存具体 child execution 对象。

同名 child 的后续 ask 产生新对象，不能解除上一执行的依赖；只按 name/session 查询 parent 当前任务重新路由是禁止的。

parent 等待 children 时保留 AgentSession，SDK settled 不直接代表 logical execution 结束。child 不可继续失败时，取消其本次执行的活跃后代，不留下无接收方的任务。

### 6.5 在线报告唯一性和处理 barrier

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
- 整树锁不自动阻止用户绕过插件直接打开 child，D2 必须说明边界。

### 7.2 更新串行化与接受

同一 owner JSON 的变更基于最新状态，经 store 队列串行执行并同目录临时文件原子替换。不同 owner 可独立更新，也可沿用简单整树写队列；模型执行不经过磁盘队列。

name reservation、live 名额和普通 ask 的 currentExecution 占用在首次 await 前同步完成，busy 请求立即拒绝，不能等写队列后变成隐式任务队列。opening 时已知 name/role，状态列表无需临时 ID。

Pi 1.0.0 preflight 参数是 `"handled" | "queued" | "started"`：

- 普通任务仅在 started 提交 running 并返回 started。
- steering 仅在 queued 返回 steered；started 不能假装追加到了原 execution。
- handled 表示 input extension 消费请求，不等于本包任务已启动/排队，不能 truthy 判断。
- 普通任务意外收到 queued，或 steering意外收到 started，是受控异常disposition，必须明确结束工具等待并诊断，不伪装成预期成功。SDK已实际排队/启动，不按纯未接受rollback删除history/identity；执行进入失败收尾，保留可能已变的历史，不能声称撤销排队、历史或extension副作用。具体停止行为须限于本包可安全管理的mount，不能不加检查取消别的执行。
- rejection 按异常处理，不能等待不存在的 boolean false callback。
- D6 确认 handled 的具体工具结果/清理；扩展已有副作用不声称可回滚。

原 `src/runtime.ts` 两处使用 boolean/truthy 判断，这是 1.0.0 实施适配项；本 spec 不声称代码已经修正。

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

只在当前 Execution executing/streaming 时接受；普通 prompt 的 slash/template 展开禁用保持现有行为。queued 后返回原 name/steered，不新建 Execution、history 或独立报告。其他状态拒绝，不修改原执行；handled 按 D6。

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

leaf 无 owner JSON正常。建议 child record 使用可选 hasChildren 历史标记诊断已存在分支丢失；若采用首次创建下一层顺序：

1. 创建并校验空 owner文件；失败不继续。
2. 直接 parent 中提交该 child 的 hasChildren=true；失败不写新 child，允许留下空 owner。
3. 才保存下一层 opening record并提交任务。

每步独立原子写，不是事务；空文件或标记已写但尚无 children均合法。标记不因最后 child rollback而清除；标记为 true但 owner丢失时拒绝恢复。不采用此建议时必须明确缺失诊断能力，不自动加全局索引。

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

- 重复name：建议 `SUBAGENT_NAME_EXISTS`，说明作用域并提示ask；实现前固定测试。
- name不存在：`SUBAGENT_NOT_FOUND`；不跨parent搜索。
- `SUBAGENT_BUSY` / `SUBAGENT_NOT_STEERABLE`：状态限制不变。
- `ROOT_SCOPE_IN_USE`：另一进程管理同original root。
- `STORE_ERROR`：owner header不匹配、损坏、不可写或不安全路径。
- `SESSION_HISTORY_UNAVAILABLE`：history缺失/空文件/ID mismatch/cwd不可恢复。
- 模型不可恢复/认证不可用使用现有明确模型错误，不悄悄fallback。

读取全局记录或知道child session路径不授予ask权。不同root引用同一既有非叶owner时，写入口和恢复都拒绝错误归属。

## 11. 与旧规范和兼容的关系

| 当前契约 | 目标契约 |
| --- | --- |
| sa ID、ask.id、公开run_id | name接口，无模型操作ID，Pi ID仅内部定位 |
| run/mount UUID、root epoch | Execution / RootScope 对象身份保护 |
| 独立agent/run JSON与投递记录 | 每父owner JSON最小child record，无历史runRecord |
| metadata model/thinking/cwd | Pi history/header/SDK恢复，不重复保存 |
| root项目保存全树JSONL | Pi会话目录history + 全局每父直接children JSON |
| pending report恢复对账/补入 | 不补投、不自动续跑，完整历史按需读取 |
| role-free列表 | name + 创建时role |
| report无完整会话定位 | 一行实际JSONL路径，无Full session标题 |

这是 **BREAKING**：ask参数、成功/错误details、存储、恢复承诺均改变。功能PR用Changeset按仓库规则minor，不在文档任务手动改package版本。

实施前新增ADR关联并替代ADR-0001相关决策，不覆盖旧理由。同步现行spec §2/§3/§6–§10/§12/§13/§17及附录、领域模型、README/示例；ADR-0002进度widget继续有效。不提前把目标草案写成README当前事实。

## 12. 已决策与待确认项

以下已决定，不再阻塞实施：

- **D1：不兼容旧实现、不迁移旧数据。** 新实现不读取、复制或转换旧项目 store / 旧 agentDir store，不双写、不 fallback、不维护旧 ID 或参数别名。升级后旧 agents 不进入新 registry，无法继续 ask；恢复旧 root 时仅加载新布局记录，未初始化新记录则从空的 subagent registry 开始。旧 name 可以在新 registry 重新创建，但得到独立新 history，不继承旧角色/任务。旧 JSONL / metadata 不自动删除；“会话丢失”指新实现不再恢复管理，不要求破坏性擦除磁盘文件。用户文档必须明确该 BREAKING 边界。
- **D5：不保存 runRecord/delivery，不承诺恢复后补投。**

| ID | 待确认问题 | 推荐与边界 |
| --- | --- | --- |
| D2 | 手动resume owned child如何处理？ | 推荐识别后拒绝继续聊天/管理，不承诺零写入。before-switch可cancel但CLI初始打开不经过旧runtime，session_start不能cancel，SDK无通用file-backed readonly；加载前迁移/命名可能写盘，shutdown依赖宿主。leaf识别仍需单独选择标记/可重建索引等，不自动加权威关系表。 |
| D3 | discovery扫描到child时，接受picker/continue影响吗？ | discovery无subagent过滤，header-only也可见；recent按mtime/header，自定义目录按cwd过滤，listAll(customDir)只扫该目录。按D4实际目录组合确认，不无条件声称external cwd互抢，不改mtime隐藏。 |
| D4 | child采用CLI等效配置还是SDK内建目录？ | 确认root CLI override是否传播、external child settings来源和相对目录基准。显式目录不追加cwd分组；不能忽略用户setting后仍声称遵循配置。 |
| D6 | input hook返回handled的工具结果？ | 推荐明确未启动/未排队说明，使用既有错误类别，不生成accepted执行或假steered；普通请求清理prepared，steering不改原Execution。扩展副作用不可假装回滚，不无条件abort其自行启动的处理。 |

恢复model/thinking和在线处理barrier的SDK验证属于实施门槛，不是增加产品功能；若无法支持已定目标则停止并提供证据讨论。

## 13. 实施阶段

1. **展示**：`delegation.ts`删两句；`status.ts`/types/runtime增加role和无标题history路径。
2. **SDK/架构门槛**：确认D2/D3/D4/D6，新增ADR；验证history model/thinking恢复、preflight disposition、report处理barrier。
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
| D02 | D2批准的继续聊天/管理限制在适用宿主验证；明确CLI初始/扩展禁用/加载前写入边界。 |
| D03 | D4实际默认/自定义目录、同/不同cwd组合下，picker/continue影响按D3如实验证。 |
| D04 | started/queued按类型接受，handled按D6处理；非预期queued/started不挂起工具、不假成功、不按纯preaccept删除已变history，无phantom execution/report或假steered。 |
| G01 | 原permissions/cwd/tools/roles/steering/UI/progress/shutdown回归通过；不用mock声称真实CLI验证。 |

测试使用临时PI_CODING_AGENT_DIR，不写真实用户store/session/trust。竞争测试用可控barrier，不靠sleep；跨进程lock使用独立进程。

## 15. 验证和交付

本次只更新文档，执行本地链接/围栏/差异检查。根Biome不处理Markdown，不声称Markdown格式检查通过；不以未改runtime的测试当实现验证。

实施后至少：

```bash
pnpm exec biome check --write <本阶段实际修改的源码与测试路径>
pnpm --filter @yesifan/pi-subagents typecheck
pnpm --filter @yesifan/pi-subagents test
pnpm --filter @yesifan/pi-subagents build
pnpm --filter @yesifan/pi-subagents pack --pack-destination /tmp
```

检查tarball、SDK smoke test和必要CLI手测，记录命令结果/失败/超时/未验证范围。D2/D3/D4/D6已决定、SDK门槛及相关验收通过、规范与实现同步、新ADR/Changeset完成，才可声称实现完成。不发布、不push、不创建tag。

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

这些结果不证明新的name接口/Execution对象/barrier/最小metadata已实现。未验证：新model/thinking完整恢复测试、真实TUI/print-mode child防护、D6 input-hook集成、新schema/name/并发回归。
