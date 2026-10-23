# ADR-0008：Pi 业务单入口与内部适配精简

- 状态：已采纳（Accepted）
- 日期：2026-10-21
- 关联：[需求 0011](../requirements/0011-runtime-simplification.md)、[ADR-0004](0004-layering-and-dependency-direction.md)

## 背景

生产业务已通过 SessionRuntimePort 调用 PiSdkHost。ADR-0004 设计的 PiSessionHost 仅在 prompt 时临时实例化，其余方法无消费者；独立的诊断 helper 和 UI 能力表也未接线。保留这些结构使边界内存在闲置的第二套门面与契约副本，而不是提供更多隔离保障。

## 决策

1. daemon 发起的运行会话业务遵循 `业务层 → SessionRuntimePort → PiSdkHost → SDK`，包括 prompt、生命周期、模型/thinking、默认设置、历史列表与状态查询。业务层不直接持有 SDK 对象。
2. 删除 PiSessionHost 类及其闲置方法；将有效 prompt 和图片转换逻辑收口至 PiSdkHost.prompt。删除未接线的 diagnostics/UI capabilities 模块，保留实际 fail-closed 诊断和 UI 实现及测试。
3. PiSdkHost 可以委托 Pi 边界内部工厂、session rebind、extension command callbacks 和事件/UI/trust 适配直接调用 SDK。这些是受 host 装配的内部实现，不是新的 daemon 业务入口，不机械转接成参数面不同的 host 方法。
4. SDK 版本、环境和模型可用性诊断可使用独立的 sdk-info 入口，不创建或操纵活动会话；不承诺整个 doctor 无文件系统 I/O。
5. 保留 ADR-0004 的 SDK import 边界，补齐对 Pi AI 根包的限制；不禁止组合根装配内部适配工厂。原 ADR 中 PiSessionHost、diagnostics 和 ui-capabilities 的具体文件划分由本决策取代，其余职责与隔离原则不变。
6. 内部 dist 深层导入不属于承诺的公开 API。无消费者的内部导出可删除，但 CLI/RPC、存储格式、现有会话和微信交互行为保持。

## 后果与验证

- 少一层临时转发对象、多个闲置方法与契约副本；不新增统一调用框架，也不将 SDK 版本细节暴露给业务层。
- 保留 sessionRef、generation、replacement/rebind、UI own/enumerable 绑定和 configured/active trust 的区别，不把有生命周期职责的状态当作死代码删除。
- 离线 SDK adapter 测试覆盖无图/空图/多图、异常传播及替换后使用新 session；现有真实 SDK UI 包装回归保持。直接 SDK import 的边界通过 Biome 验证。
- 删除源码后构建前清理包的旧 dist，避免 TypeScript 增量文件集合留下已经删除模块的旧产物；检查 tarball，不发布陈旧构建。
