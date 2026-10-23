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

> 路由的完整说明(用户 → 项目 → 会话,面向非读者)见 [`docs/routing.md`](https://github.com/Yesifan/pi-packages/blob/main/packages/pi-weixin-daemon/docs/routing.md)。

## 特性

- **一个 daemon = 多 project**：一次 `serve` 长期运行，一个 Project 绑定一个 Pi 会话（`ProjectController`），按需启停（`project enable` / `disable`）。
- **一个 account 只属于一个 project**：`account → project` 单向映射；一账号绑第二个 project 会报错。未绑定 / disabled 的账号消息直接丢弃，不进入 Pi。
- **busy / abort 是 Project 作用域**：foo 忙、foo 被 abort、foo 出错都不影响 bar（严格故障隔离）。
- **多微信账号**：一次扫码登录一个账号，可重复添加；每个账号独立 monitor，多个账号可绑定到同一 project。
- **按回合来源投递**：微信发起及扩展触发的独立回合，成功最终文本广播给项目微信用户；CLI 回合按 `--reply` 投递，不重复广播。无最终文本不发送。
- **共享默认 / 活动会话**：每项目保存一个 default，至多加载一个 active 和一个 runtime。微信继续 active；CLI 未指定会话时使用 default。首个成功激活的会话自动成为 default，后续新建/切换不覆盖它。
- **闲置释放、默认恢复**：10 分钟闲置后释放 runtime，保留历史及 default；重启或闲置后按需恢复 default，不恢复临时 active 或进行中的任务。默认历史丢失时明确失败，不静默新建。
- **切换通知**：切换成功向全部项目微信用户通知，与 CLI reply 无关。同会话不重复；无 active 时显式新建/恢复也通知，仅无 active 时按需恢复 default 免通知；已有不同 active 时，普通 CLI prompt 切回 default 也通知。
- **发送者标记**：入站消息交给 agent 的文本末尾追加 `-- from weixin <账号name>`。
- **同项目互通**：某账号收到消息时，通知同项目**其他账号的微信用户** "`<账号name>`: 消息文本"。
- **统一微信用户与投递**：项目用户来自绑定账号的 `account.userId`，所有微信出口使用收件用户及精确对应 `(accountId, userId)` 的 `context_token`。缺少用户、token 或可用 transport 时跳过并记录原因；某个目标失败不影响其他目标。**重启后不需要重新发言，已有精确缓存 token 即可投递**，但不保证服务端接受。入站仍按账号路由，不新增 sender 身份过滤，也不假定 sender 必然等于登录用户。
- **Busy / Refuse**：不建消息队列；Agent 忙时新普通消息立即拒绝。
- **控制命令**：`/help` `/status` `/new` `/abort` `/compact`，其中 `/status` `/abort` 在 Agent 忙时仍可用。
- **项目自管理**：项目自己的 `.pi/settings.json`、`.pi/extensions/`、`.pi/skills/`、`AGENTS.md` 完全生效；daemon 运行时能力（`weixin_send_file`、微信 UI 适配）在内存中注入，不写入项目。
- **媒体**：微信图片进入 Pi 多模态输入；微信文件/视频下载到 `<cwd>/.pi-weixin/inbox/`；语音仅传递微信转录文本及识别错误备注，空转录提示来源账号的微信用户，不下载音频；Agent 可通过 `weixin_send_file` 发送原生微信附件。
- **Extension UI 经微信闭环**：项目 extension 的 `ctx.ui.confirm/select/input/notify` 通过微信完成（WAITING_FOR_UI 状态）。
- 无 HTTP server、无数据库、无消息队列、无 tmux、不经过 PI WEB。

## 安装

要求：Linux、Node.js >= 22.19、`util-linux` 提供的 `flock` 命令，以及 pnpm **11.x**（本项目已用 `packageManager` 固定为 `pnpm@11.25.0`）。控制协调使用内核文件锁，不需要后台锁服务。当前开发与内嵌运行时基线为 Pi SDK 1.4.0。

> ⚠️ 推荐 11.x：pnpm 12 对 `install -g <本地路径/tarball>` 有回归（会把本地路径误当 registry 包名，报 `@scope` 错）。

```bash
git clone <repo> && cd pi-packages
pnpm install        # 安装 workspace 依赖并自动构建 dist
```

把 pnpm 全局 bin 目录加到 PATH（`pnpm config get global-bin-dir`，通常 `~/.local/share/pnpm/bin`）。

### 开发时全局安装（推荐）

```bash
pnpm install -g ./packages/pi-weixin-daemon  # 跟随仓库构建
pnpm --filter @yesifan/pi-weixin-daemon build && pnpm install -g ./packages/pi-weixin-daemon  # 改源码后更新
```

`pi-wx` 指向仓库里的 `dist/index.js`（依赖走仓库 `node_modules`）。

### 自包含（发布/独立安装）

```bash
pnpm --filter @yesifan/pi-weixin-daemon build
mkdir -p release
pnpm --filter @yesifan/pi-weixin-daemon pack --pack-destination "$PWD/release"
pnpm install -g ./release/yesifan-pi-weixin-daemon-*.tgz
# 更新：重跑 build、pack 和 install -g
```

tarball 自带 dist 与依赖（在全局 store），安装后**不依赖 repo 目录**。

> `pi-wx service install` 引用**当前运行的二进制**：开发装指向仓库 `dist`，自包含装指向全局 store。

### npm 等价用法

npm 全局 bin 目录为 `$(npm config get prefix)/bin`。从仓库根目录可运行 `npm pack ./packages/pi-weixin-daemon --pack-destination release`，再用 `npm install -g ./release/yesifan-pi-weixin-daemon-*.tgz` 安装；开发及构建仍按本仓库 pnpm workspace 命令执行。

## 使用

### 1. 登录微信账号

```bash
pi-wx login --name personal    # 终端显示二维码，手机扫码（--name 必填）
pi-wx login --name work        # 再次执行，添加第二个账号（须为另一个微信用户）
pi-wx accounts                 # 分开显示登记（REGISTERED）与实际接收状态
pi-wx project <项目> remove personal  # 删除账号前，先显式解绑
pi-wx logout personal          # 保存登记删除 → 同步停止 → 安全时清理文件
pi-wx reload                   # 在线 daemon 重新应用当前磁盘配置（不改配置）
```

CLI 的账号选择参数只接受 **name**：去除首尾空白、区分大小写；未知或重复 name 明确失败，**不会回退匹配 ID**。配置修改（logout、project add/remove、login 的冲突检查）在共同控制锁内使用最新磁盘登记与凭据解析，不依赖可能滞后的 daemon 列表。

**CLI 是账号登记、凭据、项目配置的唯一写入角色**。所有 CLI 进程共享一把控制锁；daemon 在同一把锁内读取最新快照并完成运行同步。CLI 保存后先释放锁，再通知 daemon，不把保存配置和停止网络任务描述为一个事务：

| 结果 | 反馈 / 退出状态 |
| --- | --- |
| 保存失败 | 非零；不通知 daemon，不清理账号文件 |
| 保存成功，确认 daemon 离线 | 成功；明确待下次启动应用 |
| 保存成功，在线同步成功 | 成功；应用的是当前期望配置，并发命令可能已替代中间修改 |
| 保存成功，同步失败或未知 | 非零；明确已保存、不回滚，可运行 `pi-wx reload` 或重启同步 |
| 删除已应用，仅文件清理失败 | 成功并警告；列出残留路径供手工删除，不恢复账号 |

`logout` 和登录替换旧账号均检查**所有持久绑定，包括 disabled 项目**；有绑定就拒绝，先用 `project <项目> remove <账号name>` 解绑，不隐式改项目。解绑仍会按既有方式重建项目 controller/会话。扫码本身已经发生时，本地拒绝保存不表示能够撤销远端登录。

删除以从 `accounts.json` 保存移除为提交点，随后等待同步停止。只有确认旧接收任务已停止（或取得单实例锁证明没有 daemon），才重新取得控制锁、再次检查同 ID 未重新登记并核实当前停止状态，然后逐文件尽力清理。socket 不存在/拒绝连接**不等于安全离线**。无法确认停止就保留文件，必须先停止相关运行任务再手工清理；重新登记则跳过清理，不能误删新账号凭据。清理警告不承诺敏感文件已消失；不自动扫描、重试或提供清理命令。

`accounts` 显示持久登记与实际 receiver 状态；登记已删但停止失败的 receiver 仍会列出。无可用凭据的登记账号不会启动 monitor。`project list/show` 分开显示 CONFIGURED、期望 ENABLED 与实际 STATE；daemon 不可用时显示 unknown，不把未知状态说成已停止。启动时某项目失败仍保留管理入口和其他健康项目，日志和 `daemon.status.applicationError` 明确说明配置未全部应用；后续同步仍以失败结果返回，直到问题修复。凭据和索引是分别原子保存的文件，登录先保存凭据再提交登记；中途失败可能留下孤儿凭据，重启只按索引恢复。

**BREAKING / 升级：先停止旧版 daemon，配套更新 CLI 与 daemon，再运行 `pi-wx start`。** 旧版不参与共同锁，不能与新版 CLI 混用。项目创建/绑定/启停/删除和 `account.logout` 写入 RPC 已移除；新 `control.sync` 只请求读取当前配置，`control.status` 只读取实际 receiver 集合，二者以及项目 restart 校验配置/数据/状态目录身份。内部配置和路由仍使用 accountId，不新增账号格式迁移。

`--name` 是全局唯一的账号标识；账号 **id 仍为扫码返回的 `ilink_bot_id`**。同用户登录会替换无绑定的旧账号（按 `ilink_user_id` 去重）；相同 ID 的有效凭据变化也会先停旧 monitor 再启动新实例。旧 owner 的微信 token 缓存不会继承到新 owner；收件范围按当前绑定账号用户解析。项目历史和活动会话属于项目，不属于某个账号 owner：仅 owner/凭据变化不会重建项目会话，新 owner 继续使用项目当前会话；项目绑定、cwd 或启停变化仍按原有规则处理。不维护参与者注册表。

账号凭据保存在 `$XDG_DATA_HOME/pi-weixin-daemon/accounts/`（默认 `~/.local/share/pi-weixin-daemon/accounts/`，可用 `PI_WEIXIN_DATA_DIR` 覆盖），不写入项目。

### 2. 诊断

```bash
pi-wx doctor --cwd /path/to/project --account personal
```

`--account <name>` 可重复；省略时检查全部账号。在线使用 daemon 列表选择账号，仅在明确离线（socket 不存在或连接被拒绝）时改用本地列表，因此仍可在启动 daemon 前诊断。其他 RPC 错误会报错，不静默回退。

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

### 4. 向项目用户广播通知

```bash
pi-wx broadcast --project foo --message "部署已完成"
```

须先启动 daemon，且 project 必须处于启用状态。通知直接发送给该项目所有绑定账号的扫码登录用户，不经过 Pi；没有活动 Pi 会话或 Pi 正忙也可发送，不改变会话状态。

发送需要缓存中精确对应账号和扫码用户的 `context_token`。缺少接收用户、token 或可用 transport 时跳过并记录日志；某个账号失败不阻断其他账号。不检查 token 的本地有效期，微信接口仍可能拒绝发送。此接收范围与 Agent 成功最终回复一致，共用用户解析及投递规则。

CLI 等待处理完成，详细成功、跳过和失败记录通过 `pi-wx logs` 查看。只有非空接收集合全部发送成功时退出码为 `0`；存在跳过、失败、没有绑定账号或请求错误时为 `1`。普通 RPC 使用 **15 秒 socket 空闲超时**：连接连续无活动才超时，持续收发数据会重置空闲计时，因此它不是请求总时限。广播禁用这一客户端空闲超时，等待处理完成；底层微信请求仍有各自超时。

不自动重试；长文本可能已部分送达，CLI 断开也不代表 daemon 停止发送，再次执行可能重复通知。不提供跨 daemon 重启补发保证。

### 5. 从 CLI 使用项目共享会话

```bash
pi-wx prompt "继续工作" --project foo
pi-wx prompt "检查历史任务" --project foo --session <session-id>
pi-wx prompt "开始新任务" --project foo --new-session --reply caller --reply user:all
pi-wx prompt "生成摘要" --project foo --reply user:<user-id>
```

`--session` 与 `--new-session` 互斥；省略时使用 default，即使当前 active 是另一个会话也会切回 default。切换是全项目共享的，下一条微信消息也进入新的 active。首个成功激活会话自动设为 default；已有 default 时新建只改变 active。默认历史损坏或丢失可显式新建后用微信 `/default` 修复。

`--reply` 可重复，默认 `caller`；支持 `caller`、`user:all` 和 `user:<id>` 组合，微信目标去重。ID 是绑定账号的 `account.userId`（可通过 `pi-wx accounts` 查看），非账号 ID；未知或跨项目用户在会话变更前拒绝。未选择 caller 不返回成功正文，但仍返回 session ID、执行状态、错误和可用投递结果；模型执行失败与微信投递失败分别报告。

CLI 向 stdout 输出单个 JSON 结果（非流式）：

| 字段 | 含义 |
| --- | --- |
| `sessionId` | 会话 ID，可用时返回 |
| `status` | `success`、`error`、`aborted` 或 `waiting` |
| `text` | 成功最终正文，仅选择 caller 时返回 |
| `error` | 执行失败或中止原因，可选 |
| `messages` | 本次响应累积的询问、通知、进度及 warning，可为空数组；不是最终正文 |
| `delivery` | 成功最终文本的微信投递计数 `{ succeeded, skipped, failed }`，可选；不统计文件工具或切换通知 |

`waiting` 表示需要回答，不是任务完成。`error`/`aborted` 或 delivery 有失败/跳过时退出码为 `1`，其余为 `0`。参数校验、busy 或 RPC 等请求失败向 stderr 输出 `error: ...` 并退出 `1`，不保证返回 JSON。

CLI 回合的 `ctx.ui.notify` 和 `weixin_send_progress` 写入 `messages`，随等待/完成响应返回，不实时推送微信；即使未选择 caller 也保留这些辅助消息。

CLI 等待完成或返回文字询问；需要确认、选择、输入时，再运行同项目 `pi-wx prompt "回答" --project foo`。**同 project 的所有本地 CLI 调用视为同一可信来源，可互相回答**，不是每个终端独占询问。回答沿用原任务 session/reply，不因省略 session 切回 default；显式切到其他 session 或新建不能消费询问。微信不能代答 CLI 询问，CLI 也不能代答微信询问。超时/取消不自动批准。

每个项目仍只有一个任务，不排队；忙时拒绝新任务及会话切换，其他项目不受影响。daemon 未运行、项目不存在/停用、空白 prompt 或非法目标明确失败。不自动重试；客户端断开不保证取消，再次提交可能重复执行或投递。

### 6. systemd（用户级）

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

- `PI_WEIXIN_TURN_TIMEOUT_MS`：可选的单个 Agent 回合最长运行时间；默认 `0`，即不限制。设置为正整数可启用 watchdog。
- `PI_WEIXIN_ABORT_GRACE_MS`：回合超时并发送 abort 后等待 Pi 停止的时间，默认 `10000`（10 秒），`0` 表示无限等待。
- `PI_WEIXIN_UI_TIMEOUT_MS`：等待微信 UI/权限答复的时间，默认 5 分钟。

## 微信内命令

| 命令               | 说明                                     | 忙时可用 |
| ------------------ | ---------------------------------------- | -------- |
| `/help [command]`  | 显示全部或指定命令帮助                   | ✓        |
| `/status`          | 项目 / active 与 default / Agent / 模型 / thinking | ✓        |
| `/abort`           | 中止当前任务                             | ✓        |
| `/new`             | 新建并切换 active，无 active 时也创建；不覆盖已有 default | 仅空闲   |
| `/compact`         | 压缩会话                                 | 仅空闲   |
| `/model`           | 分页选择模型，可设为项目默认             | 仅空闲   |
| `/thinking`        | 选择思考强度，可设为项目默认             | 仅空闲   |
| `/resume [id\|default\|latest]` | 无参数分页选择；按 ID/default 恢复；latest 仅无 active 时恢复最近历史 | 仅空闲 |
| `/default [id]` | 将当前 active 或指定 ID 设为 default，不强制切换 active | 仅空闲 |
| `/reload`          | 重载当前 Pi 会话配置和扩展               | 仅空闲   |
| `/p:<prompt>`      | 显式把文本作为 prompt 发送给 Pi          | 仅空闲   |

模型和会话列表每页 5 项；选择交互支持字母、页码和 `q`，30 秒超时。只有 `/resume`
选择会暂时阻塞项目，Pi UI ask 始终优先。模型/思考强度默认值写入 `<cwd>/.pi/settings.json`；默认会话身份由 daemon 写入独立的运行状态 `projects.json`，不写控制配置 `config.json`。相同 cwd 的项目可读取同一 Pi 历史，不引入会话所有权登记；不接受其他 cwd 的任意历史路径。
其它 `/xxx` 一律回复「未知命令」，不会透传给 Pi。

## Agent 能力

- **`weixin_send_file({ path, caption?, userId? })`**：daemon 内存注入的工具（不写入项目 `.pi/extensions`，普通 `pi`/PI WEB 会话不可见）。微信回合默认发送到来源账号的微信用户；CLI 或无来源独立回合未指定 `userId` 时默认发给项目全部微信用户；显式 `userId` 必须是项目绑定账号的 `account.userId`，未知或跨项目用户拒绝。工具目标独立于最终文本 `--reply`，caller-only 也可发送微信附件。仅要求文件存在且为普通文件（文件名 sanitize），**不设路径边界**——权限模型 = agent 进程权限，与 bash/read/write 一致（可发 `cwd` 之外 agent 可读的文件）。
- **入站媒体**：图片 → 多模态输入；文件/视频 → 下载到 `<cwd>/.pi-weixin/inbox/<message-id>/` 并在 prompt 中说明路径；语音 → 仅使用微信提供的转录文本，追加 `【以上为用户的语音转录的信息，可能有识别错误】`，不下载或携带音频。空转录回复来源账号的微信用户「未获取到语音转录文本，请重新发送语音或改用文字。」，没有其他有效输入时不调用 Pi。`.pi-weixin/` 会自动加入项目 `.gitignore`。
- **`weixin_send_progress({ update })`**：微信回合仅向来源账号用户发送，CLI 回合进入 JSON `messages`；无活动回合时拒绝，不支持 `userId`，不进入最终正文。
- **Extension UI**：CLI 回合使用上节的文字询问与下一次 prompt 回答机制；微信回合中，项目 extension 调用 `ctx.ui.confirm/select/input` 时，daemon 进入 `WAITING_FOR_UI`，向来源账号的微信用户发送询问，且只接受该账号对应用户的回答（其他账号仍 busy）；`ctx.ui.notify` 直接推送消息。`ctx.ui.custom()` resolve undefined、`ctx.ui.editor()` 降级为输入框、`ctx.ui.theme` 返回真实最小 Theme 对象；其余 TUI 专属原语 no-op 不 throw。全部公开 UI 方法在 Pi SDK 包装后的扩展上下文中仍可调用。
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

依赖方向：`weixin → accounts/projects → sessions → pi`。**只有 `src/pi/` import Pi SDK**（含类型，Biome 强制）；运行会话业务统一经 `SessionRuntimePort → PiSdkHost → SDK`，不另设 PiSessionHost 转发层。host 内部工厂、扩展回调及 UI/事件适配保留；版本/环境诊断通过独立 `sdk-info` 入口，不操纵活动会话。业务层只见领域类型与 port；`daemon.ts` 做组合。

## 配置与存储（XDG）

- 配置：`$XDG_CONFIG_HOME/pi-weixin-daemon/config.json`（project 控制配置，CLI 唯一 writer，原子替换；cwd 创建后固定）。
- 账号凭据：`$XDG_DATA_HOME/pi-weixin-daemon/accounts/`（CLI 写凭据 + 索引；旧 state 布局仅由 CLI 保存入口或 `serve` 前置步骤在锁内兼容迁移；daemon 本身只读）。
- 接收进度和 context-token：当前与凭据同处 `accounts/`，由 daemon 运行时维护；旧布局在 state 的 `weixin/`。
- 项目运行状态：`resolveStateDir()/projects.json`（默认 `~/.local/state/pi-weixin-daemon/projects.json`，可用 `PI_WEIXIN_STATE_DIR` 覆盖），daemon 唯一 writer；按项目保存 `cwd` 和 `defaultSessionId`，与 CLI 控制配置分离。旧 `config.json` 中的 `defaultSessionId` 仅作只读兼容，不再由 daemon 写回。
- UDS：`$XDG_RUNTIME_DIR/pi-weixin-daemon/daemon.sock`（0600）。

数据目录中的 `.control.lock` 与 `.daemon.lock` 是固定的内核锁锚点，**不要删除锁文件**。控制锁最多等待 30 秒，超时明确失败；单实例锁覆盖 daemon 初始化到停止，不靠 socket 推测运行状态。锁随文件描述符关闭/进程退出释放，无 stale 锁回收器。请让 CLI/daemon 使用相同 XDG/覆盖路径，并使用支持 `flock` 的本地文件系统；不要让不同配置实例交叉共享配置或账号目录。管理操作串行，但各账号长轮询独立异步运行，不占额外长期线程/进程。

控制面每个连接只处理一个请求：请求是以换行符 `\n` 结束的单行 JSON，响应是以 EOF 结束的 JSON；两端均缓冲完整消息后再解码，支持 UTF-8 分片。daemon 接收完整请求前使用 15 秒空闲超时，开始执行后关闭该读取超时，避免中断长广播。未带换行的旧客户端请求不会执行，CLI 与 daemon 必须配套升级并重启；不自动重试。

## 测试

在 monorepo 根目录运行：

```bash
pnpm --filter @yesifan/pi-weixin-daemon test        # 默认离线
pnpm --filter @yesifan/pi-weixin-daemon test:ci     # 同一套离线测试；GitHub CI 使用此命令
pnpm --filter @yesifan/pi-weixin-daemon test:watch  # 离线 watch
pnpm --filter @yesifan/pi-weixin-daemon test:model  # 可选：真实模型发送文件冒烟，会消耗额度
```

默认配置只收集 `test/unit/` 和 `test/integration/`，模型冒烟单独收集 `test/model/`，不依赖固定文件名排除。离线测试验证 pi-wx 的消息、媒体、路由、busy/abort、广播、命令、UI、自有 trust 策略及 SDK 适配接线；不重复测试 Pi 自身的磁盘扩展发现、trust 继承或资源隔离机制。

离线测试包括 fake transport/runtime 业务链路、真实本地 UDS RPC，以及不调用模型的 SDK UI 包装回归。SDK 测试使用独立临时 agent 目录，不修改用户的 trust 或会话记录。

模型冒烟只验证真实模型调用 `weixin_send_file`，检查路径、caption、当前发送对象及实际会话更换后的工具可用性。微信出口仍是 fake transport，不会实际发送微信；单次模型回合限时 60 秒，错误或超时明确失败，不静默跳过。

冒烟仅使用环境变量中的 provider 凭据，不读取用户的 `auth.json`。默认选择第一个可用模型；建议同时指定 `PI_WEIXIN_TEST_PROVIDER` 和 `PI_WEIXIN_TEST_MODEL`，例如：

```bash
# 先通过环境变量提供 ANTHROPIC_API_KEY
PI_WEIXIN_TEST_PROVIDER=anthropic PI_WEIXIN_TEST_MODEL=claude-sonnet-4-5 \
  pnpm --filter @yesifan/pi-weixin-daemon test:model
```

缺少可用凭据或指定模型不可用时明确失败。真实微信扫码、媒体送达等仍需使用真实账号手动验证。

## License

MIT。微信 transport 移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT），详见 [LICENSE.attribution](LICENSE.attribution)。
