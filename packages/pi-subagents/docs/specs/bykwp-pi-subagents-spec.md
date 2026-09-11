# @bykwp/pi-subagents — 实现规格

**文档版本：** 1.2
**状态：** v1 实现基线（已合并 session-local delegation 与原生进度 widget 决策）
**目标包名：** `@bykwp/pi-subagents`  
**目标宿主：** Pi CLI / TUI  
**SDK 验证基线：** `@earendil-works/pi-coding-agent@0.85.1`  
**实现语言：** TypeScript，ES modules  
**用途：** 交给 coding agent 完成 package、测试、示例和使用文档。

本文中的“必须”“不得”是验收要求；“建议”允许在保持行为一致的前提下调整实现。代码中的业务类型用于解释契约，不应误认为 Pi 导出的类型。所有 Pi API 签名以 0.85.1 的实际导出和类型检查为准。

本规格区分两类内容：产品行为由本文定义；Pi 已有接口及其语义由文末固定版本源码支撑。本文不是已经运行通过的 package，也不代表集成测试已经完成。

---

## 1. 目标与最终决定

实现一个规模克制的后台 subagent package。它在宿主 Node.js 进程中，通过 Pi SDK 创建独立会话，不建立 RPC 子进程调度系统，不实现自定义 TUI。

核心模型：

> Subagent 是可恢复的逻辑对象；AgentSession 是执行实例。执行和等待子任务期间保留实例；整项委派结束后释放实例；下一次明确 ask 时从持久化历史恢复。

| 项目 | v1 决定 |
|---|---|
| 公开工具 | 只有 `subagent` 和 `ask_subagent` |
| 创建参数 | `name, prompt, agent_type?, thinking?, cwd?` |
| agent type | 调用方 session 从内置 + Pi 全局 + 自己当前项目加载 |
| child 当前角色 | 使用调用方创建时选择并保存的 agent definition snapshot |
| child 后续委派角色 | 如果有委派能力，则从 child 自己 cwd 重新加载 |
| model | 创建时继承直接 parent 当前模型，之后固定；不提供 model 参数 |
| thinking | 调用参数 > agent snapshot 默认值 > parent 当前值 |
| cwd 默认值 | caller 当前 cwd |
| cwd 显式输入 | 只允许绝对路径 |
| cwd 授权 | 必须精确等于 caller cwd 或 caller 配置的某个 `external_directory` |
| `external_directory` 配置 | 允许 `~` / `$HOME` / `${HOME}`，展开后必须绝对；精确目录匹配 |
| 运行模式 | 始终后台；工具不等待委派任务最终完成 |
| same-cwd child | 不提供 delegation tools |
| external child | 在角色与 depth 允许时可以继续委派，并加载自己的 delegation config |
| system prompt | target cwd 正常 Pi prompt + runtime prompt + current-role snapshot |
| tools/resources | target cwd 当前 Pi 机制正常重新加载 |
| ask 恢复 | history 从 SessionManager 恢复；role 从 snapshot 恢复；tools/delegation config 从当前 cwd 重建 |
| report tool | 不存在，不注入给模型 |
| 结果报告 | 运行时自动提取本次逻辑任务的最终 assistant 回复，交给直接 parent |
| 报告投递 | 使用 Pi custom message 的 `steer` 模式，并在 parent 空闲时触发处理 |
| UI | 代理受支持的官方 `ctx.ui` 方法到 root CLI；所有后代共享一个对话框队列；root 使用原生字符串 widget 聚合活动 subagent 的最新进度 |
| 忙碌时 ask | 普通 ask 立即失败；仅 `isSteer: true` 可向当前可 steering 的 executing run 追加输入 |
| 等待子任务 | 保留 idle AgentSession；不做冷释放、冷唤醒或离线父节点调度 |
| 真正完成 | 保存结果、完成必要清理后 dispose；保留身份与历史 |
| root shutdown | 取消 UI、abort 整棵任务树并 dispose；不删除持久化历史 |
| root resume | 恢复同一 root 的记录，允许 ask 原 ID；不自动重跑中断任务 |

**明确不做：** 前台模式、`report()`、`get_subagent_result()`、`abort_subagent()`、新的 delegation 任务队列、工作窃取、工作区/worktree 管理、独立进程隔离、dashboard、自定义组件、聊天渠道适配、自动总结模型、跨 root 的 agent 共享、自动重放工具副作用。`isSteer: true` 只复用 Pi 已有 steering queue，不属于新的 delegation 队列。

Pi extension 是 package 的接入形式。“不使用自定义 UI”不等于“不使用 extension API”。根据
[ADR-0002](../adr/0002-native-widget-for-background-progress.md)，用途受限、只读且由 root 持有的
Pi 原生字符串进度 widget 不属于 dashboard 或自定义组件。

## 2. 概念和所有权

### 2.1 五个不同的概念

| 概念 | 本文含义 |
|---|---|
| root session | 用户正在使用的最外层 Pi 会话；整棵 subagent 树的所有权边界 |
| logical subagent | 稳定 ID、角色、cwd、模型身份和持久化历史的集合，可跨多次 ask 存活 |
| delegation / logical run | 一次成功接受的 `subagent` 或普通 `ask_subagent` 请求，以及它引起的子任务和结果处理；steering 不创建 logical run |
| SDK run | 一次 Pi agent processing；一次 delegation 可以包含初始 prompt 和若干报告触发的 SDK run |
| AgentSession instance | 当前加载在内存中的 SDK 执行实例；完成后可销毁，以后重新创建 |

Pi 的 `agent_settled` 表示该 SDK 运行链结束，不表示本包管理的后代任务全部结束。[P3]

### 2.2 所有权规则

每个 subagent 持久化 `rootSessionId` 和直接 `parentAgentId`。直接 parent 为用户会话时，`parentAgentId` 为 `null`。

RootRuntime 在内存中管理所有后代，但工具调用权限是按调用者绑定的：

- root 的工具只能直接 ask 自己创建的 child。
- B 的工具只能直接 ask B 创建的 child。
- 不能通过猜测 ID 修改其他 root、兄弟节点或不属于调用者的后代。
- root 关闭时，运行时仍有权统一取消所有层级。

工具不接受 `rootSessionId`、`parentAgentId` 或内部权限标志作为模型可填参数。这些信息必须由已绑定的工具实例提供。

依赖关系必须绑定到 **child 的某一次 run**，不能只绑定 child ID。例如 `(childId, runId)`。同一个 child 后续 ask 的结果不能误计入前一项委派。

### 2.3 Session-local delegation configuration

每个具有 `subagent` 工具的 session 都拥有由自身 cwd 决定的 delegation configuration：

```text
Agent types:
  内置 agent
  + Pi 全局 agent
  + 当前 session 所在项目的 agent

Delegation cwd:
  当前 session cwd
  + 当前 session 配置的 external_directory
```

父 session 不扫描、不预加载、不展示 external directory 内部项目的 agent type 或下一层 `external_directory`。例如 A 只配置 `/workspace/B`，B 只配置 `/workspace/C` 时，A 只知道 A 的 agents 与 `/workspace/B`；B 创建以后才从 `/workspace/B` 加载 B 自己的 agents 与 `/workspace/C`，因此允许 `A → B → C`。

必须区分当前身份与未来委派 registry：

```text
CurrentRole(child) != DelegationAgentRegistry(child)
```

child 当前角色来自 caller 创建时解析并保存的 snapshot；child 后续创建下一层 child 时使用由 child 自己 cwd 构建的 registry。两者不同是合法且正常的状态。

RootRuntime 只负责 logical ownership、parent/child 关系、run ID、`max_depth`、`max_live_agents`、UI broker、报告路由、shutdown、持久化与 active instances；它不得维护全局共享的 AgentTypeRegistry 或所有 descendant 共用的 cwd allowlist。

## 3. 外部工具契约

### 3.1 `subagent`

参数：

```ts
interface SubagentParams {
  name: string;
  prompt: string;
  agent_type?: string; // 默认 general
  thinking?: ThinkingLevel;
  cwd?: string;       // 默认调用者 ctx.cwd
}
```

示例：

```json
{
  "name": "auth-explorer",
  "prompt": "检查登录请求经过哪些模块，给出文件位置和调用关系，不修改代码。",
  "agent_type": "explore",
  "thinking": "high",
  "cwd": "/home/user/code/backend"
}
```

参数规则：`name` 和 `prompt` 必须非空。`name` 只作显示标签，不作为唯一键、路径或角色选择器。`agent_type` 是字符串而非固定枚举，因为 caller 当前项目可以添加角色；它必须存在于 caller session 自己的 AgentTypeRegistry，省略时使用 `general`。thinking 的 schema 从锁定 SDK 的类型/支持值构建，不自行发明新等级。

`cwd` 省略时使用 caller session 的 canonical cwd。显式提供时必须已经是绝对路径；tool 参数中不得使用相对路径、`~`、`$HOME` 或 `${HOME}`。实现对它执行 `realpath` 后，结果必须与 caller canonical cwd 或 caller 的某一项 canonical external cwd **完全相等**。`agent_type` 与 `cwd` 独立验证，不使用 cwd × agent_type 的条件 schema：

```text
agent_type ∈ caller.AgentTypeRegistry
cwd ∈ caller.AllowedCwdSet
```

参数 description 必须表达：

```text
agent_type:
  Agent type for this subagent. Defaults to "general".
  Must be one of the agent types listed in this tool's description.
  The definition is resolved from the caller's agent registry when the
  subagent is created.

cwd:
  Absolute working directory for the subagent.
  Omit to use the caller's current cwd.
  When specified, it must exactly match the current cwd or one of the
  external cwd paths listed in this tool's description after canonical
  path resolution.
  Relative paths, ~, $HOME and ${HOME} are not accepted here.
```

每个具有 delegation capability 的 session 都必须动态生成自己的 `subagent` tool description，并注入它自己的 agent 摘要、current cwd 与 external cwd；agent 只展示 `id` 和 `description`，不得展开完整角色 prompt。格式例如：

```text
Create a background subagent. The call returns immediately after the
subagent has been accepted. Its final response is automatically reported
back to this agent.

Available agent types:
- general: General-purpose task execution.
- explore: Read-only code exploration.
- tester: Run and analyze tests.

Current cwd:
- /workspace/B

Available external cwd:
- /workspace/C
- /workspace/D

agent_type must be one of the agent types listed above.
cwd must be an absolute path and must exactly match Current cwd or one of
Available external cwd after canonical path resolution.
Omit cwd to use Current cwd.

Use ask_subagent to delegate another task to an existing idle subagent, or
set isSteer to true to steer an actively executing run.
```

展示的 external cwd 必须已完成 home expansion、绝对路径验证和 canonicalization，模型应能直接复制。description 只暴露 caller 自己可用的资源，不递归暴露 external 项目的下一层配置。

> **Warning Cache Broke:** `subagent` tool description 属于模型 tool context。session-local agents 或 external cwd 变化并在创建/恢复 AgentSession 时重建 description，会改变 tools schema/context，从该位置起可能无法复用先前的 provider prompt cache。不得为了命中缓存而持久化或复用陈旧 description。

成功工具结果的业务数据：

```ts
interface AcceptedResult {
  ok: true;
  id: string;
  run_id: string;
  name: string;
  agent_type: string;
  cwd: string;
  status: "started" | "steered";
  thinking: ThinkingLevel; // 实际生效值
}
```

必须包装成普通 Pi tool result：`content` 提供可读的启动结果，`details` 保存结构化数据。不能只把返回 ID 写在 UI 通知中。

“后台”表示不等待模型完成任务。工具允许等待参数校验、项目准入、必要资源加载和 session 初始化。只有确定该请求已被接受后才返回成功。返回前失败应返回工具错误；接受后发生的执行失败通过自动报告交回 parent。

### 3.2 `ask_subagent`

```ts
interface AskSubagentParams {
  id: string;
  prompt: string;
  isSteer?: boolean; // 默认 false
}
```

`isSteer` 省略或为 `false` 时，这是普通 ask：只向已有 idle subagent 追加一项新的 delegation，不允许修改其 name、角色、cwd、model 或 thinking。若实例已释放，则打开其会话历史、重新加载 target cwd 资源、重新绑定本次实例的 UI 和工具，再启动新任务。成功结果中 `id` 不变，生成新的 `run_id`，`status = "started"`。

普通 ask 只在上一项 delegation 已终结且清理完成后接受。初始化、执行、等待 UI、重试、压缩、等待子任务、处理子报告、保存最终结果或清理中的 logical subagent 均返回 `SUBAGENT_BUSY`，不得排队：

```text
ask(A, "x") → accepted as new run
ask(A, "y") → SUBAGENT_BUSY，立即失败
```

失败的普通 ask 不得进入会话历史、不得增加已接受 run 数。

`isSteer: true` 表示向当前 logical run 追加 steering input，而不是创建新的 delegation：

- 必须由 direct owner 调用；
- child 必须已有 live AgentSession，处于 `executing`，且 `session.isStreaming === true`；
- 使用 `session.prompt(prompt, { streamingBehavior: "steer", expandPromptTemplates: false, preflightResult })`，不得使用会展开 file prompt template 的裸 `session.steer()`；
- `preflightResult(true)` 后立即返回，不等待当前 run 完成；
- 返回当前 `run_id` 与 `status = "steered"`，不创建新 run、不增加 accepted run 数；
- 不产生独立最终报告；当前 run 处理 steering 后仍只产生自己的最终报告；
- steering 不修改角色 snapshot、cwd、model 或 thinking。

steering 在 idle、实例已释放、opening、closing/finalizing、恢复中，或 SDK 已 settled 但 logical run 仅因等待 child/report 而 busy 时，返回 `SUBAGENT_NOT_STEERABLE`。steering 不强制终止当前 Bash/tool/UI；Pi 会在当前 assistant turn 的 tool calls 结束后投递它。多个 steering input 可以沿用 Pi 当前 run 的 steering queue，但它们都不成为 logical run。

### 3.3 错误契约

业务错误应作为模型可见的普通工具结果返回，例如：

```ts
{
  content: [{
    type: "text",
    text: "SUBAGENT_BUSY: auth-explorer is waiting for child tasks."
  }],
  details: {
    ok: false,
    error: { code: "SUBAGENT_BUSY", message: "...", id: "sa_..." }
  }
}
```

这不是新的 Pi transport schema。实现可按 SDK 的标准错误方式包装，但业务 code 和可读说明必须保留；不得产生未处理 Promise rejection。

至少覆盖这些 code：

| 类别 | Code |
|---|---|
| 参数/配置 | `INVALID_ARGUMENT`、`INVALID_CONFIG` |
| 角色 | `AGENT_TYPE_NOT_FOUND`、`INVALID_AGENT_DEFINITION`、`TOOL_UNAVAILABLE` |
| 目录/信任 | `CWD_NOT_FOUND`、`CWD_NOT_DIRECTORY`、`CWD_NOT_ALLOWED`、`PROJECT_NOT_TRUSTED` |
| 委派限制 | `DELEGATION_DISABLED`、`DELEGATION_CYCLE`、`DEPTH_LIMIT`、`LIVE_AGENT_LIMIT` |
| 身份/并发 | `SUBAGENT_NOT_FOUND`、`SUBAGENT_BUSY`、`SUBAGENT_NOT_STEERABLE`、`SUBAGENT_NOT_OWNED` |
| 模型 | `PARENT_MODEL_UNAVAILABLE`、`MODEL_UNAVAILABLE`、`MODEL_AUTH_UNAVAILABLE` |
| 持久化 | `STORE_ERROR`、`SESSION_HISTORY_UNAVAILABLE`、`ROOT_SCOPE_IN_USE` |
| 生命周期 | `ROOT_CLOSING`、`ROOT_SESSION_NOT_PERSISTENT` |

未知角色错误应列出 caller session 的 AgentTypeRegistry 中可用角色，而不是目标 cwd 的角色。`SUBAGENT_BUSY` 应区分“执行中”和“等待子任务”等原因，不能统一谎报正在输出 token。

## 4. 配置

本节定义的是**本包配置**，不是 Pi 内置配置字段。

配置文件：

```text
用户级：<getAgentDir()>/extensions/pi-subagents.json
项目级：<currentProjectRoot>/.pi/extensions/pi-subagents.json
```

v1 schema：

```json
{
  "external_directory": [
    "/workspace/backend",
    "~/projects/frontend",
    "$HOME/projects/shared"
  ],
  "max_depth": 4,
  "max_live_agents": 8,
  "ui_timeout_ms": 120000
}
```

默认值：`external_directory: []`，其他三个字段使用示例值。这些是本规格选定的实现默认值，不是 Pi SDK 默认值。用户级与 session 当前项目级配置合并时，项目级同名字段替换用户级字段，数组不做隐式 union；畸形配置不得静默回退。

`external_directory` 是精确 external cwd 列表，不是目录树 root。每个具有委派能力的 session 都根据自己的 cwd/current project 加载这一字段；父 session 不加载 external cwd 内部项目的本包配置。B 可以通过自己的配置允许 C，即使 root/A 未配置 C。

每一项只允许展开 `~`、`$HOME`、`${HOME}`。除此之外不得执行通用环境变量展开、shell expansion、glob 或命令替换。加载顺序固定为：

```text
raw config value
→ 展开 ~ / $HOME / ${HOME}
→ 验证为绝对路径
→ 验证存在
→ 验证为 directory
→ realpath / canonical path
→ 保存规范化结果
```

展开后仍不是绝对路径，或路径不存在、不是目录，必须返回 `INVALID_CONFIG`；`../backend`、`./backend`、`backend` 均非法，不得静默忽略。

授权匹配只能是：

```ts
canonicalTarget === canonicalConfiguredDirectory
```

不得使用 `startsWith()` 或子树包含判断。配置 `/workspace/backend` 只允许该目录本身；`/workspace/backend/src`、`/workspace/backend/packages/foo`、`/workspace`、`/workspace/backend-other` 均拒绝。尾分隔符与指向同一目录的 symlink 经 canonicalization 后可以匹配；需要允许子目录时必须逐项显式配置。

RootRuntime 继续统一执行 `max_depth`、`max_live_agents`、root ownership、shutdown、UI 与报告约束，但不保存全树共享 cwd allowlist。每次 `subagent()` 只由直接 caller 的 DelegationContext 判断目标 cwd。`max_live_agents` 计数包括正在初始化、执行、等待子任务和清理中的实例，不包括已经释放实例的持久化记录和用户 root session；达到限制立即拒绝，不建立队列。

## 5. Agent type

### 5.1 Session-local AgentTypeRegistry

每个具有委派能力的 session 根据**自己的 cwd**构建 AgentTypeRegistry，固定加载顺序为：

```text
@bykwp/pi-subagents 内置 agents
        ↓
Pi 全局 <getAgentDir()>/agents/*.md
        ↓
<currentProjectRoot>/.pi/agents/*.md
```

后加载的同名 agent 完整覆盖前一层定义，不做字段级 merge。内置必须至少提供 `general` 与 `explore`。

创建 child 时，`agent_type` 只能从 **caller session 自己的 AgentTypeRegistry** 解析。不得因为传入了 external cwd，就扫描或使用 target cwd 的 `.pi/agents/*.md`。例如 A 用 A registry 中的 `reviewer` 创建 cwd 为 B 的 child，该 child 当前角色仍是 A 的 `reviewer`；B 项目同名角色不能覆盖本次选择。

external child 若获得委派能力，则在它自己的 SDK session 中按 B cwd 构建新的 AgentTypeRegistry。这个 registry 只决定 B 未来可用哪些角色创建 descendants，不改变 B 正在扮演的 current role，也不向 A 暴露。

目标 cwd 的 `AGENTS.md`、skills、extensions 等普通 Pi resources 仍由 Pi 正常资源加载处理。[P5] AgentTypeRegistry、Pi `AGENTS.md`、Pi skills 与 Pi extensions 是不同概念。

agent type 的 ID 来自文件名，要求 `[a-z][a-z0-9-]{0,63}`。frontmatter 的可选 `name` 必须与文件名一致。符号链接文件必须解析到对应允许的角色目录内；不可借角色加载读取任意路径。

### 5.2 文件格式

```md
---
name: security-review
description: 检查认证、授权和信任边界
tools: [read, grep, find, ls]
thinking: high
---

检查认证、授权和信任边界。
提供具体文件位置、证据和不确定之处，不修改文件。
```

允许字段为 `name`、`description`、`tools`、`thinking`。body 是完整角色 prompt。

`tools` 省略表示不施加角色级工具白名单；指定时只允许启用已发现且在列表内的工具。未知工具应给出明确错误，不能悄悄忽略。不得通过角色定义添加 model、cwd、后台模式、根目录权限或其他运行时控制字段。

内置角色：

| 角色 | 定义 |
|---|---|
| general | 常规任务处理；不额外限制普通 session 的工具；不给默认 thinking 覆盖 |
| explore | 代码理解与检索；白名单 `read, grep, find, ls`；不提供 bash/edit/write；不给默认 thinking 覆盖 |

“内置 explore”通过实际工具集合实现只读倾向，不只依靠 prompt。全局或 caller 当前项目显式提供同名定义后，以完整覆盖后的定义为准；只有这种显式覆盖可以让 `explore` 获得 `bash`、`edit` 或 `write`。

### 5.3 Agent definition snapshot

创建 child 时，必须将从 caller registry 解析出的定义规范化并保存为 logical subagent 的完整 snapshot：

```ts
interface AgentDefinitionSnapshot {
  id: string;
  description?: string;
  tools?: string[];
  thinking?: ThinkingLevel;
  prompt: string;
  source: string;
  contentHash: string;
}
```

以后 `ask_subagent(id, ...)` 始终用该 snapshot 恢复 current role。全局 agent 文件、项目 agent 文件或 caller registry 后续变化不得改变已存在 logical subagent 的角色；也不得按同名 ID 从恢复时项目重新解析角色。

角色 snapshot 不等于 delegation registry snapshot。child 恢复后未来可用的 delegation agents 必须按 child 当前 cwd 重新加载。其他普通 Pi resources、cwd 存在性、授权与项目信任也按当前状态重新检查；snapshot 不能绕过收紧后的安全策略。

> **Warning Cache Broke:** 修改已存在 logical subagent 的 snapshot、snapshot 规范化/hash 规则或 current-role prompt 拼接顺序，会改变恢复时的 system prompt，破坏该会话从该前缀开始的 prompt cache。正常实现不得重新解析并替换旧 snapshot。

## 6. cwd 与递归规则

### 6.1 tool cwd 规范化与精确授权

1. 省略 `cwd` 时使用 caller session 的 canonical cwd。
2. 显式 `cwd` 必须通过 `path.isAbsolute(cwd)`；相对路径、`~`、`$HOME`、`${HOME}` 一律返回 `INVALID_ARGUMENT`，tool 参数不做 home expansion。
3. 对绝对输入执行 `realpath`，并确认存在且为 directory。
4. 结果必须与 canonical caller cwd 或 caller DelegationContext 的某项 canonical external directory 完全相等。
5. 再执行 trust、角色、depth、live budget 与 cycle 检查。

有效 cwd 集合严格为：

```text
{
  canonical(caller.cwd),
  ...canonical(caller.externalDirectories)
}
```

授权不得使用目录包含、路径前缀或 Git project identity。`/a/b` 不授权 `/a/b/c` 或 `/a/b-other`；symlink 和尾分隔符在 realpath/canonicalization 后相同则允许。

创建和每次 ask 恢复都要重新检查保存 cwd 的存在性、目录类型、canonical identity、直接 caller 当前授权与 trust。历史里曾被允许不意味着以后永久允许。ask 不接受新 cwd，但恢复时仍必须用直接 caller 当前 DelegationContext 验证保存的 cwd。

### 6.2 Project root 的有限用途

Git/project root 仍可用于定位 caller 当前项目的 `.pi/agents`、项目 trust 和 Pi 普通资源发现，但不参与 cwd allowlist 精确匹配、delegation capability 或 cycle detection。识别到更大的 Git root 不得扩大 cwd 准入。

### 6.3 委派能力与循环

创建 child 时先按 canonical cwd 分类：

```text
target cwd == caller cwd
  → same-cwd child
  → 不提供 subagent / ask_subagent

target cwd 精确来自 caller external_directory
  → external child
  → 可以获得 delegation capability
```

external child 最终是否真正获得 `subagent`、`ask_subagent`，还必须同时通过 depth limit、所选 agent snapshot 的 tools whitelist 与 runtime policy。same-cwd child 始终排除这两个工具。执行入口必须重复检查能力和所有权；隐藏工具不能替代执行校验。

每个 logical subagent 保存 canonical cwd ancestor chain，例如：

```ts
ancestorCwds: string[]; // 包含 root/callers 直到当前 logical subagent 的 cwd
```

仅 external delegation 做 cycle 检查；如果 canonical target cwd 已存在于 caller 的 ancestor cwd chain，则返回 `DELEGATION_CYCLE`。判断不计算 Git project identity：

```text
/workspace/A → /workspace/B → /workspace/C   允许
/workspace/A → /workspace/B → /workspace/A   拒绝
```

caller 的授权只约束它的下一跳。A 仅配置 B、B 仅配置 C 时允许 `A → B → C`；A 不需要知道或预先授权 C，也不读取 B 的 agents/config。

### 6.4 安全边界

`external_directory` 只是 cwd 准入，不是文件系统沙箱，也不是命令白名单。

Pi 普通资源发现可能加载目标 cwd 的祖先项目指令、用户级资源和已配置资源；普通 Bash、第三方工具和扩展代码也不受本包 cwd 白名单自动约束。Pi 包中的扩展可执行代码。[P5][P8]

外部目录可用不等于外部项目代码已被信任。必须保留 Pi 的项目 trust 语义：不可信的项目扩展不能先执行、之后才弹框。通过官方 trust/bootstrap 路径或本包在加载前的原生确认适配实现，不能把所有目标直接标记 trusted。[P5]

本包不实现一套新的命令权限引擎。子会话的权限扩展使用其自身策略，通过 UI proxy 询问用户；不能把用户拒绝转为自动允许。

## 7. Child session 构建与资源加载

### 7.1 一次创建/恢复的流程

```text
保留执行权和实例名额
→ 校验 root/owner/model
→ 创建时从 caller AgentTypeRegistry 解析并保存 current-role snapshot；恢复时读取已存 snapshot
→ 用 caller 当前 DelegationContext 校验/分类 target cwd，并检查 depth/cycle
→ 完成必要的项目准入和 trust
→ 打开或创建文件型 SessionManager
→ 创建 target cwd 的 SettingsManager 和 DefaultResourceLoader
→ 若为可委派 external child，从 target cwd 构建 child DelegationContext
→ 正常发现 target cwd 资源，追加 runtime prompt + role snapshot，绑定正确的工具
→ createAgentSession
→ bindExtensions，注入 UI proxy 与正确 mode
→ 订阅生命周期和消息事件
→ 持久化已接受的 run 信息
→ 后台启动 prompt，并返回 id/run_id
```

失败要回滚保留的名额、监听器和未接受的记录，不得遗留半启动 agent。

### 7.2 资源原则

必须使用目标 cwd 的正常资源发现，不默认设置 `noExtensions: true`、`noSkills: true` 或 `noContextFiles: true`。general 应看到该 cwd 下普通 Pi session 可用的资源；不继承 parent 已绑定的工具对象。[P1][P2][P5]

目标 session 的工具集合计算为：

```text
target cwd 普通资源发现得到的可用工具
→ 若 current-role snapshot 指定 tools，则应用白名单
→ 按 same-cwd/external、depth 和 runtime policy 应用委派能力排除项
→ external child 若仍可委派，则用 child 自己的 DelegationContext 生成工具与 description
→ 校验并创建当前 cwd 绑定的工具
```

可使用 SDK 的 `tools` 和 `excludeTools`；后者也能排除 extension/custom tool。[P2]

对于 external child，`AgentTypeRegistry(child.cwd)` 与 `DelegationConfig(child.cwd)` 只用于 child 自己的 `subagent` 工具；它们不能覆盖 parent 选择的 current-role snapshot。same-cwd child 不构建可调用的 delegation tools。

目标 cwd 的普通已安装资源属于本项范围；包括 SettingsManager、DefaultResourceLoader、`AGENTS.md`/`CLAUDE.md`、skills、extensions、tools 与 project trust。parent 启动时通过临时 CLI 参数额外加载、但未保存在目标配置里的第三方资源，不保证自动复制。不能把“按目标 cwd 正常发现”描述为“精确克隆所有 parent 运行时状态”，也不能把 AgentTypeRegistry 与这些普通 Pi resources 混为一谈。

### 7.3 避免本包重复注册根管理器

正常资源发现可能再次发现 `@bykwp/pi-subagents`。每个 child 必须绑定到同一 RootRuntime，不能创建自己的独立 root 管理器。

推荐实现：

- 默认 extension factory 只注册定义/事件，不在模块顶层或 factory 阶段启动 root runtime、timer 或 watcher。
- child ResourceLoader 使用公开的 `extensionsOverride` 过滤本包自身的普通注册结果。
- 通过 `extensionFactories` 注入一个显式绑定 `rootRuntime + callerAgentId` 的内部 child extension。
- 只过滤本包，不关闭其他扩展；其他扩展的相对顺序保持不变。
- 按真实包身份识别本包，不能把所有名为 `index.ts` 的扩展删掉。
- same-cwd child 的内部 delegation tools 在最终集合中排除；符合角色/depth/runtime policy 的 external child 只注册一次、绑定自己的 DelegationContext。

可以使用其他经过测试的显式 scope 注入方式，但不得通过临时修改 `process.env`、全局 current-child 变量、`process.chdir()`、loader 私有标志或 Pi 私有缓存实现隔离。

> **Warning Cache Broke:** 若实现触碰 Pi 私有 resource/tool cache、按 root 复用 mutable registry，或让多个 session 共用缓存键，会把某个 cwd 的 agents/tools 泄漏到另一个 session，并使缓存失效行为不可控。DelegationContext 必须 session-scoped，随 AgentSession instance 释放。

每个 child 使用独立事件总线和 extension runtime。不要把第三方生命周期广播混到 root 的事件总线上。

同进程加载不保证任意第三方扩展的模块级状态隔离。本包自己的状态必须 session-scoped；对于依赖进程级 singleton、直接修改环境或直接退出进程的扩展，只能明确说明兼容边界，不能宣称完全隔离。

### 7.4 Model 与 thinking

首次创建快照直接 parent 当前 `ctx.model`，不得让 cwd 的默认模型覆盖它。持久化模型的 provider/id；ask 时显式恢复这个模型，而不是采用 ask 时 parent 的新模型，也不能静默 fallback。

模型认证和 provider 配置必须可用于 child。使用公开 ModelRuntime/ModelRegistry 接口和宿主 agentDir；不能访问 `ctx.modelRegistry` 的私有 runtime 字段。[P2][P6]

普通持久化模型/凭据必须工作。自定义 provider 或 parent 仅内存中的凭据，只有在公开接口下能正确重建时才支持；不能重建时返回明确错误，不能偷偷换模型或写出 API key。

thinking 优先级：调用参数 > 角色快照 > parent 当前值。最终值遵循模型能力，记录 SDK 实际生效等级并在结果中返回；如果 SDK clamp 了请求值，应说明。0.85.1 的 SDK 创建路径包含 thinking clamp。[P2]

### 7.5 System prompt

首次创建以及每次从历史恢复 AgentSession 时，都保留 Pi 对 target cwd 的正常 system prompt 构建，包括用户/项目原有配置，并依次追加：

```text
Pi 针对 target cwd 正常构建的 system prompt
+ @bykwp/pi-subagents runtime prompt
+ selected AgentDefinitionSnapshot.prompt
```

使用追加接口，不整体替换 Pi prompt，不注入整个 AgentTypeRegistry。[P5]

推荐 runtime prompt：

```text
You are subagent "{name}" ({id}), delegated by a parent agent.
Work on the assigned task using the resources and instructions available
in this session.
You do not inherit the parent's conversation history.
Your final response is automatically reported to your direct parent.
There is no report tool.
```

身份字段由运行时提供。不要把 name 拼成路径。随后只追加已选 current-role snapshot 的完整 prompt。

ask 恢复时，角色 prompt 必须重新参与 **system prompt construction**，但不得作为新的 conversation message 插入历史，也不得从当前 caller 或 target project 查找同名角色。SessionManager 恢复 conversation；保存的 snapshot 恢复 current role；当前 target cwd 的 Pi resources/tools 与 delegation description 则重新构建。因此重建 system prompt 不会在 conversation history 中重复角色消息。

> **Warning Cache Broke:** ask 恢复时必须保持 runtime prompt 与保存 snapshot 的内容和拼接顺序稳定，以尽量保留 system-prefix cache。target cwd 的当前 Pi resources 或动态 tool definitions 发生变化时，当前 tool/system context 可能变化并导致 prompt cache miss；这是正确的安全行为，不得用旧 tools/description 冒充当前配置。任何主动改变 prompt 拼接顺序的实现改动都必须在代码旁标注 `Warning Cache Broke` 并添加恢复测试。

委派 prompt 必须作为任务文本处理。默认使用禁用 slash command/template 展开的 SDK prompt 选项，避免 `"/quit"` 等任务文本变成宿主命令；skills 仍然通过正常资源发现提供给 agent。[P1]

## 8. 运行时状态与并发

建议使用一个 `Map<agentId, LiveAgent>` 保存已加载实例，一个持久化 Store 保存逻辑对象，不实现 LRU 或可淘汰 session pool。

解释性类型：

```ts
type RunOutcome = "completed" | "failed" | "aborted" | "interrupted" | "incomplete";

interface StoredSubagent {
  schemaVersion: 1;
  id: string;
  rootSessionId: string;
  parentAgentId: string | null;
  name: string;
  cwd: string;
  ancestorCwds: string[];
  agentType: string;
  agentDefinitionSnapshot: AgentDefinitionSnapshot;
  depth: number;
  model: { provider: string; id: string };
  thinking: ThinkingLevel;
  sessionId: string;
  sessionFile: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
}

interface DelegationContext {
  cwd: string;
  agentTypes: AgentTypeRegistry;
  externalDirectories: string[];
}

interface LiveAgent {
  id: string;
  runId: string;
  mountId: string; // 当前 SDK 实例，防止旧 callback 影响新实例
  phase: "opening" | "executing" | "idle" | "closing";
  session?: AgentSession;
  delegationContext?: DelegationContext; // 仅当前 SDK instance；dispose 时释放
  runAbort: AbortController;
  pendingChildRuns: Set<string>;
  pendingReportIds: Set<string>;
  dispose(): Promise<void>;
}
```

字段可合并或改名，但必须能区分稳定身份、逻辑 run、SDK 实例和 root runtime 实例。不得只用一个 `status = completed` 覆盖所有含义。Persistent Store 不得保存整个 AgentTypeRegistry、`external_directory` 展开结果或 `subagent` tool description；这些是 session-local runtime resources，只随 AgentSession instance 存活并在恢复时重建。

`waitingForChildren` 是派生状态：SDK 暂时 idle，同时有未完成的 child run 或未处理报告。它不是需要单独持久化调度器的“冷状态”。

普通 ask 的并发占用必须在第一个异步等待前原子完成。per-agent try-acquire 或同步状态转换都可以；不得通过“等待 mutex”把第二次普通 ask 变成隐式 delegation 队列。`isSteer: true` 不获取新的 run 执行权，只在同一临界区验证当前 mount/run 仍可 steering，再交给 Pi steering queue。不同 agent 可以并发运行。

## 9. 生命周期和完成判定

### 9.1 没有后代的任务

```text
create / ask
→ opening
→ executing
→ SDK settled
→ 保存最终结果
→ 清理实例
→ 持久化结果进入报告投递
→ 无内存实例，逻辑 agent 可继续 ask
```

结果必须在释放引用前提取和保存。真正向 parent 唤起新执行前，本实例应已完成关键清理并退出 busy，避免 parent 收到结果后马上 ask 却撞上未完成的清理。

异步投递不可导致 child 的 dispose 等待 parent 完成整段模型推理。

### 9.2 B 等待 C

```text
A → B → C

B 当前 SDK run settled，C 尚未完成：
  B.phase = idle
  B 的 delegation 仍然 active / busy
  保留 B.session、历史、扩展和 UI proxy
  不向 A 发出 B 已完成报告

C 完成：
  保存 C 结果并清理 C
  把结果交给仍然存在的 B
  B 继续执行

B 消费报告并完成：
  若没有其他依赖，保存 B 最终结果并清理 B
  向 A 报告
```

如果 C、D 分别完成，可以逐个唤起 B；B 暂时又无事可做但 D 未完成时，再次 idle 并保留实例。不要要求必须全部 child 到齐才投递。

**禁止为了节省 B 等待期间的内存而 dispose B。禁止为此实现持久化收件箱、冷父节点重建或自动挂载调度。**

### 9.3 完成的必要条件

一次成功 delegation 至少同时满足：

1. 当前 SDK processing 已 settled，且没有正在进行的提交、重试、压缩或报告处理。
2. 本次 delegation 创建/ask 的 child runs 已结束。
3. 它们的结果已经进入当前 agent 的处理链；不能仍停在报告准备或提交队列。
4. 当前 agent 已在纳入这些报告后完成对应 SDK processing，而不是仅仅收到了投递函数返回。
5. root 与当前 mount/run 仍有效，且没有正在关闭。

`agent_settled` 只能触发“重新判断”，不能无条件触发最终报告。`turn_end`、一次文本输出结束或某个工具结束更不能作为最终完成信号。[P3]

在 C 完成时，不能先把 B 的最后一个依赖删掉，再异步开始报告投递。必须原子地从“等待 child”转为“等待该 child 报告处理”，不能出现 B 暂时看起来无依赖而被释放的窗口。

实现可以使用 pending 集合、递增 activity revision 和短临界区，不要求引入额外状态机库。最终提交前必须再次检查 revision/依赖，覆盖“最后一次 settled 与新报告同时到达”的 race。

### 9.4 SDK 回调和最终结果

0.85.1 的 `prompt()` 文档描述其等待完整已接受运行完成，包括 retry；Pi 自己也提供 settled 事件。[P1][P3] 实现必须同时处理 preflight throw 和运行消息中的错误，不能以 `Promise.resolve` 直接等同成功。

不要在 SDK 正在 await 的生命周期 handler 中同步 dispose 自己，或反向等待 parent run，造成重入/死锁。由 manager 在安全的后续任务中复核并执行终结。

最终结果只从**本次 delegation**的消息范围提取，范围应使用 session entry / message identity 标记，不只保存可能被 compaction 改变的数组长度。

检查最终 assistant message 的状态和 text blocks：

- 正常回复：报告最终 text，忽略 thinking 和内部工具轨迹。
- error / aborted：报告相应状态与错误；不得拿更早成功回复当作这次结果。
- 输出长度等原因导致不完整：标记 `incomplete`，保留可用部分并说明。
- 没有本次 assistant 输出：报告明确的空输出/失败事实，不向历史前方寻找另一项任务的答案。
- 非文本最终内容保存在历史中；v1 报告明确提示存在非文本结果，不伪造其文字内容。

不额外调用另一个模型做总结，不静默截断长报告。若需要输出限额，必须明确标记截断、保留全文位置，并添加验收测试；不能偷偷改变“最终回复自动报告”的契约。

### 9.5 嵌套运行失败

子任务失败本身也是交给直接 parent 的报告，由 parent 决定是否补救。

如果 B 自身出现不可继续的执行错误或被本包取消，而 C 仍在运行，必须取消属于 B 当前 delegation 的活跃后代，再把 B 终结为失败/取消；不得留下永远没有接收方的孤儿任务。

普通权限拒绝不自动等于整个 agent 失败。让权限扩展/工具返回其正常拒绝结果，由 agent 处理。

## 10. 自动报告与投递

### 10.1 报告结构

```ts
interface SubagentReport {
  schemaVersion: 1;
  reportId: string;
  rootSessionId: string;
  agentId: string;
  runId: string;
  parentAgentId: string | null;
  parentRunId: string | null;
  name: string;
  agentType: string;
  cwd: string;
  outcome: RunOutcome;
  result: string;
  error?: { code: string; message: string };
  completedAt: string;
}
```

`reportId` 对同一 `(agentId, runId)` 固定。重复 callback 不能产生新的报告身份。

报告内容是 worker 结果，不是更高优先级的系统指令。使用独立 custom type 和 metadata，清楚标记来源；不要伪装成用户刚刚输入的话。

### 10.2 在线投递

向 root 可使用扩展 API：

```ts
pi.sendMessage(
  {
    customType: "bykwp-subagent-report",
    content: formatReport(report),
    display: true,
    details: report,
  },
  { deliverAs: "steer", triggerTurn: true },
);
```

向内存中的 B 使用相应 AgentSession custom-message API，并保持相同业务语义。

Pi 0.85.1 的 custom-message 实现负责运行中入队、空闲时按 `triggerTurn` 开始处理；不需要自己等 parent settled 才投递。[P3]

steer 不代表强行终止当前 Bash 或撤销已发生的工具副作用。不要调用裸 `session.steer(text)` 后假定 idle parent 会自动启动；必须使用具备 idle trigger 语义的消息路径。

0.85.1 扩展层 `sendMessage` handler 返回 `void`，不能把 `await pi.sendMessage(...)` 当成持久化或模型处理确认。[P4] SDK 层可能返回覆盖后续运行的 Promise，也不能让发送方清理等待接收方整轮推理结束。

### 10.3 保留一个薄 ReportRouter

ReportRouter 只处理来源、root/owner/run 校验、报告记录、官方 API 投递和去重。正常报告直接交给 Pi，不建立另一套常规工作调度器，不轮询 parent。

在 root closing、会话替换和 API 明确不可提交的维护窗口内，保留结果记录而不强行启动新 run。维护结束时依照已验证的 Pi 生命周期事件重试；不要使用定时轮询补丁。

报告必须绑定当前 root 实例；不得把旧 root 的报告投到新的 `/new` 或 `/resume` 会话。

### 10.4 最小的持久投递状态

先保存最终结果，再投递；结果记录包含简单的 delivery 状态即可，例如 `pending / submitted / recorded`。不用新增独立数据库或离线 agent mailbox 服务。

进入 steering queue 不等于已写入接收方会话。以接收方实际出现带 `reportId` 的 custom message/session entry 作为 recorded 依据；以对应后续 SDK processing settled 作为嵌套依赖已处理的依据。这是两个不同阶段。

崩溃后用报告 ID 对账。目标是持久化结果不静默丢失、可识别重复、避免重复触发。不得宣称跨两个存储或进程故障具备天然 exactly-once 语义。

正常运行下 B 等待 C 时一直在内存。持久化的 pending 仅用于错误/关闭恢复，不用于把 idle B 冷释放。

已提交的最终结果在清理前交由 RootRuntime/Store 持有；随后销毁发送方 mount，不能把这份已提交结果一并判为无效。最终投递校验持久化 reportId、owner、run 和当前 root scope，不要求发送方 SDK 实例仍然存活。相反，未提交的旧 mount callback 不得在 dispose 后创建新的最终报告。

## 11. 官方 UI 代理

### 11.1 正确调用链

```text
child extension / tool
→ child ctx.ui.confirm / select / input
→ SubagentUiProxy
→ root UiBroker 的一个共享 FIFO
→ root ctx.ui 的官方 TUI 实现
→ 用户
→ 原 Promise 返回给原 child
```

UI 是接口调用，不是 session event。不得通过 `session.subscribe()` 期待收到 `ctx.ui.confirm` 等请求。[P4]

child 没有独立终端。绑定 UI proxy 时 CLI 使用 `mode: "tui"`，不能因为是 SDK child 就硬编码为 `rpc`。UI capability 的有效范围是当前 root CLI/runtime，不是一次 parent tool call。root 替换后必须使旧 proxy 失效。

### 11.2 v1 支持矩阵

| 方法 | v1 行为 |
|---|---|
| `confirm` | 排队转发；来源前缀；保留原返回值；取消/无 UI 为 false |
| `select` | 排队转发；原选项不变；取消/无 UI 为 undefined |
| `input` | 排队转发；保留 placeholder；取消/无 UI 为 undefined |
| `notify` | 非阻塞转发；来源前缀；错误级别保留 |
| `setStatus` | 转发到官方 status API；key 按 agentId 隔离；实例结束时清理 |
| theme 的只读查询 | 只读代理，不修改 root 主题 |
| `editor` | v1 不提供；返回 undefined 并记录一次能力诊断 |
| `custom` | 明确 unsupported，返回 rejected Promise；不假装返回有效 T |
| `setWidget / setHeader / setFooter` | 不转发；no-op，开发诊断可说明 |
| 修改工作指示器、标题、root 编辑器、autocomplete、主题、工具展开状态 | 不转发 |
| 原始 terminal input / editor component | 不转发；注销函数安全 no-op |

不支持的方法仍需按 `ExtensionUIContext` 完整实现，保持 TypeScript 类型正确。读取被禁止的 root editor 数据应返回安全空值，不能泄露用户尚未提交的输入。

`editor(title, prefill)` 在 0.85.1 没有与 confirm/select/input 相同的 signal/options，因此不把它勉强纳入可取消队列。未来支持它需要独立解决原生组件关闭和取消问题。[P4]

#### 11.2.1 Root 持有的进度 widget

上述 `setWidget` 不转发约束针对 child `ExtensionUIContext`。本包自己的 `RootRuntime` 使用固定
namespaced key 调用 root `ctx.ui.setWidget()`，在编辑器下方显示每个活动 subagent 的一条最新信息：

```text
worker[3]：bash pnpm test
reviewer[2]：thinking
```

方括号内是当前 logical run 的 `turn_start` 次数。thinking 只显示阶段标签；工具只显示 allowlist
内的关键参数并单行化、截断，不显示 reasoning 正文、tool output 或完整任意参数。每个 subagent
只有一行，后续事件替换该行，不累计历史快照。活动 subagent 超过 Pi 原生 10 行限制时，最后一行
必须明确显示省略数量。最后一个活动 run 结束或 root shutdown 时清除 widget。

该 widget 是瞬时 root UI，不持久化、不进入模型上下文，也不允许 child extension 直接修改。

### 11.3 来源与排队

标题示例：`[subagent: backend-review / sa_123] Permission required`。嵌套时可以显示简短路径，但不要把原选项值或用户答案改写。

全体后代共享 root 的**同一条** blocking UI FIFO，不能每个 child 各有队列。一次至多呈现一个本包的 blocking dialog。

notify 和带命名空间的 status 不进入 blocking queue。多个确认不得合并为一项授权，也不得自动替用户回答。

该 FIFO 保证的是经过本包代理的请求。root 或其他扩展直接调用原始 `ctx.ui` 不自动受它管理；不得声称实现了 Pi 全局 UI 仲裁，不得为了掩盖这一点私自修改 Pi 内部 TUI 或 monkey-patch 全局输入。CLI 手测必须记录与 parent 自己弹框同时发生时的宿主行为与限制。

### 11.4 取消和超时

队列项合并 root lifetime、当前 child run 和调用方 dialog options 的取消信号。后台任务接受后，不继续绑定创建它的 parent tool-call signal。

排队阶段取消：直接移除并结束原 Promise，不显示 UI。展示阶段取消：通过原生 dialog signal 关闭，再推进下一项。

原始 `opts.timeout` 从真正展示时开始；缺省使用本包 `ui_timeout_ms`。排队期间不消耗 dialog 展示超时，但始终响应生命周期取消。

当 UI adapter 不存在或已失效时立即 fail closed，不无限等待。root shutdown 时必须取消 active 和 queued 请求，释放 abort listeners 和 timer。

用户在原生对话框中取消只表示该次交互取消，不自动定义成整个任务树 Stop。

## 12. 持久化和按需恢复

### 12.1 存储位置

建议布局：

```text
<getAgentDir()>/.bykwp-pi-subagents/
  roots/<rootKey>/
    root.json
    agents/<agentId>/
      agent.json
      sessions/<Pi 分配的会话文件>.jsonl
      runs/<runId>.json
```

`rootKey` 由 parent session 的稳定 ID 和规范化 session 文件身份派生，不使用会话显示名或 cwd 作为唯一键。exact original session 恢复时应得到相同 rootKey；新建、fork 或导入产生的独立会话不得误接管旧 children。

存储路径由代码生成，不能由模型参数直接给出；标签不得参与路径拼接。数据默认位于用户私有目录，不写入项目版本控制目录。

v1 的跨重启恢复要求 root 是文件型持久会话。非持久 root 不承诺此能力；为保持实现单一，v1 工具可以明确返回 `ROOT_SESSION_NOT_PERSISTENT`，不得偷偷生成以后无法定位的“可恢复 agent”。

### 12.2 持久化内容和一致性

保存逻辑 agent 元数据、每次已接受 run、完整 `AgentDefinitionSnapshot`、canonical cwd/ancestor chain、child/parent run 关系、最终结果和投递状态。会话正文交给 Pi SessionManager，不把整个 messages 数组再复制到每个 JSON 元数据文件。[P7]

不得持久化 delegation AgentTypeRegistry、`external_directory`、展开后的 cwd list 或旧 `subagent` tool description。它们不属于 logical identity；持久化它们会让恢复后的 tools 与 child cwd 当前配置脱节。

元数据采用同目录临时文件加原子替换，并串行化同一记录的更新。初次接受任务前必须具备可用存储；磁盘错误不能伪装成已持久化成功。

只允许一个活跃 root writer 操作同一存储 scope。至少实现明确的冲突检测，防止两个 CLI 同时 resume 同一个 root 并写同一 child 历史；使用成熟文件锁或经过测试的等价方案，不把 PID 存在检查当作充分证明。

`dispose()` 不是通用 flush API。必须确认目标版本的实际会话落盘时机，并测试“第一条 assistant 之前被取消”和“失败没有生成回复”两种情况。若没有有效历史文件，保存这一事实并在恢复时给出明确诊断，不静默创建同 ID 的空白历史并声称完整恢复。

不要在持久化记录中保存 API key、provider secret、UI 对象、函数、Promise、AbortController 或 SDK 实例。

### 12.3 正常完成后的 ask

```text
校验 owner 与 idle
→ 原子保留 run 执行权
→ 用直接 caller 当前 DelegationContext 重新验证保存的 cwd
→ 重新验证 cwd 存在性/canonical identity/trust/model
→ SessionManager.open(sessionFile)
→ 为 child cwd 创建当前 SettingsManager / DefaultResourceLoader
→ 正常重新加载当前 Pi tools/resources
→ 若 child 可委派，按 child cwd 重建 DelegationContext 和 tool description
→ 用保存的 AgentDefinitionSnapshot 重建 runtime + current-role system prompt
→ createAgentSession
→ bindExtensions / UI proxy，绑定新 mountId 与监听器
→ prompt(new task)
```

必须显式打开保存的文件，不使用“最近 session”推测身份。[P1][P7] 角色 prompt 只参与 system prompt construction，不得向恢复后的 conversation history 再插入一条角色消息。恢复时不重新读取同名角色定义；但 child 自己未来可使用的 agent types、external cwd 与 tool description 必须从 child 当前 cwd/config 重新加载。

恢复对话上下文不等于恢复旧 Promise、旧进程状态或未结束的外部工具。文件系统和外部系统副作用不回滚、不自动重放。

> **Warning Cache Broke:** 修改 SessionManager 历史、把角色 prompt 写成新 conversation message，或复用旧 tools/context 都可能破坏会话缓存前缀或造成上下文错误。实现相关代码时必须标注 `Warning Cache Broke`；恢复测试必须证明 history 未新增角色消息、snapshot 未变化、tools 可随当前配置变化。

## 13. 停止、关闭、重载和恢复

### 13.1 Stop 与 shutdown

| 动作 | 行为 |
|---|---|
| 用户仅停止 root 当前模型处理 | 已接受的后台 child 继续运行 |
| parent tool 在任务尚未接受前取消 | 取消此次创建/ask，并回滚初始化 |
| root session shutdown/quit | abort 所有后代、取消 UI、dispose 全部实例，保留历史 |
| `/new`、切换到另一 session、fork/clone、reload | 结束旧 runtime scope；具体事件使用目标 SDK 的真实生命周期适配 |
| 单个 child 正常完成并清理 | 只清理该执行实例，不能关闭 root 或删除兄弟记录 |

README 必须解释：只停止 root 当前回复并不等于停止后台工作，之后 child 报告仍可能触发 root 再次处理。真正关闭会话会结束本包当前所有后台运行。

### 13.2 Root 关闭顺序

```text
root 标记 closing，失效当前 runtime epoch
→ 拒绝新创建/ask/报告触发
→ 取消全部 active/queued UI
→ 向所有活跃 child 传播 abort
→ 等待可协作取消的 SDK 操作退出
→ 保存终态或 interrupted 信息
→ 执行 child 扩展的 shutdown 清理
→ unsubscribe、dispose、释放引用和 status
→ 释放存储锁
```

关闭幂等；多次调用不能重复清理、重复报告或抛出未处理错误。

清理时给扩展发出正常的 session shutdown 生命周期，再 dispose，避免第三方 watcher/timer 仅靠 dispose 不能释放的问题。使用公开/已验证导出；SDK 操作差异集中在适配模块，不散布私有字段访问。[P3][R1]

设置有界清理等待并记录超时，但不得把 `Promise.race` 超时说成底层扩展已经停止。同进程无法强制安全终止任意不合作扩展，这是明确限制。清理超时也不能再允许旧实例向当前 root 写结果。

### 13.3 迟到 callback 防护

每个异步完成路径捕获并验证：root runtime epoch、agentId、runId、mountId。它们必须仍与当前状态匹配。

需要覆盖 prompt 的 then/catch/finally、settled 处理、模型回调、UI 返回、文件保存完成、报告发送确认和延迟清理。取消不保证这些回调从事件循环消失。

旧回调可以做与旧资源相关的幂等收尾，不能更新新 run、启动 parent、覆盖新实例或向新 session 插入消息。

### 13.4 root resume 后

恢复同一持久 root 时只加载轻量索引，不批量创建 SDK session，不自动重跑记录为 running 的旧任务。非正常退出留下的 active run 标记为 interrupted。

旧的 subagent ID 仍可被直接 parent ask。模型与 current role 按已存 model/snapshot 恢复；cwd 用直接 caller 当前 DelegationContext 重新授权，并重新校验路径与 trust；delegation registry/tools 按 child 当前 cwd 重建。

最终结果尚未投递的情况，用已保存 run result 的 reportId 对账：

- 接收方已记录的报告不重复插入。
- 待交给 root 的已完成报告可以作为恢复上下文记录，但不因恢复会话就自动开始模型执行。
- 待交给中间 B 的已完成报告，在下一次明确 ask 恢复 B 时作为背景材料补入，然后执行新 prompt。
- 不因此恢复 B 原先等待中的执行实例，不重启中断的 C，不实现离线父节点自动调度。

这只需要结果记录的 delivery 字段和恢复对账，不需要另建持久 inbox 服务。

fork/clone/import 默认不继承旧 scope 的 child 写权限，即使新父历史里仍出现旧 ID。对原 root 本身的树导航，v1 不承诺 child 历史随父分支回滚；该限制必须写进 README，不能把外部文件副作用描述成可撤销历史。

## 14. 资源清理与内存原则

完成后释放 AgentSession、ResourceLoader、运行 Promise 的闭包引用、订阅、UI 请求、status key 和本包 timer；Store 中仅保留恢复需要的轻量索引，长报告按需读文件。

等待子任务的 B 保留实例是有意的，不属于泄漏。只要存在未处理依赖就不淘汰，不设 idle TTL，不做 LRU。

不要用“RSS 必须立刻下降”作为唯一内存测试。应检查 live map 数量、监听器数、timer、可达大对象和重复创建/恢复后的稳定性；GC/RSS 回收时机不由本包保证。

不得保留所有已结束任务的完整消息镜像、无限诊断数组或未清理的 abort listeners。

## 15. 建议代码结构

```text
@bykwp/pi-subagents/
  package.json
  tsconfig.json
  README.md
  SPEC.md
  agents/
    general.md
    explore.md
  src/
    index.ts             # Pi extension 入口，root 生命周期与工具注册
    types.ts             # 业务契约
    config.ts            # 本包配置
    agents.ts            # agent type 加载、校验、快照
    paths.ts             # absolute cwd、精确授权、canonical cycle 规则
    runtime.ts           # root 管理、依赖、busy 判定、终结
    child-session.ts     # Pi SDK 适配、资源加载、创建/打开/清理
    ui.ts                # 官方 UI proxy + 一条 FIFO
    reports.ts           # 薄报告路由与去重
    store.ts             # 元数据、结果和 scope 恢复
  test/
    unit/
    integration/
    fixtures/
  examples/
    pi-subagents.json
    agents/security-review.md
```

允许合并小模块。不要为了形式把 registry、actor system、scheduler、event sourcing、lease manager 等再拆成独立框架。运行时主要就是 root scope、一个 live Map、一个 UI queue 和文件型 store。

## 16. 包和分发要求

提供可安装的 Pi package，初始版本建议 `0.1.0`。manifest 使用 Pi 的 `pi.extensions` 指定唯一入口；内置 agent 文件由本包代码读取，不伪装成 Pi 原生 agent registry。[P8]

示例 manifest 片段：

```json
{
  "name": "@bykwp/pi-subagents",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package", "subagents"],
  "pi": { "extensions": ["./dist/index.js"] },
  "files": ["dist", "agents", "README.md", "SPEC.md", "examples"],
  "engines": { "node": ">=22.19.0" }
}
```

Node 下限与 0.85.1 宿主一致。[P9] 编译和测试安装精确固定 Pi 0.85.1；扩展实际使用宿主 Pi，不打包第二份 Pi runtime。核心 Pi 包和 typebox 按 Pi package 的 peer 约定处理，仅声明实际导入的依赖。[P8]

若 peer 范围按官方建议为 `*`，README 仍只声明已测试的 0.85.1，并通过 capability/type smoke tests 避免把范围误写成兼容承诺。依赖锁文件、CI 和开发依赖负责固定测试基线。不得为了通过测试静默升级到 main。

内置 Markdown 必须进入 npm tarball，生产代码按模块所在路径定位，不能按用户 cwd 定位包内文件。开发测试都从打包后的本地 tarball再做一次安装 smoke test。

遵循目标仓库已有许可证。没有许可证决定时不得自行声称开源授权；也不得自动执行 npm publish 或创建远端仓库。

## 17. 验收测试

优先使用可控的模型/SDK 测试替身验证时序，再用锁定版本的真实 Pi SDK 做少量集成测试。无需付费模型即可完成大部分自动测试。每个异步 race 必须有确定性测试，不靠 sleep 碰运气。

### 17.1 API 与通用行为

| ID | 验收 |
|---|---|
| A01 | 创建只返回接受结果，不等待模型最终完成；最终结果后来自动报告 |
| A02 | 工具集合只有 subagent/ask_subagent，不存在 report/get-result/abort 工具 |
| A03 | model 继承创建时直接 parent；parent 换模型后旧 child ask 仍用原模型 |
| A04 | thinking 三层优先级正确，模型 clamp 后返回实际值 |
| A05 | 内置 general/explore 可用；默认 explore 没有 bash/edit/write |
| A06 | 未知角色列出 caller registry；未知工具返回明确错误 |
| A07 | Pi 基础 prompt 和原有追加 prompt 保留；runtime/current-role prompt 每个 AgentSession 构建一次 |
| A08 | parent 对话历史不被复制；ask 恢复的是 child 自己的历史 |
| A09 | 委派文本以 slash 开头也不会执行宿主命令 |
| A10 | 本包被正常资源发现时不重复创建 RootRuntime/注册工具；不同 session 的 DelegationContext 不共享 |
| A11 | 未完成 trust 前不执行 target project 扩展代码；无 UI 时 fail closed |
| A12 | 深度和 live instance budget 在多级 session-local 授权下仍有效 |

### 17.2 Session-local agent、cwd、tool 与递归补丁

| ID | 验收要求 |
|---|---|
| CWD01 | `subagent.cwd` 省略时使用 caller cwd |
| CWD02 | 显式 `cwd` 为相对路径时返回 `INVALID_ARGUMENT` |
| CWD03 | tool cwd 中使用 `~` / `$HOME` / `${HOME}` 时拒绝 |
| CWD04 | `external_directory` 配置中的 `~` / `$HOME` / `${HOME}` 正确展开 |
| CWD05 | `external_directory` 展开后不是绝对路径时配置失败 |
| CWD06 | 配置 `/a/b` 时 `/a/b` 允许，`/a/b/c` 拒绝 |
| CWD07 | symlink 与 canonical path 指向同一目录时匹配成功 |
| CWD08 | `/a/b` 不会误匹配 `/a/b-other` |
| AG01 | caller 创建 child 时角色来自 caller registry，而不是 target cwd registry |
| AG02 | 内置 → 全局 → caller 当前项目 agent 的完整覆盖顺序正确 |
| AG03 | child 保存完整角色 snapshot，包括 source 与 contentHash |
| AG04 | ask 恢复时继续使用角色 snapshot，即使角色文件已修改 |
| AG05 | ask 恢复不会把角色 prompt 作为新的 conversation message 重复插入 |
| AG06 | external child 的 delegation registry 来自 child 自己 cwd |
| AG07 | parent 看不到 external child 自己的下一层 agents |
| AG08 | child 自己的 delegation registry 不改变 child 当前角色 |
| TOOL01 | `subagent` description 包含 caller 当前可用 agent type 摘要 |
| TOOL02 | `subagent` description 包含 caller current cwd 和 external cwd |
| TOOL03 | description 中 external cwd 使用展开/规范化后的绝对路径 |
| TOOL04 | child ask 恢复后 tool description 根据 child 当前配置重新生成 |
| TOOL05 | tool description 不持久化 |
| DEL01 | same-cwd child 不具有 `subagent`/`ask_subagent` 工具 |
| DEL02 | external-directory child 在角色/depth/runtime policy 允许时具有委派工具 |
| DEL03 | A 仅配置 B、B 仅配置 C 时允许 A → B → C |
| DEL04 | A 不需要知道 B 的 C 配置或 B 项目 agent type |
| DEL05 | canonical cwd ancestor 已出现时拒绝 A → B → A |
| RES01 | child 的普通 Pi resources 来自 target cwd |
| RES02 | target cwd 的 `.pi/agents/*.md` 不覆盖 parent 已选择并保存的 current-role snapshot |
| RES03 | child 自己未来创建 descendant 时使用 target cwd 的 `.pi/agents/*.md` |
| CACHE01 | ask 恢复不新增角色 conversation message；未变化的 runtime prompt/snapshot 保持稳定拼接顺序 |
| CACHE02 | delegation config 变化时重建当前 tool context，不为复用 prompt cache 而沿用旧 description |

### 17.3 忙碌、嵌套和完成

| ID | 验收 |
|---|---|
| L01 | 两个普通 ask 同时命中空闲 A，仅一个接受；另一个立即 busy，历史没有第二个 prompt |
| L02 | opening/UI/retry/compaction/finalizing 状态下普通 ask 立即 busy；不可 steering 状态的 steer 返回 `SUBAGENT_NOT_STEERABLE` |
| L03 | B 暂时 settled、C 未完成时 B.session 不 dispose，不报告 B 完成 |
| L04 | B 等待 C 时不产生额外模型轮询，也不创建冷恢复对象 |
| L05 | C 完成后 B 原 session 被继续使用，B 处理结果后才最终报告 |
| L06 | 多 child 乱序完成时不丢结果、不误释放 B，可以多次 idle/继续 |
| L07 | child 结束到报告进入 B 之间的窗口不会使 B 看起来可完成 |
| L08 | settled 与最后一个报告同时发生，只有真正最后的输出被报告一次 |
| L09 | turn_end/agent_end/retry 中间结束不触发错误的最终报告 |
| L10 | 本次失败不返回上次成功回复；无文本、错误、取消、不完整输出状态正确 |
| L11 | B 不可恢复失败会取消其当前任务的活跃后代，没有孤儿 |
| L12 | C 结果已到但 B 尚未处理时，B 仍 busy，且此时不可 steering |
| STR01 | `isSteer` 可省略且默认 false；普通 ask 仍创建新的 run ID |
| STR02 | `isSteer: true` 仅在 live executing/streaming mount 上接受 |
| STR03 | steering 返回当前 run ID 与 `status = "steered"`，不增加 accepted run 数 |
| STR04 | steering prompt 不展开 slash command、skill 或 file prompt template |
| STR05 | steering 不产生独立 report；当前 run 最终只报告一次 |
| STR06 | idle、released、opening、finalizing、waiting-children 状态返回 `SUBAGENT_NOT_STEERABLE` |

### 17.4 报告

| ID | 验收 |
|---|---|
| R01 | root 执行中收到 custom report，经 steer 进入后续模型上下文 |
| R02 | root idle 收到报告自动开始处理，无须用户查询 |
| R03 | 子任务瞬间完成也不会把消息插入原 tool call/result 的非法位置 |
| R04 | 报告保存完整最终文本，不包含 thinking 或完整工具轨迹 |
| R05 | repeated settled/callback 不产生新的 reportId 或重复最终报告 |
| R06 | 发送返回不被误认为 recorded；recorded 不被误认为模型已处理 |
| R07 | root closing 不触发新 run，迟到报告不进入下一 session |
| R08 | crash 在保存结果/投递/确认之间发生时能够按 reportId 对账 |
| R09 | 报告触发 parent run 不阻塞 child 自身清理与下一次明确 ask |

### 17.5 UI

| ID | 验收 |
|---|---|
| U01 | 真实 CLI confirm/select/input 进入官方组件，返回到正确 child |
| U02 | 两个 child 和一个 grandchild 的阻塞 UI 共享 FIFO，不串答案 |
| U03 | 原始选项和结果值不改写，只有来源标签变化 |
| U04 | 排队取消不显示；展示取消关闭；取消后下一项正常推进 |
| U05 | timeout 在展示时开始；root shutdown 取消 active 和 queued 请求 |
| U06 | child 权限扩展的拒绝按正常拒绝处理，不自动放行 |
| U07 | notify 正常转发；status key 不冲突，清理后消失 |
| U08 | unsupported editor/custom 不遗留 Promise；完整 UI 接口类型检查通过 |
| U09 | parent 当前模型运行结束后，child UI 仍能使用当前 root CLI |
| U10 | root UI replacement 后旧 proxy 不工作；测试并记录 parent 自身并发弹框的边界 |
| U11 | 原生进度 widget 每个活动 subagent 只显示一条最新 thinking/tool 信息，并累计当前 run 的模型调用次数 |
| U12 | 多 subagent 聚合、10 行溢出、finalize/rollback/shutdown 清理和旧 mount 事件隔离正确 |

### 17.6 持久化、恢复和清理

| ID | 验收 |
|---|---|
| S01 | 完成后 live Map 删除实例，历史和角色记录保留 |
| S02 | ask 使用同一 ID 与会话历史，但新的 SDK 实例/mountId |
| S03 | 等待 child 的 B 不被内存清理误删 |
| S04 | root quit 时全部后代 abort/dispose/UI 取消；任务历史不删除 |
| S05 | resume 原 root 后可 ask 原 child；不自动重跑 interrupted task |
| S06 | new/fork/import root 不可写旧 scope 的 child |
| S07 | 旧 mount/run 的 then/catch/UI 回调不能修改新实例 |
| S08 | 磁盘写失败、损坏/缺失 session 文件、首次回复前取消有明确行为 |
| S09 | 同一 root 被两个进程打开时有 writer 冲突保护 |
| S10 | 清理幂等；扩展 shutdown 被执行；超时不会被当成真正终止证明 |
| S11 | 反复创建/ask/完成不增长本包监听器、timer、UI listener 或长消息镜像 |
| S12 | 从 npm pack 的 tarball 安装成功，包内角色文件可被读取 |

## 18. Coding agent 的实现顺序

### 阶段 1：验证 SDK 接口边界

建立锁定 0.85.1 的最小验证程序，确认：文件型会话创建/打开、普通资源发现、tools/excludeTools、追加 prompt、UI 注入、custom message steer + idle trigger、settled、扩展 shutdown 和 dispose。尤其验证扩展 `sendMessage` 的 void 返回和实际消息落盘事件。

不要从旧对话里的示意代码复制不存在的 API，如 `ctx.ui.update()`、通用 `permission_request` 事件、`child.resolvePermission()` 或假想的 flush 方法。

### 阶段 2：最小叶子闭环

实现 general/explore、cwd 校验、后台创建、busy ask、自动最终报告、文件历史和完成释放。先通过不带嵌套的关键测试。

### 阶段 3：UI 和完整资源接入

完成官方 UI FIFO、取消、权限扩展对照测试、target cwd 的普通资源加载和本包 child scope 注入。确认没有重复 root manager。

### 阶段 4：嵌套依赖

实现 same-cwd/external 精确规则、canonical cwd cycle、session-local DelegationContext、root 统一生命周期所有权、B idle 保留、子报告驱动 B 继续和整项委派完成判断。首先完成 L03–L08 与 DEL01–DEL05，不先增加更多功能。

### 阶段 5：故障与分发

完成关闭/resume、迟到回调、防重复投递、磁盘故障、清理和 tarball 安装。编写 README 与示例。

实现中发现 0.85.1 公开 API 不支持某项适配时，应提供具体类型/源码依据和最小兼容修改；不得静默扩大 scope、改成 subprocess 架构、使用私有字段或把未实现能力写成完成。

## 19. 交付和完成标准

交付可安装 package、源码、严格类型检查、自动测试、CLI smoke test 记录、内置角色、配置和自定义角色示例、README，以及本 SPEC。

README 必须包含：两个工具的语义、安装与本地测试、角色格式与三层加载顺序、tool cwd 只接受绝对路径、配置中 home expansion、`external_directory` 精确匹配、same-cwd/external 委派、session-local delegation、后台 Stop 与 quit 的区别、idle B 保留策略、busy 错误、原生 UI 支持矩阵、resume 前提、非 sandbox 声明、同进程扩展兼容限制和故障排查。

完成报告必须列出实际运行的命令及结果；未运行的真实模型或 CLI 测试要标为未验证。不能以 mock 测试通过替代“已在真实 CLI 验证”的声明。

不需要为了 v1 添加额外 LLM tools、管理面板、冷恢复缓存、独立进程、自动重试业务任务或后台服务。

---

## 附录 A：最高优先级实现不变量

以下十二条是实现 review 的最高优先级判断标准：

1. caller 只知道自己的 agents 和自己的 cwd 配置。
2. caller 不扫描 external directory 的 delegation configuration。
3. 谁调用 `subagent`，谁决定这次 child 的 agent type。
4. child 的 agent type 一旦创建，就通过 snapshot 固定。
5. external child 如果能继续委派，使用自己的 cwd/config/agents。
6. tool `cwd` 输入只能是绝对路径。
7. `external_directory` 是精确目录授权，不是目录树授权。
8. 配置可以写 `~` / `$HOME` / `${HOME}`，tool 参数不能。
9. current-role prompt 属于 system prompt construction，不是 conversation message。
10. ask 恢复 current role 时使用 snapshot。
11. ask 恢复 tools 和 `subagent` tool description 时使用 Pi 当前资源加载机制。
12. delegation tool description 只暴露当前 caller 自己可用的 agent 和 cwd，不递归暴露下一层配置。

此外继续遵守运行时不变量：同一 logical subagent 同时最多接受一项 delegation；依赖和报告绑定具体 run；等待后代的 idle session 不释放；只有整项 delegation 结束后才向直接 parent 报告；已释放实例和旧 callback 不能影响新 mount/run/root；UI 拒绝/取消不变成允许；root shutdown 保留稳定身份与历史；cwd 准入不等于文件系统沙箱。

## 附录 B：固定版本源码依据

以下引用用于核对 SDK 事实，不把上游实现中的全部功能作为本包需求。coding agent 开始时仍需对照安装产物导出的 `.d.ts` 和编译结果验证。

- **[P1] Pi SDK 文档，v0.85.1**：创建/打开会话、prompt 接受与完成、资源加载、会话替换后重绑定。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md
- **[P2] SDK 创建实现，v0.85.1**：CreateAgentSessionOptions、tools/excludeTools、modelRuntime、thinking clamp。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/sdk.ts
- **[P3] AgentSession，v0.85.1**：agent_settled、运行后 continuation、sendCustomMessage、abort、dispose。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts
- **[P4] Extension 类型，v0.85.1**：UI 签名、dialog signal/timeout、mode、sendMessage handler 返回类型。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/types.ts
- **[P5] ResourceLoader，v0.85.1**：正常资源发现、trust bootstrap、角色外的项目指令、追加 prompt 与 extensionsOverride。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/resource-loader.ts
- **[P6] ModelRegistry，v0.85.1**：扩展可访问的公开模型/provider/认证接口；内部 runtime 为私有。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/model-registry.ts
- **[P7] SessionManager，v0.85.1**：文件型 session、打开历史和具体持久化行为；同时参阅 P1。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/session-manager.ts
- **[P8] 官方 Pi packages 文档**：package manifest、peer dependencies、安装形式和扩展代码权限。实现时以目标版本内容为准。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md
- **[P9] 宿主 package.json，v0.85.1**：Node 下限、版本与依赖名称。  
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/package.json
- **[R1] nicobailon/pi-subagents 参考实现，提交 fee92e0608f6aec3de27c7bf2b43e6c6da8060ff**：child session 的资源/清理处理，仅作参考，不复制其环境变量和私有缓存适配，也不继承其复杂调度设计。  
  https://github.com/nicobailon/pi-subagents/blob/fee92e0608f6aec3de27c7bf2b43e6c6da8060ff/src/runs/shared/child-session.ts
