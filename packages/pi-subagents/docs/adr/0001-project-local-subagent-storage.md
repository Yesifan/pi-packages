# ADR-0001：项目本地单一权威 subagent 存储

- 状态：✅ 已接受并实施（Accepted，`0.2.0`）
- 日期：2026-09-11
- 目标版本：0.2.0
- 关联：[`requirements/0001-project-local-subagent-storage.md`](../requirements/0001-project-local-subagent-storage.md)
- 规格：已同步 `docs/specs/bykwp-pi-subagents-spec.md` 第 4、12、13 节及关联不变量

## 背景

当前实现把每个 root session 的整棵 subagent 树保存在：

```text
<getAgentDir()>/.bykwp-pi-subagents/roots/<rootKey>/
```

全局配置位于 `<getAgentDir()>/extensions/pi-subagents.json`，项目配置位于
`<projectRoot>/.pi/extensions/pi-subagents.json`。这使运行数据脱离项目生命周期，也让用户难以从项目目录定位、清理或备份相关 subagent 历史。

本包尚未公开发布，因此本次决策不承担旧开发数据迁移兼容。

## 决策

### D1：配置和持久化数据移入 `.pi/subagents`

项目使用以下布局：

```text
<projectRoot>/.pi/subagents/
  setting.json
  .gitignore
  sessions/<rootKey>/
    root.json
    agents/<agentId>/
      agent.json
      runs/<runId>.json
      sessions/<pi-session-file>.jsonl
```

`setting.json` 是可选项目配置；文件不存在时使用默认值，文件存在但无效时 fail closed。
不再读取 `<getAgentDir()>/extensions/pi-subagents.json` 或旧的项目配置路径。

### D2：root project 保存整棵树的唯一权威副本

`rootProjectRoot` 在 root session 初始化时确定，并在该 `RootRuntime` 生命周期内固定。所有后代的身份、run、报告和 Pi child session 历史都写入：

```text
<rootProjectRoot>/.pi/subagents/sessions/<rootKey>/
```

对于 `A → B → C`：

- A 保存 A 所属 root 的完整 delegation tree；
- B、C 不保存该树、分支或委派账本的副本；
- external child 的 cwd 不改变权威 store 位置。

每个 root scope 继续保留 `rootKey` 和独立 writer lock。不得让同项目中的多个 root session 共用 `agents/` 或 session 文件。

### D3：配置按 caller project 加载，运行时限制由 root 控制

每个具有 delegation capability 的 session 从自己的 current project 读取：

```text
<callerProjectRoot>/.pi/subagents/setting.json
```

配置作用域为：

- `external_directory`：由当前 caller 项目配置决定；
- `max_depth`、`max_live_agents`、`ui_timeout_ms`：只由 root project 配置决定并约束整棵树；
- descendant 项目中的后三项仅在该项目自身成为 root project 时生效。

内置、Pi 全局和项目 agent definition 的现有加载顺序不变；本 ADR 不移动 `<getAgentDir()>/agents/*.md` 或 `<projectRoot>/.pi/agents/*.md`。

### D4：受信任后自动初始化，失败时关闭本插件能力

需要使用本包能力的项目在通过 Pi project trust 后，若 `.pi/subagents/` 不存在则自动创建。若 session cwd 是 Git root 的子目录，cwd 与实际承载配置/store 的 Git root 都必须通过 trust。初始化同时建立运行目录和局部 `.gitignore`；默认忽略：

```gitignore
/sessions/
```

已有文件不覆盖，但 `/sessions/` 必须是最后一条有效规则，并通过 Git 的 ignored/tracked 检查，防止后续 negation 暴露历史。

初始化或写入遇到无权限、只读文件系统、不安全 symlink、路径逃逸、已跟踪的 session 数据、锁冲突或其他存储错误时 fail closed：

- 不接受对应 subagent run；
- 让本插件工具返回明确错误并显示一次诊断；
- 不使整个 Pi host 或其他 extension 崩溃；
- 不静默回退到全局 store。

缺失目录只允许在项目/root scope 初始化阶段创建。已经初始化的 scope 在运行中被删除后，后续写入不得递归重建项目路径，而应终止相关操作并报告存储错误。

### D5：child session 路径使用 scope-relative identity

持久化记录不保存可由项目目录移动而失效的 child session 绝对路径，而保存相对于对应 `<rootKey>` scope 的路径。恢复时必须解析、规范化并验证最终路径仍位于该 root scope 内。

`rootKey` 仍由 root session ID 与规范化 root session file identity 派生，以保留 exact resume 与 new/fork/import 隔离。canonical child cwd 仍按绝对路径持久化；本决策不承诺项目移动后自动重定位 cwd。

### D6：不迁移旧开发数据

首次采用新布局时：

- 不读取、复制或删除 `<getAgentDir()>/.bykwp-pi-subagents/`；
- 旧 logical subagent ID 不在新 store 中恢复；
- 不设置全局 store fallback。

权威规格、领域模型、README 和测试同步描述新布局。

## 理由

1. **项目生命周期一致**：项目的 subagent 配置和历史可随项目一起定位、备份和清理。
2. **单一事实来源**：root project 的完整树足以支持 ownership、报告路由、shutdown 和 exact resume；不引入跨项目双写与对账。
3. **保留 root 隔离**：`rootKey` 继续防止同项目不同 root、fork、clone 或 import 错误接管旧 child。
4. **显式失败优于隐式分裂**：项目不可写时不回退到用户目录，避免同一 root 的状态出现在两个 store。
5. **配置语义局部化**：caller 只读取自己的项目配置，继续满足 session-local delegation 边界。

## 已考虑但拒绝的方案

### 保持用户目录为默认 store

安全且稳定，但不能满足“每个项目在自己的目录保存 subagent 信息”的目标。

### A 保存完整树，同时 B 保存 B→C 的副本

拒绝。项目局部审计收益不足以覆盖双写、崩溃对账、额外锁、数据放大和敏感历史扩散；B 的副本也不能脱离 A 的 root session 独立恢复。

### 按每个 child cwd 分割权威树

拒绝。它会让一棵 root-owned delegation tree 跨多个项目 store，显著增加恢复、原子清理、writer ownership 和 external project trust 的复杂度。

### 删除 `rootKey`，每个项目只保留一个 `sessions/agents` 集合

拒绝。同一项目可以存在多个独立 root session；共用 scope 会破坏所有权和并发写保护。

## 后果与取舍

### 正向

- 用户可以从项目目录直接发现全部相关数据；
- 项目删除或归档时运行数据可一并处理；
- 不再在 agentDir 中累计本包私有 root scope；
- configuration、storage 和项目 trust 边界更直观。

### 负向

- 项目必须可写，read-only checkout 无法使用本插件的持久化能力；
- `.pi/subagents/sessions/` 含有 prompt、回复和工具结果，误提交或同步会泄露信息；
- Git ignore、symlink、目录权限和运行中删除需要额外防护；
- 项目移动后 canonical cwd 仍可能失效；
- 删除项目会永久删除对应 subagent 历史。

## 相关实现

实现涉及：

- `src/config.ts`、`src/paths.ts`：项目目录初始化、配置定位和路径安全；
- `src/store.ts`：project-local root scope、relative session path 和 writer lock；
- `src/runtime.ts`、`src/index.ts`：固定 rootProjectRoot、初始化与 fail-closed；
- `src/types.ts`、`src/child-session.ts`：持久化 session path 格式与安全恢复；
- `test/unit/`、`test/integration/`：项目隔离、Git ignore、权限、锁、resume 与 external cwd；
- `README.md`、`docs/domain-model.md`、`docs/specs/`：公开语义同步。
