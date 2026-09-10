# Changelog

All notable changes to this project are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).
`BREAKING` sections note changes that require manual upgrade action.

---

## [0.6.7]

### Changed

- 普通 Pi 回合的微信“正在输入”状态改为每 5 秒续发，并向项目内所有已注册参与者广播；回合收尾会在等待在途续发后显式取消。

## [0.6.6]

### Changed

- `/model` 和 `/thinking` 选择器同时显示当前模型与思考强度。
- `/help`、`/status` 及选择器改用 Markdown 标题和列表，确保微信正确显示多行内容。

## [0.6.5]

### Fixed

- `/help` 命令列表改用微信可正确渲染的段落换行，避免所有命令挤在同一行。

## [0.6.4]

### Added

- daemon 内置 `weixin_send_progress` 工具，允许 Agent 在长任务中向当前微信发起者发送简短中间进度；进度不广播，也不并入最终回复。

## [0.6.3]

### Added

- 微信端新增 `/model`、`/thinking`、`/resume [latest]`、`/reload`、`/p:<prompt>` 与
  `/help <command>`。
- 模型和会话支持每页 5 项的跨消息选择；选择绑定发起者并在连续 30 秒无操作后主动超时，翻页或无效输入会重新计时，支持 `q` 退出。
- 模型与思考强度可写入 Pi 项目 settings，影响后续新会话；历史会话通过 Pi runtime 恢复并重绑扩展。

### Changed

- Slash selector 与 Pi UI ask 仲裁；只有 `/resume` 选择会阻塞项目，模型和思考选择不阻塞其他账号。

## [0.6.2]

### Fixed

- 在 project gate、媒体下载和消息归一化之前丢弃 iLink 的 BOT/非 USER 入站记录，避免
  bot 自身消息误入 Pi；为兼容旧报文，缺失 `message_type` 时仍按 USER 处理。

## [0.6.1]

### Fixed

- Pi Provider/模型错误现在从最终 assistant message 的 `stopReason/errorMessage` 提取并回复
  当前微信发起者；自动重试成功不会误报中间错误，部分输出失败会明确标记为不完整。
- daemon 命令、项目消息处理和 idle 自动关闭增加错误边界，不再只记录日志后静默返回。
- Agent 回合增加 watchdog 和 abort grace，避免 Pi 卡死后项目永久停留在 busy。

### Added

- 当前回合的 Pi extension runtime error 会作为非致命警告告知发起者。
- 用户可见错误统一进行控制字符清理、凭据脱敏和长度限制。
- 项目广播增加送达统计，微信长文本分片增加不含正文的结构化进度/失败日志。
- 新增 `PI_WEIXIN_TURN_TIMEOUT_MS` 与 `PI_WEIXIN_ABORT_GRACE_MS` 配置。

### Changed

- Agent 错误及其部分输出只回复当前回合发起者，不再广播给项目其他参与者；微信送达失败
  与 Pi runtime 故障分开处理。

## [0.6.0]

### BREAKING CHANGES

- **删除 `project set`**：`cwd` 创建后固定不可改（CLI `project set`、RPC
  `project.set`、`daemon.setProjectCwd()` 全链路移除）；`ProjectStore` 对已存在
  项目断言不改 cwd。需要改 `cwd` 的项目需删除后重建（并重新绑定账号）。

### Changed

- **架构分层（Pi host 兼容性重构，五阶段）**：只留 `src/pi/` 直接 import Pi SDK
  （含类型），对外只用领域类型；新增 `src/sessions/`（单一会话状态机）、
  `src/projects/`（ProjectController + command-router + immutable snapshot）；
  删除 `src/agent/` 与 `src/bridge/`。eslint `no-restricted-imports` 强制边界。
- **诊断 fail-closed（W1）**：extension/settings 致命错误（`PiInitializationError`）
  让该项目进入 error 态并拒消息，其它项目不受影响；`/status` 展示
  `configuredTrust` 与 `activeSessionTrust` 双字段（W7）。
- **idle 真关闭（W3）**：闲置到点后 dispose SDK runtime，下一条消息重建全新
  session；`/new` 透传 `{cancelled}`，被 `session_before_switch` 取消时如实回复。
- **微信 slash 语义（W4）**：只认 daemon 显式命令 `/help /status /abort /new
  /compact`；未知 `/xxx` 回复「未知命令」，不进 Pi 也不当普通消息。

### Added

- **完整 `bindExtensions`（W5）**：`waitForIdle/newSession/fork/navigateTree/
  switchSession/reload` 六动作绑定公开 API，挂在 rebind 路径。
- **UI 降级契约（W6）**：`ctx.ui.custom()` resolve undefined、`editor()` 降级为
  输入框、`theme` 返回真实最小 Theme 对象；其余 TUI 原语 no-op 不 throw。
- **`weixin_send_file` 无路径边界（W9）**：仅 `exists + isFile + sanitizeFilename`；
  权限模型 = agent 进程权限（与 bash/read/write 一致）。

### Removed

- 删除 `sessionExpired`（由单一状态机 `inactive/ready/busy/replacing/faulted` 取代）。

### Upgrade

- 若已有项目需要改 `cwd`：`pi-wx project remove <name>` 后
  `pi-wx project create <name> --cwd <新路径>`，再重新 `project <name> add <label>` 绑定账号。

---

## [0.5.4]

### Added

- **`pi-wx status` 显示版本信息**：输出首行 `pi-wx <版本> · pi (@earendil-works/pi-coding-agent) <版本>`，
  再显示 systemd --user 状态。

## [0.5.3]

### Added

- **`/status` 显示项目 trust 状态**：`PiRuntime.getStatus()` 新增 `trust` 字段，
  `/status` 输出 `Trusted: true/false`。trust 独立于 session 计算（仅读
  `~/.pi/agent/trust.json` + `defaultProjectTrust`），懒建前也能正确上报。

### Changed

- **session 懒创建**：项目/daemon 启动阶段不再创建 session，首条用户消息或 `/new`
  才经 `ensureRuntime()` 创建，避免为闲置项目空转建会话。

### Fixed

- **完善项目 trust 决策链**：`resolveProjectTrust` 不再硬编码 `trust.json === true`，
  无 saved 决策时回退全局 `defaultProjectTrust`（`always` 信任；`ask`/`never` 非交互下拒绝），
  对齐 pi 官方/CLI，修复「项目作用域配置不被 trust」。
- **`/new` 不空转**：无活跃 session 时 `/new` 不再创建空会话，提示
  「当前无会话，直接发送消息即可开始新会话。」
- **闲置自动关闭仅在有 session 时触发**：懒建前（从未发消息）项目不再误广播「会话已关闭」。

---

## [0.5.2]

### Fixed

- **修复 wx 会话未应用项目级权限配置**：pi-wx 嵌入式会话（`PiRuntime`）在创建时未接入
  项目信任解析（对齐 pi-web / `pi` CLI 的 `resourceLoaderReloadOptions.resolveProjectTrust`），
  导致 `@gotgenes/pi-permission-system` 等扩展读不到项目作用域配置，只落全局限定（如
  `external_directory: "*": ask`）。现在 `createAgentSessionServices` 显式传入
  `settingsManager` 与 `projectTrustReloadOptions`，按 `~/.pi/agent/trust.json` 解析项目信任，
  项目级 allow（如 `~/Beancount`）重新生效、不再误弹权限窗。

---

## [0.5.1]

### Added

- **入站媒体处理（参考 Hermes，不混合）**：每条 iLink 消息独立成回合；**图片**→多模态
  （base64 + mime）；**文件 / 视频 / 语音文件**→生成 **context note**（类型 + 保存路径 +
  “自己读/处理，别让用户粘贴/描述”）交给 agent；**语音**优先用 `voice_item.text`（iLink 自带的
  语音转写）**当作文本**，无转写才作为语音附件。
- **下载失败告知**：媒体下载/解密失败不再静默跳过，而是记录为 `mediaFailures`，交由 agent
  告知用户“附件下载失败”。
- **丢弃前告知（gate）**：账号**未绑定** / **项目停用** / **已绑定但项目未运行**时，回发告知
  用户（不再静默丢弃）；`transport` 层区分「未绑定/停用」文案，`ProjectManager.dispatch` 处理
  「未运行」告知。

### Changed

- `resolveInboxDir` 现在返回 `{ dir, reason }` 以区分「未绑定/停用」；
  `downloadAttachmentsFromMessage` 返回 `{ attachments, failures }`；`InboundMessage` 新增
  `mediaFailures` 字段；`extractText` 提取语音转写 `voice_item.text`。

---

## [0.5.0]

### Fixed

- **修复「权限/UI ask 死锁」**：`getupdates` 长轮询循环原本 `await onInbound(full)`，会一直等待
  turn 处理完成；而 turn 在等权限/UI 答复时又需要收到下一条消息，形成死锁（session 永久 busy、
  回复收不到）。改为在 `onInbound` 处 **fire-and-forget**，turn 进行中仍持续轮询，答复能及时收回。

### Added

- **UI / 权限 ask 答复回执**：`confirm`/`select`/`input` 收到用户答复后，回发一条确认消息告诉用户结果
  （如 `✅ 已允许：Yes` / `✅ 已确认` / `✅ 已收到：…`）。
- **超时自动拒绝（兜底）**：ask 发出后计时，用户未在时限内回复则**自动拒绝/取消**并回发
  `⏱️ 超时未收到回复，已自动拒绝/取消`。默认 **5 分钟**，环境变量 `PI_WEIXIN_UI_TIMEOUT_MS`（毫秒）覆盖。
  未识别回复时也回发 `⚠️ 无法识别…` 提示。

### Changed

- `WeixinUIContext` 的 `waitForResponse` 现在正确生效：之前 SDK 传入的 `ExtensionUIDialogOptions.timeout`
  在微信路径里**被忽略**（未映射到 broker 的 `timeoutMs`），现已按 `{ timeoutMs, signal }` 生效。

### Docs

- `docs/routing.md` 新增「UI / 权限交互（ask）」一节：答复路由、不阻塞接收、答复回执、超时自动拒绝。

---

## [0.4.0]

### Added

- **会话空闲自动关闭**（需求①）：项目会话 10 分钟无消息后自动关闭，向项目内参与者广播一句
  "本次会话已关闭"；下一条消息进来时**自动新建**一个会话（`ProjectRuntime` 空闲定时器 +
  惰性 `newSession`）。
- **发送者标记**（需求②）：入站消息交给 agent 的文本末尾追加 `-- from weixin <账号name>`
  （`buildPromptText`）。
- **同项目互通**（需求③）：某账号的用户发消息时，同时通知同项目内**其他**参与者，
  内容为 `"<账号name>: 消息文本"`。
- **回复广播**（需求④）：agent 的最终回复广播给项目内**所有**参与者（含发起者）。
- **参与者注册表**：`ProjectRuntime` 记录每个项目下"实际发过消息的 `(accountId, senderId)` + `contextToken`"；
  互通与广播一律用它，**不依赖 `account.userId`**（避免 `ilink_user_id ≠ from_user_id` 时出错）。

### Changed

- `Bridge` 增强：`BridgeDeps` 新增可选 `resolveSenderLabel` / `broadcastText`；未配置时保持 "只回发起者"。
- **每次启动新建会话**：项目启动（含 daemon 重启）由 `SessionManager.continueRecent`（恢复最近）改为
  `SessionManager.create`（总是新建），不再跨重启恢复上一个会话。
- 版本号三处硬编码统一到 `src/version.ts`（读 package.json），修正 `daemon.status` 上报的旧版本号。

### Docs

- 新增 `docs/domain-model.md`（实体/变量术语基准）、`docs/README.md`（文档索引）。
- 更新 `docs/routing.md`（消息流 + 术语对齐 + 互通/广播规划）、`AGENTS.md`（索引 docs）。

---

## [0.3.0] - BREAKING

### BREAKING CHANGES

- **CLI 命令改名**：`pi-weixin-daemon` → `pi-wx`。
  - systemd 单元名**仍为** `pi-weixin-daemon.service`；`pi-wx start` / `stop` / `restart` / `status` / `logs`
    仍操作 `systemctl --user ... pi-weixin-daemon` 与 `journalctl --user -u pi-weixin-daemon`。
- **`login` 现在必需 `--name <label>`**：`name` 是用户起的账号标识（全局唯一），账号 **id 仍为 `ilink_bot_id`**
  （扫码返回，作项目路由 key）。
- **移除 `project add <name> --account <id>`**：改为
  `project create <name> --cwd <path>` + `project <name> add <label>`。
- **账号存储新增 `name` 字段**：旧版无 `name` 的账号**不做迁移**。

### Added

- `project <name> add <label>` / `project <name> remove <label>`：按 `name` 定位账号，落库存 `ilink_bot_id`，展示按 `name`。
- `service install` 的 unit 增加 `EnvironmentFile=-%h/.config/pi-weixin-daemon/env`（`-` 前缀：缺失不致命；用于覆盖 shell 环境变量，例如模型 API key）。
- `accounts` 输出新增 `NAME`（`--name` 标识）与 `SINCE`（登录时间 `savedAt`）。
- `doctor` 新增「模型可用性检查」：解析 `defaultProvider` / `defaultModel`，判断该 provider 是否已配凭据。

### Upgrade

1. **（可选）卸载旧全局 bin**：`pnpm remove -g pi-weixin-daemon`（或 `npm uninstall -g pi-weixin-daemon`）。
2. **安装新的 `pi-wx`**：
   ```bash
   pnpm build
   pnpm pack --pack-destination release
   pnpm install -g ./release/pi-weixin-daemon-*.tgz
   ```
   之后命令变为 `pi-wx`。
3. **处理旧版（无 `name`）账号**：
   旧版 `login`（无 `--name`）保存的账号**只有 `ilink_bot_id`、没有 `name` 标识**。后果：
   - `pi-wx accounts` 里 `NAME` 列显示的是 `ilink_bot_id`（无友好名）。
   - `project <name> add <label>` 按 `name` 定位账号，**找不到这些无 name 的账号**。
   - 已在 `project` 里引用它们的，`accounts` 数组存的是 `ilink_bot_id`（仍能路由），但无法再用 `name` 操作。
   建议处理：
   - 用旧的 `ilink_bot_id`：`pi-wx logout <ilink_bot_id>` 登出无需保留的；
   - 需要保留的账号：先 `pi-wx logout <ilink_bot_id>`，再 `pi-wx login --name <label>` 重新登录（得到 `name`，可用 `project <name> add <label>` 绑定）。
   - 旧项目若 `accounts` 还引用旧 `ilink_bot_id` 且该账号已注销，请用新 `name` 重建绑定（`project create` + `project <name> add <label>`）。
4. **systemd**：单元名未变，`systemctl --user daemon-reload` 即可；如担心可重跑 `pi-wx service install`。

> 无 `name` 的旧账号不会被迁移；`pi-wx` 对它们按 `ilink_bot_id` 展示，需按上面步骤换成带 `name` 的新账号。

---

## [0.2.0]

### Added

- 单 daemon 管理多 Project（`ProjectManager` / `ProjectRuntime`）。
- `account → project` 单向路由；busy/abort/error 为 Project 作用域。
- UDS RPC 控制面 + `project` / `service` / `control` / `login` / `accounts` CLI。
- systemd 用户服务（`service install` / `start` / `logs`）。
- XDG 路径统一（config / data / state / runtime）。
- `login --name`（0.3.0 变为必选）、`pi-wx` 命令名（0.3.0 正式改名）。
