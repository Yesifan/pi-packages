# 本地安装

在 monorepo 根目录执行。首次使用先安装依赖：

```bash
pnpm install
```

## Pi Extensions

将 `<package-name>` 和 `<package-path>` 替换为实际包名及目录。

```bash
# 基础检查与构建
pnpm --filter @yesifan/<package-name> typecheck
pnpm --filter @yesifan/<package-name> build

# 临时加载，不写入设置
pi -e ./packages/<package-path>

# 用户级安装；项目级安装时增加 -l
pi install ./packages/<package-path>
pi list
```

进入 Pi，执行 `/reload`，再验证扩展提供的命令或工具。源码修改后先重新构建，再执行 `/reload`。修改 `package.json` 的 `pi` 清单或资源目录后应重新运行 `pi install`。

### 旧入口迁移

通过包名或包目录安装的配置可直接升级。直接加载、筛选或禁用扩展时，按以下路径更新配置：

| 扩展 | 旧入口或目录 | 新入口 |
| --- | --- | --- |
| `pi-session` | `src/index.ts` | `index.js` |
| `pi-subagents` | `dist/index.js` | `index.js` |
| `pi-system-prompt` | `extensions/` 或 `extensions/system-prompt.ts` | `index.js` |

路径相对于各自的包根目录。若配置用 `-` 前缀禁用旧路径，更新路径时保留前缀。

## pi-weixin-daemon

```bash
# 检查并构建
pnpm --filter @yesifan/pi-weixin-daemon typecheck
pnpm --filter @yesifan/pi-weixin-daemon build

# 从工作区全局安装 CLI
pnpm install -g ./packages/pi-weixin-daemon

# 验证
pi-wx --version
pi-wx doctor --cwd /path/to/project
```

### systemd 用户服务

```bash
# 安装服务并启动
pi-wx service install
pi-wx start

# 查看状态和日志
systemctl --user status pi-weixin-daemon
pi-wx logs

# 重启服务
systemctl --user restart pi-weixin-daemon
```

源码修改后重新构建、安装并重装服务：

```bash
pnpm --filter @yesifan/pi-weixin-daemon build
pnpm install -g ./packages/pi-weixin-daemon
pi-wx service install
systemctl --user restart pi-weixin-daemon
```

需要运行测试时：

```bash
pnpm --filter @yesifan/pi-weixin-daemon test
```
