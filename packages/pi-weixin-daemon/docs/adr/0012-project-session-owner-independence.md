# ADR-0012：项目会话不随账号 owner 变化重建

- 状态：已采纳（Accepted）
- 关联：[ADR-0010：CLI 配置所有权与接收生命周期](0010-cli-control-ownership.md)、[ADR-0009：共享默认会话与 CLI](0009-shared-default-session-cli.md)、[领域模型](../domain-model.md)

## 背景

原实现将 owner 变化记录为当次 reload 的 changedOwners，在全部接收器启动后重建关联项目。其他账号启动阻塞时，新 owner 的消息先进入当前项目实例，随后又因 reload 完成而重建；中途失败重试还可能丢失重建标记。实例是否保留取决于其他账号启动时序。

用户明确：项目历史属于项目，获准进入项目的用户可以访问其会话历史；owner 不是项目历史隔离边界。因此不应通过 owner 变化触发项目重建来解决这个时序差异。

## 决策

- 删除 owner 变化引发的项目重建标记及特殊分支，不增加交付 gate、等待队列或待重建状态。
- 同 ID 的 owner/token/baseUrl 变化仍停止并替换账号接收器，清理微信 context-token、暂停状态等账号运行缓存；不复用旧 owner 的微信投递凭据。
- 项目 controller、runtime、active/default 会话不因 owner 单独变化而重建或切换。新消息继续使用项目当前实例；其他账号启动快慢或失败重试不改变这个规则。
- 项目绑定账号集合、cwd、enabled 的变化及显式 restart 等原有生命周期行为保持不变；不改变项目访问权限、历史路径边界或微信收件人解析规则。

## 后果

该决定替代 ADR-0010 中“owner 变化还重建项目会话”的约定，其他控制配置所有权和取消规则不变。测试仅需验证阻塞另一个接收器启动时，新 owner 的消息在 reload 前后都进入同一项目实例，并保留接收器更新及旧微信 token 清理的断言。
