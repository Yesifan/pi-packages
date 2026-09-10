# ADR-0001：会话项目信任解析采用 pi 官方完整决策链

- 状态：✅ 已接受（Accepted）
- 实施提交：`3c4c226`
- 日期：2026-06-（见 git 提交时间）
- 关联：`docs/requirements/0001-session-trust-fix.md`

## 背景

pi 的嵌入式 SDK（`@earendil-works/pi-coding-agent`）通过
`createAgentSessionServices` 的 `resourceLoaderReloadOptions.resolveProjectTrust`
钩子来门控「项目作用域资源」的加载（`.pi/*`、项目 `.agents/skills`、项目包、项目扩展）。
pi-wx 的 `PiRuntime`（`src/agent/runtime.ts`）在 0.5.2 已接入该钩子，
但**决策逻辑不完整**，导致部分项目作用域配置不被加载。

## 发现（当前实现与官方语义的差距）

`runtime.ts` 当前：

```ts
const trustReloadOptions = hasTrustRequiringProjectResources(factoryCwd)
  ? {
      resolveProjectTrust: async () =>
        new ProjectTrustStore(agentDir).get(factoryCwd) === true,
    }
  : undefined;
```

对照官方文档（`docs/security.md`、`docs/README.md`、SDK `project-trust.d.ts`、
CLI `resolveProjectTrusted`）：

| # | 官方语义 | 当前实现 | 说明 |
|---|---------|---------|------|
| 1 | 非交互模式不弹 trust 提示 | ✅ 一致 | daemon 为 RPC 模式，无 prompt |
| 2 | 已保存决策：取当前/最近祖先目录的最近决策（`findNearestTrustEntry`） | ✅ 一致 | `ProjectTrustStore.get()` 即最近祖先匹配 |
| 3 | **无 saved 决策时回退 `defaultProjectTrust`**（`ask`/`never`→拒绝，`always`→信任） | ❌ **缺失** | 硬编码 `=== true`，等价于 `never`，未读全局 `defaultProjectTrust` |
| 4 | 触发 `project_trust` 事件，用户/全局扩展可决策 | ❌ 缺失 | daemon 无该事件处理 |
| 5 | 单次运行 `--approve`/`--no-approve` 覆盖 | ❌ 缺失 | daemon 无对应覆盖入口 |

**根因**：`resolveProjectTrust` 被写死成「仅当 `trust.json` 对 cwd 存在 `true` 决策才信任」，
丢掉了 `defaultProjectTrust` 这个兜底分支。对未手动 trust 过的项目，`get(cwd)` 为 `null` →
返回 `false` → 项目作用域 extension/skill/settings/prompt 全部被跳过，只落全局限定。

## 决策

让 `PiRuntime` 的 `resolveProjectTrust` 遵循与官方 CLI 一致的决策链：

```
saved `trust.json` 最近祖先决策
  ├─ 存在 true  → 信任
  ├─ 存在 false → 拒绝
  └─ 不存在     → 回退 defaultProjectTrust
                    ├─ "always" → 信任
                    └─ "ask" / "never" → 拒绝（非交互模式不弹窗）
```

实现上：不再硬编码 `=== true`，改为读取 `SettingsManager.getDefaultProjectTrust()`
作为 fallback；`hasTrustRequiringProjectResources(factoryCwd)` 仍作为「是否需要 trust 门控」的
前置判断（无 trust-requiring 资源时无需 gate，直接加载）。

## 理由

1. **对齐官方文档**：embedding SDK 的 trust 语义应镜像 CLI，避免「同一个项目在 pi CLI 里配置生效、
   在 pi-wx 里失效」的不一致。
2. **尊重用户显式配置**：`defaultProjectTrust: "always"` 是用户明确表达的「默认信任」意愿，
   当前代码忽略了它；而 `never`（安全默认）仍应拒绝，行为不因修复而放宽。
3. **最小改动**：`ProjectTrustStore.get()` 已负责最近祖先匹配，只补 fallback 分支即可，
   不重写整个解析流程。

## 取舍 / 边界

- **不触发 `project_trust` 事件、不做 `--approve` 覆盖**：daemon 是无人值守的非交互服务，
  没有可交互的 UI 上下文，事件/临时覆盖的收益低。`defaultProjectTrust` + 手动编辑
  `~/.pi/agent/trust.json` 已覆盖主要场景。此项记为**后续可选增强**（见需求文档非目标）。

## 后果

- 正向：未手动 trust 但全局 `defaultProjectTrust: "always"` 的项目，其项目作用域配置恢复加载。
- 风险：若用户全局设为 `always`，本来会被忽略的项目资源将被加载——这是用户显式意愿，
  与 CLI 行为一致，属预期。
- 需补充：`defaultProjectTrust` 的默认值按官方为 `ask`（非交互下等同拒绝），
  默认行为不因本次修复而放宽。

## 相关实现

- `src/agent/runtime.ts`（`createRuntime` factory / `trustReloadOptions`）
- `src/agent/pi-runtime-factory.ts` 或 factory 注入处（若抽离）
