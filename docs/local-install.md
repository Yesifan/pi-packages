# 本地安装

在 monorepo 根目录执行。首次使用先安装依赖：

```bash
pnpm install
```

## Pi Extensions

将 `<package-name>` 和 `<package-path>` 替换为实际包名及目录。

```bash
# 基础检查
pnpm --filter @bykwp/<package-name> typecheck

# 临时加载，不写入设置
pi -e ./packages/<package-path>

# 用户级安装；项目级安装时增加 -l
pi install ./packages/<package-path>
pi list
```

进入 Pi，执行 `/reload`，再验证扩展提供的命令或工具。源码修改后通常只需再次执行 `/reload`；修改 `package.json` 的 `pi` 清单或资源目录后应重新运行 `pi install`。

## pi-weixin-daemon

```bash
# 检查并构建
pnpm --filter @bykwp/pi-weixin-daemon typecheck
pnpm --filter @bykwp/pi-weixin-daemon build

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
pnpm --filter @bykwp/pi-weixin-daemon build
pnpm install -g ./packages/pi-weixin-daemon
pi-wx service install
systemctl --user restart pi-weixin-daemon
```

需要运行测试时：

```bash
pnpm --filter @bykwp/pi-weixin-daemon test
```
