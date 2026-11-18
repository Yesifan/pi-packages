# ADR-0011：项目默认会话运行状态独立存储

- 状态：已采纳（Accepted）
- 日期：2026-10-23
- 关联：[ADR-0009：共享默认会话与 CLI 回合来源](0009-shared-default-session-cli.md)、[ADR-0010：CLI 配置所有权与接收生命周期](0010-cli-control-ownership.md)

## 背景

共享默认会话要求 daemon 在首次激活及 `/default` 时持久保存默认身份；直接写项目 `config.json` 会违反 CLI 独占控制配置写入的约定，并与 CLI 的配置保存竞争。两项行为都保留，不通过改写已完成规格或历史 ADR 消除冲突。

## 决策

- CLI 仍是账号登记、凭据及项目控制配置 `config.json` 的唯一 writer；daemon 只读控制配置。
- 默认会话属于 daemon 的运行状态，写入 `resolveStateDir()/projects.json`，默认路径为 `~/.local/state/pi-weixin-daemon/projects.json`。按项目保存 `cwd` 与 `defaultSessionId`，不将临时 active/runtime 或进行中的任务作为恢复状态。
- 旧 `config.json` 的 `defaultSessionId` 仅作只读兼容；daemon 不为保存默认会话修改控制配置。
- 保留共享 default/active、微信及 CLI 的选择规则、闲置释放、切换通知及 reply 语义。保留共同控制锁、daemon 单实例锁、路径身份校验，以及配置保存、运行应用、账号文件清理分别反馈的约定。

## 后果

控制配置与运行状态有明确且不同的 writer。备份或迁移默认会话身份时需包含 state 目录的 `projects.json`，Pi 会话历史仍由 Pi 管理。本记录整合两份历史决定，不重编号、不改写其原有理由或已完成验证记录。
