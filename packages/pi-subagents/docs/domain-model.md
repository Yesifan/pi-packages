# 领域模型（Domain Model）

> Spec 0002 原 runtime 独立复审已完成；最新私有目录修订的 typecheck、21 个文件 / 245 项测试、build 与 pack 通过，不冒充该修订已独立复审。PR #11 未合并，最终目录/discovery 直接整合进原规格。用户于 2026-10-09 接受手动 TUI/print 验收延期，Spec 0002 保持 completed；手测未运行，不宣称全部验收通过。

行为以[权威实现规格](specs/yesifan-pi-subagents-spec.md)、[Spec 0002](specs/0002-prompt-and-session-storage.md) 和 [ADR-0003](adr/0003-sdk-sessions-and-parent-metadata.md) 为准；原 Spec 0002/ADR-0003 已包含新 history 私有目录、普通发现排除与独立打开允许的最终决定。[Spec 0003](specs/0003-terminal-exit-reporting.md) 的异常退出通知扩展仍为未开始计划，不属于本文的已实现承诺。旧 project-local store、sa/run/mount/report ID、epoch 和持久 delivery 属于历史实现，不是当前不变量。

## 1. 核心实体

```text
Root Session → RootRuntime → RootScope
                              ├─ direct children: Agent
                              │    ├─ direct children: Agent
                              │    ├─ Pi history: SessionIdentity
                              │    └─ currentExecution?: Execution
                              │         ├─ AgentSession（mount）
                              │         ├─ pendingChildren: Execution
                              │         └─ pendingReports: ReportDelivery
                              ├─ online deliveries: ReportDelivery
                              ├─ shared UI FIFO / progress widget
                              └─ one whole-tree writer lock
```

### Root Session / SessionIdentity

Root Session 是整棵树的管理边界，要求 file-backed Pi session。SessionIdentity 为 Pi `sessionId` 与规范化实际绝对 `sessionFile`，二者共同派生 `sessionKey`；root 的 key 用于整树锁定位。key 不展示给模型，不是 ask 参数。复制、fork、导入或移动会话文件不会自动接管原树。

`rootProjectRoot` 只用于项目配置、trust 和资源定位，不承载 runtime store；project root 不扩大 cwd 授权。

### RootRuntime / RootScope

RootRuntime 是单一整树协调者，不是持久业务身份。RootScope 是一次 root 生命周期的内存对象，保存 children、agents、executions 和 deliveries。关闭后置 closing，不复用该 scope；通过对象身份拒绝迟到 callback，不生成 epoch。

整树共享 root 项目的 max_depth、max_live_agents、ui_timeout_ms、UI FIFO 与进度 widget。RootRuntime 不把 caller registries 或 external cwd 授权合并成全局资源。

### Agent（logical subagent）

Agent 是可跨普通 ask 和 exact root resume 保留的逻辑身份。name 去首尾空白、大小写敏感，在直接 parent 下唯一；不同 parent 可重名，完成/interrupted child 仍占名。name 不参与文件路径，不生成 sa_* ID。

固定信息为 name、直接 parent、Pi history identity 与创建时完整 roleSnapshot。创建 opening 阶段 identity 可尚未分配；cwd、depth、ancestor chain 是从历史与当前树推导的内存信息，不重复写 metadata。每个 Agent 同时最多一个 currentExecution。

### Execution / AgentSession Instance（mount）

Execution 是一次创建或普通 ask 的临时执行对象，捕获 scope、agent 和发起它的 parent Execution（root caller 捕获 RootScope）。ordinary ask 同步占用执行权后新建 Execution 与 mount，不改变 Pi history identity；busy 立即拒绝，不排队。

mount 是 Execution 当前的 Pi AgentSession，承载 target cwd 当前 resources、extensions、tools、ModelRuntime、DelegationContext 和 UI proxy。SDK settled 不等于 Execution 完成；等待 children/reports 时保留 mount，真正完成后 dispose。mount 不持久化，不生成 mount ID。

一次 Execution 可包含初始 prompt 与报告触发的多次 SDK processing。steering 仅追加到当前 streaming execution 的 Pi queue，不创建 Execution、独立报告或持久 run record。

### SubagentReport / ReportDelivery

SubagentReport 是本次在线结果信封，包含 name、保存的 role、cwd、outcome、结果、可选错误及已验证实际 history 路径。不另存结果副本或 report ID。来源后、正文前直接显示 `Complete conversation: ...` 行；历史不可用时明确说明，不展开 JSONL，不宣称它是完整 system-prompt/tool-definition 快照。

ReportDelivery 是内存中的来源、捕获 target 与提交/观察/处理状态。child 依赖同步从 pendingChildren 转入 pendingReports；nested parent 观察 custom message、核对持久 Pi entry 和后续 settled 后才解除 barrier，发送返回不等于 processed。关联使用 Pi 自有 session/entry identity，不依赖对象经过 SDK clone 后仍相等，不生成本包 report ID。root 投递沿返回 void 的宿主 sendReport，成功返回只证明 submitted，不证明 recorded/processed；成功提交后释放 scope delivery，没有本包 root parent mount finalize 依赖。处理确认持有仅适用于 nested Execution；不新增 root inbox/receipt，也不据此宣称 exactly-once。

sender 释放后 delivery 可继续存在；即使同一 Agent 的下一次 ask 已开始，旧 delivery 仍只面向原有效 parent，不改新 Execution。parent 已关闭/root scope 失效时不转交下一执行。当前通路的异常投递覆盖与诊断完善另见未实施的 Spec 0003；parent 自身失败导致 child 中断不承诺逐 child 通知。

## 2. 值对象与资源边界

- **DelegationContext**：每个 caller 的 canonical cwd、projectRoot、当前 AgentTypeRegistry 与 canonical externalDirectories。external_directory 来自 caller 项目 `.pi/subagents/setting.json`；root-only limits 由 root 项目提供。
- **AgentTypeRegistry**：内置 → `<getAgentDir()>/agents` → caller 项目 `.pi/agents`，后层同名完整覆盖。caller 选择下一层角色，不为此预读 target 的 agents/config。
- **AgentDefinitionSnapshot / CurrentRole**：创建时从 caller registry 保存的完整角色定义（prompt、description、tools/disallowedTools、默认 thinking、source/hash）。ask 不重解析同名角色；target 自己的 registry 只决定未来 descendants。角色 prompt 参与当前 system prompt construction，不作为新增 conversation message。
- **CanonicalCwd / AllowedCwdSet**：存在目录经 realpath 规范化；允许集合为 caller cwd 与 caller 当前配置中 external cwd 的精确集合，不授权子目录或路径前缀。tool cwd 只接受绝对路径；配置可展开 ~、$HOME、${HOME}。
- **Model / Thinking**：首次创建继承直接 parent 模型，thinking 为参数 > snapshot 默认 > parent 当前 > off，按模型能力 clamp。普通 ask 从 Pi history/SDK 恢复，不采用 parent 后来设置；缺少有效历史、模型不可用、鉴权失败或 SDK fallback 明确失败，不重加 metadata 副本。

same-cwd child 为叶节点；external child 仅在角色工具、depth 与 runtime policy 允许时可委派。ancestor cwd 不得重复。trust 早于项目配置/agents/resources 读取及扩展执行；external_directory 是 cwd admission，不是 filesystem sandbox。

## 3. 持久化

```text
<getAgentDir()>/subagents/
  sessions/<owner-sessionKey>.json   # 仅 owner 的直接 children
  locks/<rootKey>/                  # 一个原 root 的整树 writer lock target
  histories/<Pi 实际会话文件>.jsonl # 新 child，普通 discovery 根之外
```

ParentSessionRecord（schemaVersion 1）包含 root、owner、parent 与 name-keyed children。ChildRecord 仅含 Pi sessionId/sessionFile、完整 roleSnapshot、最新 state 与可选 hasChildren。当前实现使用 hasChildren 记录曾初始化下一层 owner，诊断已声明分支文件缺失；它不是 owned-child 索引，也不是第二份关系表。

A→B→D、A→C 时，A 文件只有 B/C，B 文件只有 D；无项目镜像、全局权威关系索引或跨文件事务。同 owner 更新串行、同目录临时文件原子替换；同步 preflight 接受提交基于已持久 opening，避免排队旧写覆盖 running。metadata 为 0600、本包目录为 0700；损坏、路径不安全、不可写、运行中删除或锁冲突明确失败，不 fallback 到旧布局。

新 child history 使用 `SessionManager.create(cwd, privateDir)`，privateDir 为 `<getAgentDir()>/subagents/histories`，SDK 不追加 cwd 分组；不应用 CLI --session-dir、PI_CODING_AGENT_SESSION_DIR 或 settings sessionDir，也不继承 root CLI override。PI_CODING_AGENT_DIR 仍决定 agentDir。私有文件权限/header 适配采用 SDK 给出的实际路径；恢复验证非空普通文件、Pi ID/header/cwd，不猜 recent。存量新 schema metadata 引用的默认目录 histories 按已保存 exact paths 恢复，不搬迁、迁移或删除，可能继续被普通 discovery 列出。

项目配置仍在 `.pi/subagents/setting.json`，缺失用默认值；配置读取不生成项目 sessions/.gitignore。旧 agents 不迁移、不兼容、不恢复；旧文件不自动删除。

## 4. 状态与接受边界

| ChildState | 含义 / 恢复 |
| --- | --- |
| opening | 本包任务未接受；进程内新 child 失败仅清本次新资源，既有 ask 恢复先前 state。重启无法区分新建/ask，保留 identity/history/name，清 prepared 为 idle。 |
| running | 已接受，含执行、等待后代/报告与终结清理；恢复变 interrupted，不自动续跑。 |
| idle | 可再次普通 ask，不等于上次成功或报告已经投递。 |
| interrupted | 未完成的已接受任务已停止；直接 parent 可明确 ask 新任务。 |

Execution phase 为 opening / executing / waiting / closing / closed；状态列表中的 running 包含正在初始化、执行、等待和清理，done 对应可再 ask。shared live usage 含初始化名额，结构化 name 保留完整可寻址值，显示标签可单行截断。

普通 prompt 仅 preflight started 接受并可靠提交 running；steering 仅 queued 返回 steered。handled 是未接受：普通清 prepared，steering 原 Execution、状态/名额不变，不 abort 原任务，不声称回滚 extension 历史或外部副作用。非预期 disposition 明确诊断，不假成功，不按纯未接受删除已变历史。

异步 input hook 等待期间需区分取消与 SDK 已排队：queued preflight 在 `_queueSteer` 后发生，已到 queued 就是不可逆接受，tool signal 即使已取消也不得返回假“未排队”或撤销原执行，应返回 steered；未排队路径重校验取消/执行归属，不把 started 冒充 steering。该竞争修正、SDK prompt 取消/报告拒绝/顺序自动测试及独立复审已完成，不代替实际交互 TUI/print 手测。

SUBAGENT_NOT_STEERABLE 解释 idle/interrupted/released/opening/waiting children/reports/closing/finalizing/SDK not streaming 等具体原因；拒绝不等于任务已停止，不修改原执行。

## 5. 核心不变量与关闭恢复

1. caller 只操作自己的直接 children；name 或 history 路径不授予跨 parent 权限。
2. 每个 Agent 同时至多一个 Execution；steering 不成为第二次执行。
3. child/report 依赖绑定具体捕获的 Execution，不按 name 重新路由。
4. 等待后代/报告的 parent 不提前 finalize 或 cold-release。
5. 每次执行的在线最终报告至多一次；不从历史较早成功回复替代本次失败。
6. 已提交 delivery 与 sender mount 生命周期分开；旧 callback 只幂等清旧资源，不能释放新执行名额或更新新 scope。
7. 普通 ask 按当前 cwd/trust/工具资源重校验，完整 role snapshot 不替换；模型/thinking 从历史恢复。
8. 整树锁保护本包管理，不阻止用户独立打开/resume child 或宿主直接写 JSONL。新 child 位于普通 discovery 根之外，默认 list/listAll/picker/continue 不选取它们；显式 private-directory 查询/custom sessionDir 和 explicit file open 仍允许，不改 mtime，不添加 owned-child guard/marker/index，不承诺并发直接打开无冲突或访问隔离。
9. 仅停止 root 当前模型响应不停止已接受后台工作；root shutdown/replacement 标 closing、取消 UI、abort/dispose descendants、保存终态、清进度并最后释放锁。
10. exact root resume 只递归加载轻量关系/history，不恢复 SDK 对象/pending 集合/旧 Promise，不续跑、不对账或补投报告；保存 idle 后投递前退出可能丢在线报告。首次 root owner 文件缺失按空树处理，不承诺诊断历史删除。

所有 descendants 共用一个 blocking UI FIFO；confirm/select/input 保留取消、timeout 与无 UI fallback。child 不直接修改 root widget，进度仅为 execution-local 最新摘要，不持久化或复制 thinking/tool output。同进程第三方 singleton、环境修改与不合作退出不保证隔离。不合作的异步 input hook 尚未退出时 shutdown 保留整树 writer lock，避免新 writer 接管仍可能写入的旧工作，不保证关闭立即完成。symlink/realpath/header 校验不是 filesystem sandbox，也不承诺防住恶意并发路径替换的全部 TOCTOU 攻击。

## 6. 当前代码术语对照

| 领域术语 | 当前符号 |
| --- | --- |
| Root coordinator / lifecycle scope | RootRuntime / RootScope |
| Logical subagent / execution | Agent / Execution |
| History identity / owner metadata | SessionIdentity / ParentSessionRecord / ChildRecord |
| File-backed store / key | PersistentSubagentStore / sessionKey |
| Mount / target session | OpenedChild / Execution.session |
| Direct caller / captured parent | CallerBinding.agent + execution / Execution.parent |
| Child/report dependency | Execution.pendingChildren / pendingReports |
| Online report / delivery | SubagentReport / ReportDelivery |
| Role / future choices | AgentDefinitionSnapshot / AgentTypeRegistry |
| Target authorization | DelegationContext |
| Shared UI / progress | RootUiBroker / SubagentUiProxy / Execution.progress |

当前类型见 `src/types.ts`，生命周期见 `src/runtime.ts`，history 恢复见 `src/child-session.ts`，owner 文件与锁见 `src/store.ts`。旧 StoredSubagent/StoredRun/LiveAgent 和 scope-relative sessionPath 不再是当前实现术语。
