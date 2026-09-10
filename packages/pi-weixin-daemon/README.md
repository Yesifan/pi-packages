# pi-wx（pi-weixin-daemon）

将腾讯微信 iLink Bot 与 [Pi Coding Agent](https://github.com/earendil-works/pi) 直接连接的守护进程。

```text
                 Weixin iLink
          ┌──────────┴──────────┐
     Account A            Account B
          │                     │
      AccountManager  (每账号一个 monitor，独立状态)
          └──────────┬──────────┘
                     │
        account→project 路由
                     │
              ProjectManager
        ┌────────────┴────────────┐
     ProjectController foo   ProjectController bar
      │  cwd + Pi session      │  cwd + Pi session
      │  busy/abort 作用域       │  busy/abort 作用域
      │  weixin_send_file 注入   │  weixin_send_file 注入
      └─────────────────────────┘
```

> 路由的完整说明(用户 → 项目 → 会话,面向非读者)见 [`docs/routing.md`](docs/routing.md)。

## 特性

- **一个 daemon = 多 project**：一次 `serve` 长期运行，一个 Project 绑定一个 Pi 会话（`ProjectController`），按需启停（`project enable` / `disable`）。
- **一个 account 只属于一个 project**：`account → project` 单向映射；一账号绑第二个 project 会报错。未绑定 / disabled 的账号消息直接丢弃，不进入 Pi。
- **busy / abort 是 Project 作用域**：foo 忙、foo 被 abort、foo 出错都不影响 bar（严格故障隔离）。
- **多微信账号**：一次扫码登录一个账号，可重复添加；每个账号独立 monitor，多个账号可绑定到同一 project。
- **TurnContext 回源与广播**：每一轮请求记录来源（account/sender/context_token）。agent 文本回复默认回发起者；
  项目启用广播后，回复会发给项目内**所有**参与者；文件、UI 询问仍只回到发起者。
- **会话空闲自动关闭**：项目会话 10 分钟无消息自动关闭（广播"本次会话已关闭"），下一条消息自动新建会话。
- **每次启动新建会话**：项目启动（含 daemon 重启）总是新建会话，**不跨重启恢复**上一个会话。
- **发送者标记**：入站消息交给 agent 的文本末尾追加 `-- from weixin <账号name>`。
- **同项目互通**：某账号的用户发消息时，通知同项目**其他**参与者 "`<账号name>`: 消息文本"。
- **参与者注册表**：记录每个项目"实际发过消息的 `(accountId, senderId)` + `context_token`"，互通/广播从它取目标
  （不依赖 `account.userId`，避免 `ilink_user_id ≠ from_user_id` 时出错）。
- **Busy / Refuse**：不建消息队列；Agent 忙时新普通消息立即拒绝。
- **控制命令**：`/help` `/status` `/new` `/abort` `/compact`，其中 `/status` `/abort` 在 Agent 忙时仍可用。
- **项目自管理**：项目自己的 `.pi/settings.json`、`.pi/extensions/`、`.pi/skills/`、`AGENTS.md` 完全生效；daemon 运行时能力（`weixin_send_file`、微信 UI 适配）在内存中注入，不写入项目。
- **媒体**：微信图片进入 Pi 多模态输入；微信文件/视频/语音下载到 `<cwd>/.pi-weixin/inbox/`；Agent 可通过 `weixin_send_file` 发送原生微信附件。
- **Extension UI 经微信闭环**：项目 extension 的 `ctx.ui.confirm/select/input/notify` 通过微信完成（WAITING_FOR_UI 状态）。
- 无 HTTP server、无数据库、无消息队列、无 tmux、不经过 PI WEB。

## 安装

要求：Node.js >= 22.19，pnpm **11.x**（本项目已用 `packageManager` 固定为 `pnpm@11.25.0`）。

> ⚠️ 推荐 11.x：pnpm 12 对 `install -g <本地路径/tarball>` 有回归（会把本地路径误当 registry 包名，报 `@scope` 错）。

```bash
git clone <repo> && cd pi-weixin-daemon
pnpm install        # 安装依赖并自动构建 dist
```

把 pnpm 全局 bin 目录加到 PATH（`pnpm config get global-bin-dir`，通常 `~/.local/share/pnpm/bin`）。

### 开发时全局安装（推荐）

```bash
pnpm install -g ./            # 跟随仓库构建
pnpm build && pnpm install -g ./   # 改源码后更新
```

`pi-wx` 指向仓库里的 `dist/index.js`（依赖走仓库 `node_modules`）。

### 自包含（发布/独立安装）

```bash
pnpm build
pnpm pack --pack-destination release   # 产物集中放 release/
pnpm install -g ./release/pi-weixin-daemon-*.tgz
# 更新：重跑 pnpm build && pnpm pack --pack-destination release && pnpm install -g ./release/pi-weixin-daemon-*.tgz
```

tarball 自带 dist 与依赖（在全局 store），安装后**不依赖 repo 目录**。

> `pi-wx service install` 引用**当前运行的二进制**：开发装指向仓库 `dist`，自包含装指向全局 store。

### npm 等价用法

把 `pnpm` 换成 `npm`（npm 全局 bin 目录：`$(npm config get prefix)/bin`），`npm pack --pack-destination release` 与 `pnpm install -g` 分别对应 npm 的 `npm install -g`。

## 使用

### 1. 登录微信账号

```bash
pi-wx login --name personal    # 终端显示二维码，手机扫码（--name 必填）
pi-wx login --name work        # 再次执行，添加第二个账号（须为另一个微信用户）
pi-wx accounts                 # 查看已登录账号（NAME / ID / STATUS / USER / PROJECT / SINCE）
pi-wx logout <账号id|name>     # 登出：清凭据 + 从项目解绑 + 停 monitor
```

`--name` 是账号标识（全局唯一）；账号 **id 仍为扫码返回的 `ilink_bot_id`**（服务端分配，作为 Project 路由 key）。**同一微信用户只可扫码一次**；再次登录同一用户会替换旧账号（按 `ilink_user_id` 去重）。

账号凭据保存在 `$XDG_DATA_HOME/pi-weixin-daemon/accounts/`（默认 `~/.local/share/pi-weixin-daemon/accounts/`，可用 `PI_WEIXIN_DATA_DIR` 覆盖），不写入项目。

### 2. 诊断

```bash
pi-wx doctor --cwd /path/to/project --account <id>
```

### 3. 启动 daemon + 注册 Project

```bash
# 装 systemd 用户服务 + 启动（前台由 systemd 托管）
pi-wx service install
pi-wx start

# 登录微信账号（--name 标识，id 仍为 ilink_bot_id；同一用户只扫一次）
pi-wx login --name personal
pi-wx login --name work

# 创建 Project 并把账号（按 name）绑定进去
pi-wx project create foo --cwd ~/code/foo
pi-wx project foo add personal
pi-wx project create bar --cwd ~/code/bar
pi-wx project bar add work

# 启用 + 查看
pi-wx project enable foo
pi-wx project enable bar
pi-wx project list
pi-wx accounts
```

### 4. systemd（用户级）

```bash
pi-wx service install   # 写入 ~/.config/systemd/user/pi-weixin-daemon.service（解析 CLI 绝对路径，不 sudo）
pi-wx start             # systemctl --user start pi-weixin-daemon
pi-wx logs              # journalctl --user -u pi-weixin-daemon
```

日志为 JSON 结构化输出（pino），直接适配 journald。`Restart=on-failure` 会在崩溃后自动拉起；`TimeoutStopSec=15` 配合 daemon 的优雅关闭。

### 配置 Pi 模型 API key

daemon 通过 Pi SDK 运行模型，需要对应 provider 的凭据。若运行时报 `No API key found for the selected model`，先看 `pi-wx doctor` 的 `model availability` 一项：

- **default provider** 由 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel` 决定（如 `deepseek` / `anthropic` / `openai`）。
- 各 provider 对应一个**环境变量**（`deepseek`→`DEEPSEEK_API_KEY`，`anthropic`→`ANTHROPIC_API_KEY`，`openai`→`OPENAI_API_KEY` …），可在 `pi` 的 `pi login` / `providers.md` 里查到。

两种配置方式：

1. **交互终端用**：把 key 写到 `~/.pi/agent/auth.json` 或用 `pi login`（写入该文件）。
2. **systemd 服务用**（推荐，key 不进单元的明文）：
   ```bash
   printf 'DEEPSEEK_API_KEY=sk-xxx\n' > ~/.config/pi-weixin-daemon/env
   chmod 600 ~/.config/pi-weixin-daemon/env
   # 让服务读取它
   systemctl --user edit pi-weixin-daemon
   # 在 [Service] 加一行：
   #   EnvironmentFile=%h/.config/pi-weixin-daemon/env
   systemctl --user restart pi-weixin-daemon
   ```

> 系统化说明：`pi-wx` 的服务运行在 systemd 下，**不继承 shell 环境变量**。如果你只在 shell 里 `export DEEPSEEK_API_KEY=...`，交互终端可用，但服务里拿不到——必须写到 `auth.json` 或通过 `EnvironmentFile` 注入。

运行可靠性环境变量（同样需要通过 `EnvironmentFile` 注入 systemd 服务）：

- `PI_WEIXIN_TURN_TIMEOUT_MS`：单个 Agent 回合的最长运行时间，默认 `1800000`（30 分钟），`0` 关闭 watchdog。
- `PI_WEIXIN_ABORT_GRACE_MS`：回合超时并发送 abort 后等待 Pi 停止的时间，默认 `10000`（10 秒），`0` 表示无限等待。
- `PI_WEIXIN_UI_TIMEOUT_MS`：等待微信 UI/权限答复的时间，默认 5 分钟。

## 微信内命令

| 命令               | 说明                                     | 忙时可用 |
| ------------------ | ---------------------------------------- | -------- |
| `/help [command]`  | 显示全部或指定命令帮助                   | ✓        |
| `/status`          | 项目 / session / Agent / 模型 / thinking | ✓        |
| `/abort`           | 中止当前任务                             | ✓        |
| `/new`             | 新建会话                                 | 仅空闲   |
| `/compact`         | 压缩会话                                 | 仅空闲   |
| `/model`           | 分页选择模型，可设为项目默认             | 仅空闲   |
| `/thinking`        | 选择思考强度，可设为项目默认             | 仅空闲   |
| `/resume [latest]` | 列出或恢复最近会话                       | 仅空闲   |
| `/reload`          | 重载当前 Pi 会话配置和扩展               | 仅空闲   |
| `/p:<prompt>`      | 显式把文本作为 prompt 发送给 Pi          | 仅空闲   |

模型和会话列表每页 5 项；选择交互支持字母、页码和 `q`，30 秒超时。只有 `/resume`
选择会暂时阻塞项目，Pi UI ask 始终优先。项目默认值写入 `<cwd>/.pi/settings.json`。
其它 `/xxx` 一律回复「未知命令」，不会透传给 Pi。

## Agent 能力

- **`weixin_send_file(path, caption?)`**：daemon 内存注入的工具（不写入项目 `.pi/extensions`，普通 `pi`/PI WEB 会话不可见）。自动发送到当前 Turn 的微信用户；仅要求文件存在且为普通文件（文件名 sanitize），**不设路径边界**——权限模型 = agent 进程权限，与 bash/read/write 一致（可发 `cwd` 之外 agent 可读的文件）。
- **入站媒体**：图片 → 多模态输入；文件/视频/语音 → 下载到 `<cwd>/.pi-weixin/inbox/<message-id>/` 并在 prompt 中说明路径。`.pi-weixin/` 会自动加入项目 `.gitignore`。
- **Extension UI**：项目 extension 调用 `ctx.ui.confirm/select/input` 时，daemon 进入 `WAITING_FOR_UI`，通过微信与用户交互（其他账号仍 busy）；`ctx.ui.notify` 直接推送消息。`ctx.ui.custom()` resolve undefined、`ctx.ui.editor()` 降级为输入框、`ctx.ui.theme` 返回真实最小 Theme 对象；其余 TUI 专属原语 no-op 不 throw。
- **runner-level settings 不支持（W8）**：`resourceLoader` 层的项目配置正常生效；runner 级 settings（如 `sessionDir`）在 daemon 内不支持。

## 架构

```text
Tencent/openclaw-weixin          # 微信协议参考（MIT，见 LICENSE.attribution，协议细节见 docs/ilink-protocol.md）
        │ 提供微信协议参考
        ▼
   Weixin Transport / AccountManager   # src/weixin/ + src/accounts/（每账号 monitor，先门后下）
        │
        ▼
   ProjectManager                      # src/projects/（desired → diff → restart；Map<ProjectId, ProjectController>）
        │
        ├─ ProjectController  →  SessionController  →  PiSdkHost (src/pi/)  →  项目 cwd
        └─ UDS RPC（控制面）→  CLI project/service/control/login
```

依赖方向：`weixin → accounts/projects → sessions → pi`。**只有 `src/pi/` import Pi SDK**（含类型，eslint 强制）；业务层只见领域类型与 port；`daemon.ts` 做组合。

## 配置与存储（XDG）

- 配置：`$XDG_CONFIG_HOME/pi-weixin-daemon/config.json`（project 配置，daemon 唯一 writer，原子写）。
- 账号凭据：`$XDG_DATA_HOME/pi-weixin-daemon/accounts/`（凭据 + 索引；旧 `~/.local/state/pi-weixin-daemon/weixin/accounts` 会自动无损迁移）。
- 状态：`$XDG_STATE_HOME/pi-weixin-daemon/weixin/`（sync-buf / context-token）。
- UDS：`$XDG_RUNTIME_DIR/pi-weixin-daemon/daemon.sock`（0600）。

## 测试

```bash
corepack pnpm test          # 单元 + fake 集成 + 真 Pi SDK 集成 + UDS RPC 集成
```

层：单元（busy 状态、命令路由、路径校验、账号存储、媒体解密）、fake 集成（A 忙不影响 B、回复广播/互通、空闲关闭、UI 路由、多 project 隔离）、真 Pi SDK 集成（项目 extension、`weixin_send_file`）、Daemon/UDS RPC 集成（project create / `<name> add` / list / enable、account.logout、DaemonNotRunningError）。

真实微信 E2E（扫码、多账号、媒体收发、重启等）需要真实账号，见 `test/integration/`。

## License

MIT。微信 transport 移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT），详见 [LICENSE.attribution](LICENSE.attribution)。
