# Spec 0004：Subagent 原生 Codemode 与 MCP

```yaml
status: completed
execution_time: "2026-10-18 / 2026-10-18"
commit: null
version: null
related_documents:
  - "yesifan-pi-subagents-spec.md"
  - "../adr/0003-sdk-sessions-and-parent-metadata.md"
```

## Goal

内置 general、explore 和自定义 role 的 child mount 使用目标环境配置的 Codemode 与 MCP，无需额外适配扩展或重复配置。扩展当前权威规格，不改写已完成的 Spec 0002，不实施 Spec 0003。

## Implementation Decisions

- 以锁定 Pi SDK 1.1.0 的类型与实现为准。官方 SDK 示例提供 createCodemodeExtension、createToolSearchExtension、createMcpExtension；本项目采用具名 builtin: true、replaceable 配置，使正常禁用与第三方替换生效。这是项目适配，不是官方 subagent 方案。
- trust 通过后按 target cwd、agentDir 和 settings 加载 resources；不复制 parent 工具实例、连接或临时 CLI override。保留本包自身扩展过滤、内部 delegation factory 和 same-cwd 叶节点限制。
- 加载不等于激活；defaultTools 可启用 codemode，MCP 自动启用遵循配置。支持 -builtin:<name> 和 SDK 同名替换，避免重复注册及多余连接。
- MCP 在 session_start 后由 SDK 后台连接和动态注册；默认 exposure 为 codemode，通过脚本发现/调用，不直接声明给模型。deferred/direct/hidden 沿用 SDK。
- 用户确认取消本包的工具存在性预校验。tools 直接传给 SDK（含其支持的模式）；未知、拼错或尚未发现的名称不再导致创建时 TOOL_UNAVAILABLE。未匹配名称不提供工具，后续注册遵循 SDK 选择；真正调用不可用工具仍由 SDK 报错。保留字段格式、互斥与去重校验，不新增等待 API、轮询或全局连接器。
- 原 roleSnapshot、tools/disallowedTools 互斥、空列表、MCP retention/selection、通配排除优先及动态注册过滤不变；限制实际调用（包括 codemode），不是仅隐藏声明。工具策略不是 sandbox，explore 不保证严格只读。
- 关闭使用 SDK 生命周期；不新增共享连接池、MCP 管理器、frontmatter 字段或公开协议。

## Testing Decisions

内置扩展新增测试仅覆盖加载、禁用与替换；用户确认取消名称预校验后，另调整既有未知名称回归并补最小晚注册选择回归，不扩张完整策略矩阵。使用真实 SDK 的 ChildSessionFactory 边界、临时 PI_CODING_AGENT_DIR/项目和本地 stdio MCP fixture，不访问个人服务、不调用真实模型，清理配置、history 和进程。

1. 配置启用 codemode 后可调用；MCP fixture 连接后可发现并完成最小调用，默认 codemode exposure 可从脚本调用。
2. 禁用对应 builtin 后能力缺失；禁用 MCP 不建立 fixture 连接。禁用 codemode 不等于禁用其他 MCP exposure。
3. SDK 支持的第三方同名替换实际生效，无同名冲突；替换 MCP 不再由内置实现连接 fixture。

本次不新增 role 选择/排除、动态校验错误、跨 cwd、ask/recovery、shutdown race 的完整矩阵，既有契约与回归仍保留。验收运行 pnpm check 与 pnpm test，记录真实结果，超时不算通过。

## Verification

2026-10-18：已实现内置扩展加载、禁用/替换、失败打开时的 shutdown 清理及用户确认的取消工具存在性预校验。修订后独立审查未发现具体缺陷。以下为最终验证：

- `pnpm check` 通过：全仓类型检查及 Biome，16 条既有警告。
- `pnpm test` 通过：pi-subagents 22 文件 / 259 测试，pi-weixin-daemon 25 文件 / 158 测试。
- 名称选择回归在修复前因 TOOL_UNAVAILABLE 失败，移除预校验后通过；相关 targeted 测试 56/56 通过。未知选择不匹配工具，session_start 后注册的显式 MCP 选择可调用。
- 新增真实 SDK / 本地 MCP 测试 6/6 通过，覆盖加载、禁用、替换。首轮 MCP 调用因测试缺少 issuing assistant message 失败，修正测试入口后通过；未记录修复前 runtime 的回归失败，不将该测试入口错误当作 runtime 修复证据。
- pi-subagents build、pack 通过；tarball 包含新规格与运行时代码，不含测试、fixtures、AGENTS.md。
- 未调用真实模型，未运行实际交互 CLI/TUI 验收；未扩张本次新增测试矩阵。

需求修订：锁定 SDK 1.1.0 没有公开 MCP discovery-wait API。用户随后明确确认取消全部工具存在性预校验，直接采用 SDK 工具选择语义，取代最初“未知名称返回 TOOL_UNAVAILABLE、动态名称等待发现后校验”的要求。无需升级 SDK、伪造 tool_call、访问私有字段或轮询。代价是拼错名称不再提前暴露，可能缺少预期工具；排除规则与委派限制不变。
