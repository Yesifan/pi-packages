# ADR-0010：CLI 配置所有权与接收生命周期

- 状态：已采纳（Accepted）
- 关联：[需求 0010](../requirements/0010-account-removal-monitor-lifecycle.md)、[ADR-0004](0004-layering-and-dependency-direction.md)、[ADR-0007](0007-account-name-id-boundary.md)、[ADR-0009](0009-registered-account-visibility.md)

## 背景

原登录 CLI 直接写账号文件，项目/删除 RPC 则由 daemon 写配置。仅在 daemon 增加局部互斥不能阻止跨进程覆盖；原子 rename 也不能让多份 read-modify-write 彼此隔离。文件清理、持久登记和接收停止不能伪装成跨资源事务。

## 决策

- CLI 是 accounts.json、凭据、项目 config.json 的唯一写入角色。扫码不持锁；提交时重新读取、校验名称和全部绑定。配置损坏明确失败，合法文件缺失才代表初始空配置。
- daemon 只读取控制配置。旧写入 RPC 明确拒绝；control.sync 请求读取当前磁盘数据，不传旧快照。历史账号兼容迁移移到 CLI 写入入口和 serve 的前置步骤；已有现代索引（包括空索引）始终权威。
- 数据目录固定 .control.lock，使用 Linux util-linux flock 对继承的 fd 加锁；短命辅助命令退出后主进程保留同一 open file description，直到 close/退出才释放内核锁。锁文件不删除，不用 PID/mtime 的 stale 锁抢占算法。最多等待 30 秒，失败明确反馈。
- CLI 的读取—校验—保存、最终清理，与 daemon 的读取快照—完整 reconcile 共用该锁。CLI 释放后才等待 RPC。daemon 另用进程内串行入口管理 start/reload/restart/stop。
- .daemon.lock 是独立的生命周期锁，覆盖初始化至停止；同一数据目录最多一个 daemon。确认离线必须取得它，不能从 socket 连接错误推断安全。RPC 比较规范化 config/data/state 路径身份，不能把另一实例的响应当作同步成功。
- 每个文件分别原子替换，凭据先写再登记；不提供多文件事务。保存后同步失败或未知，非零退出并明确不回滚；离线确认则成功报告待下次启动。reconcile 的启动/停止失败向上传播，同时保留可诊断的实际状态。
- 删除/登录替换前，任何持久绑定（含 disabled）都拒绝。删除先提交登记移除，再同步接收停止；不自动解绑。
- 最终清理重新加控制锁，检查仍未登记，并以当前 receiver 状态或持有单实例锁确认安全；未确认就保留文件。文件逐项尽力删除，残留路径提示手动处理，仅清理警告不改成功结果。无自动重试、扫描、待删状态或恢复身份记录。
- AccountManager 独占每账号 AbortController/task。transport 的 start/stop 仅是远端通知，receive 使用管理者提供的 signal；本地退出后 notifyStop 失败仅警告。接收不等待 Pi 整轮工作。
- 长轮询返回后、进度保存前、逐条交付前检查取消；媒体下载后的文件写入同步检查 signal，缓存与业务交付同样受保护。已交付业务不被接收取消回滚。
- 同 ID 凭据变化先停止旧 monitor 再重建；移除账号清掉内存缓存。owner 变化还重建项目参与者/会话，新启动时不恢复其他 owner 的 context-token。持久配置与实际运行状态分别展示，不隐藏已注销但停止失败的 receiver。

## 后果与边界

这是 BREAKING 控制面变更，替代 ADR-0004 的 daemon 项目 writer、ADR-0007 的配置修改在线列表权威和 logout RPC/离线分叉，以及 ADR-0009 的文件清理失败保留登记顺序。历史 ADR 不改写。

部署须 Linux util-linux flock 和支持 flock 的本地文件系统；不共享不同实例的部分存储目录。旧版 daemon 不参与新锁，升级前先停旧版，CLI/daemon 配套更新。控制操作可串行等待慢 reconcile，但每账号长轮询继续独立异步运行。cwd 固定、项目解绑的会话重建、Pi SDK 分层与消息投递语义保持。

提交后进程退出可能残留凭据；不承诺敏感文件已消失，也不保证每个被并发命令替代的中间配置曾运行。索引只保留 ID，不引入账号格式迁移或跨资源事务。
