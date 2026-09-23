# 需求 0001：项目本地 subagent 配置与权威存储

- 状态：✅ 已完成
- 目标版本：0.2.0
- 决策：[`ADR-0001`](../adr/0001-project-local-subagent-storage.md)
- SDK 基线：`@earendil-works/pi-coding-agent@0.85.1`

## 目标

将 `pi-subagents` 的配置和持久化数据从 Pi 用户目录移到项目自己的 `.pi/subagents/`，同时保持现有 root ownership、exact resume、session-local delegation、external cwd 和单 writer 语义。

最终应满足：

1. 每个 root project 保存其 root session 所属整棵 subagent tree 的唯一权威副本；
2. 每个 caller 从自己的项目读取 delegation 配置；
3. 缺少目录时在项目通过 trust 后自动初始化；
4. 无权限或存储路径不安全时，本插件 fail closed，但不使 Pi host 崩溃；
5. 不复制 B→C 等 descendant 分支到 external project。

## 目标布局

```text
<projectRoot>/.pi/subagents/
  setting.json                         # 可选，可提交
  .gitignore                           # 可提交
  sessions/                            # 必须被 Git 忽略
    <rootKey>/
      root.json
      agents/<agentId>/
        agent.json
        runs/<runId>.json
        sessions/<pi-session-file>.jsonl
```

局部 `.gitignore` 默认内容：

```gitignore
/sessions/
```

`setting.json` 不存在时使用当前默认配置；存在时继续执行严格 JSON/schema 校验，未知字段或非法值不得静默忽略。

## 功能需求

### R1：root project 和权威 store

- root session 启动时确定 canonical `rootProjectRoot`，并在当前 `RootRuntime` 生命周期内固定。
- `rootKey` 继续由 root session ID 和规范化 root session file identity 派生。
- 权威 scope 必须是：

  ```text
  <rootProjectRoot>/.pi/subagents/sessions/<rootKey>/
  ```

- 同一项目的不同 root session 必须落入不同 `rootKey` scope，并分别持有 writer lock。
- root 的全部 descendants，无论 cwd 位于 root project 还是 external project，都写入同一权威 scope。
- 对于 `A → B → C`，只有 A 的 root scope 保存完整树；B、C 不保存 branch、ledger、mirror 或 child session 副本。

### R2：项目配置作用域

配置文件统一为：

```text
<callerProjectRoot>/.pi/subagents/setting.json
```

不再读取：

```text
<getAgentDir()>/extensions/pi-subagents.json
<projectRoot>/.pi/extensions/pi-subagents.json
```

作用域规则：

- `external_directory` 使用当前 caller project 的值；
- `max_depth`、`max_live_agents`、`ui_timeout_ms` 使用 root project 的值并约束整棵树；
- descendant 项目的 root-only 字段不影响当前外层 tree，只在它自身成为 root 时生效；
- project 字段继续逐字段覆盖内置默认值；本需求取消 global config layer；
- agent definition 的 built-in → Pi global → caller project 加载顺序不变。

### R3：受 trust 约束的自动初始化

- 在读取项目 `setting.json` 或写入项目运行数据前，必须先完成该 project 的 Pi trust 决策。
- session cwd 位于 Git project root 的子目录时，cwd 与实际承载配置/store 的 Git root 都必须通过 trust；任一明确拒绝都 fail closed。
- 未受信任项目不得被本插件创建或修改 `.pi/subagents/`。
- 受信任项目缺少 `.pi/subagents/` 时自动创建所需目录。
- `.gitignore` 不存在时，以排他/原子方式创建并加入 `/sessions/`。
- 已存在的 `.gitignore` 不得被覆盖；`/sessions/` 必须是最后一条有效规则。若 Git 项目中的 `sessions/` 未被有效忽略，必须给出明确诊断并 fail closed。
- 如果 `sessions/` 或其内容已经被 Git 跟踪，必须 fail closed，不能仅依赖 `.gitignore`。
- 非 Git 项目仍创建局部 `.gitignore`，但不执行 Git tracked/ignore 检查。

### R4：fail-closed 边界

以下情况必须拒绝接受新的 subagent run：

- 目录创建或原子写入返回 `EACCES`、`EPERM`、`EROFS` 等错误；
- `.pi/subagents` 或生成的 storage path 不是目录；
- storage path 经 realpath 后逃出 canonical project root；
- `.pi/subagents`、`sessions` 或 root scope 使用不允许的 symlink；
- writer lock 冲突；
- `setting.json` 无效；
- Git 项目中的 session 数据未被忽略或已经被跟踪。

失败行为：

- 工具返回稳定、可读的结构化错误；
- root 初始化失败时，本插件在该 session 中不可用并显示一次诊断；
- external caller project 初始化失败时，依赖其 delegation capability 的 child 创建失败；
- 不影响其他 extension 或整个 Pi host；
- 不回退到 agentDir 或其他项目目录；
- 不把未完成持久化的任务报告为 accepted。

任务接受后发生存储错误时，应使对应 run 失败并停止可安全取消的后代；已经发生的工具或外部系统副作用不声称被回滚。

### R5：路径与文件安全

- 自动创建的目录在 POSIX 上使用 `0700`，持久化 JSON 使用 `0600`。
- 元数据继续使用同目录临时文件 + 原子 rename，并串行化同 scope 写入。
- child Pi session 在元数据中保存 root-scope-relative path，不保存项目内 session 文件的绝对路径。
- relative session path 必须经过规范化和 containment 校验；绝对路径、`..` escape 和 symlink escape 一律拒绝。
- label、agent name、model 输出和工具参数不得参与存储路径生成。
- scope 初始化完成后，如果 `.pi/subagents` 或当前 `<rootKey>` 在运行中消失，后续写入不得通过递归 mkdir 重建项目结构，应报告存储错误并终止相关操作。
- `root.json` 必须校验已存 `rootSessionId` 和 `rootSessionFile` 与当前 root identity 一致，不能无条件覆盖不匹配记录。

### R6：恢复和项目移动

- exact original root resume 必须重新得到相同 `rootKey` 并恢复原 logical subagent ID、run 和 child history。
- new/fork/clone/import root 不得取得旧 scope 的 writer ownership。
- active run 在恢复时继续标记为 `interrupted`，不得自动重放。
- child session 使用 relative path 打开，但 stored canonical cwd 仍按现有安全规则重新验证。
- 初版不支持项目移动后自动重定位 canonical cwd；移动导致 cwd 不匹配时返回明确错误，不猜测新路径。

### R7：无旧 store 迁移

- 不迁移、兼容读取或删除 `<getAgentDir()>/.bykwp-pi-subagents/` 中的开发数据。
- 不保留旧全局配置的 fallback。
- 新实现只以项目 `.pi/subagents/` 为配置和持久化入口。

## 非目标

- 不在 external B/C 项目复制 root tree、branch 或 delegation ledger；
- 不实现跨项目双写、事务或对账；
- 不让 descendant store 独立恢复 root-owned logical subagent；
- 不改变 direct ownership、run/report 绑定、busy、steering 或 UI 生命周期语义；
- 不改变 exact external cwd admission，也不把 project root 当作 filesystem sandbox；
- 不自动修改项目根 `.gitignore` 或 `.git/info/exclude`；
- 不提供项目移动后的 cwd 自动重定位；
- 不迁移首次公开发布前的开发数据。

## 验收标准

1. **自动初始化**：受信任且可写的项目缺少 `.pi/subagents/` 时，root session 能创建目标布局和局部 `.gitignore`。
2. **trust 顺序**：未受信任 external project 在目录创建或配置读取前被拒绝，磁盘无新增内容。
3. **配置位置**：仅 `callerProjectRoot/.pi/subagents/setting.json` 生效；旧全局/项目配置不再读取。
4. **配置作用域**：A 的 root limits 约束 A→B→C；B 的 `external_directory` 决定 B 是否可创建 C；B 的 root-only 字段不修改 A 的 runtime limits。
5. **单一权威副本**：A→B→C 的 agent、run、report 和 JSONL 只存在 A 的 `<rootKey>` scope，B/C 没有镜像记录。
6. **多 root 隔离**：同一项目两个 root session 使用不同 scope；同一 root 被两个进程打开时第二个 writer 被拒绝。
7. **恢复**：exact resume 恢复 ID/history；new/fork/import 不接管旧 scope；interrupted run 不重放。
8. **relative session path**：正常恢复成功；绝对路径、`..` 和 symlink escape 被拒绝。
9. **Git 防护**：自动生成 ignore；已有 ignore 不被覆盖；未忽略或已 tracked 的 session 路径 fail closed。
10. **权限与路径**：只读项目、无权限目录、非目录、symlink/realpath escape 均在任务接受前失败，且不写 agentDir fallback。
11. **运行中删除**：初始化后的 store 被删除时不会递归重建项目目录，对应操作明确失败。
12. **回归**：现有 ownership、external cwd、agent snapshot、steering、report、UI 和 shutdown 测试继续通过。

## 影响范围

已修改：

- `src/config.ts`、`src/project-storage.ts`、`src/paths.ts`
- `src/store.ts`、`src/types.ts`
- `src/index.ts`、`src/runtime.ts`、`src/child-session.ts`
- `test/unit/config.test.ts`、`test/unit/project-storage.test.ts`、`test/unit/store.test.ts`、`test/unit/child-session.test.ts`
- `test/integration/extension.test.ts`、runtime/recovery 相关测试
- `README.md`、`docs/domain-model.md`、`docs/specs/bykwp-pi-subagents-spec.md`
- `CHANGELOG.md`

验证命令：

```bash
pnpm exec biome check --write packages/pi-subagents
pnpm --filter @yesifan/pi-subagents typecheck
pnpm --filter @yesifan/pi-subagents test
pnpm --filter @yesifan/pi-subagents build
pnpm --filter @yesifan/pi-subagents pack --pack-destination /tmp
```
