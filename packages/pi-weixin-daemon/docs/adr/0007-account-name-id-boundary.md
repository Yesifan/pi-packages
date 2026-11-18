# ADR-0007：CLI name 与控制面 account ID 分界

- 状态：已采纳（Accepted）
- 关联：Issue #31、[领域模型](../domain-model.md)

## 背景

CLI 混用 name/ID 会在名称与另一个账号 ID 冲突时选错账号；daemon 与本地名称列表不一致时，本地优先也会覆盖在线权威选择。项目 RPC 原先传名称，模糊了控制面与用户输入的边界。

## 决策

- CLI 的 logout、project add/remove、doctor --account 仅接受 trim 后区分大小写的 name；零匹配或多匹配均失败，不回退 ID。
- 在线以 account.list 为权威，在 CLI 唯一解析为 ID 后发送。仅 logout/doctor 的列表连接明确离线时允许本地解析；其他 RPC 错误不触发本地回退。
- logout 列表成功后若登出连接明确失败，保留此前解析的 ID 离线清理，不重新解析本地名称；删除失败不注销索引，不承诺解绑/停止的事务回滚。
- 账号选择类 RPC 仅接受已注册 ID。项目操作改为显式 accountIds 数组并拒绝旧 accounts 字段，避免旧客户端名称被误解为 ID；logout 使用 accountId。内部 store/routing 仍以 ID 为键。

## 后果与边界

这是经批准的 BREAKING 协议变更：CLI/daemon 两端版本须匹配，升级后必须重启 daemon。不引入 name 缺失迁移或自动重试，也不改变广播、RPC 分帧和登出删除失败的既有语义。
