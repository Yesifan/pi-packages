# 开发文档：如何本地安装与更新扩展

本说明针对对 `pi-system-prompt` 进行开发的人群，讲清楚两件事：

1. 开发时如何把这个扩展安装到本地的 Pi。
2. 源码修改后，如何让改动生效（更新扩展）。

> 前提：假定你已经在用 Pi（`pi` 命令可用）。开发目录为仓库根目录
> `/home/ye/code/pi-system-prompt`，下文简称为「本地路径」。

---

## 1. 本地安装（开发时）

Pi 安装包（package）的命令是 `pi install`。这个仓库本身就是一个 Pi 包，
因为根目录 `package.json` 里有：

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

`./extensions` 里的 `system-prompt.ts` 会被 Pi 当作扩展加载。

### 方式一：用户级（写进 `~/.pi/agent/settings.json`）

```bash
# 绝对路径
pi install /home/ye/code/pi-system-prompt

# 相对路径（相对于当前目录；也可以写相对于 settings 文件所在目录）
pi install ./path/to/pi-system-prompt
```

安装后，`settings.json` 的 `packages` 数组里会多一项指向本地路径，例如：

```json
{
  "packages": [
    "/home/ye/code/pi-system-prompt"
  ]
}
```

### 方式二：项目级（写进 `.pi/settings.json`）

如果只想在某个项目里启用：

```bash
pi install -l /home/ye/code/pi-system-prompt
```

`-l` 表示写入项目设置（`.pi/settings.json`）。

### 关键点：本地路径不会被复制

本地路径（local path）与 npm / git 包不同：**Pi 直接把本地路径加进
settings，而不会拷贝一份副本**。也就是说，Pi 加载的就是仓库里的那份源码，
`extensions/system-prompt.ts` 改了就等于是「已安装版」改了，不需要重新拷贝。

### 安装后生效

新安装的扩展需要让 Pi 重新加载：

- 在当前会话里输入 `/reload`，或
- 重启 Pi。

完成后即可使用：

```
/system-prompt
```

---

## 2. 源码修改后如何更新扩展

因为本地路径不拷贝，所以「更新」通常**不需要重装**。按下面顺序做即可：

### 步骤 1：确认注册的是本地路径

```bash
pi list
```

能看到 `pi-system-prompt`、且来源（source）是本地路径（不是 `npm:` / `git:`），
就说明扩展直接读磁盘上的源码。

### 步骤 2：改源码

直接编辑仓库里的文件：

- `extensions/system-prompt.ts` —— 命令逻辑。
- `README.md` / `docs/*` —— 说明文档。

例如之前修复的 `ENOENT` 问题，就是删掉了 `extensions/system-prompt.ts` 里
写 `.pi/system-prompt.txt` 的 `writeFileSync` 调用。

### 步骤 3：让改动生效

由于是本地路径，改完源码后在当前会话执行：

```
/reload
```

（或者重启 Pi。）Pi 会重新加载 `./extensions` 下的扩展，改动立即生效。

> 注意：`/reload` 重新加载的是「已注册的包」。如果改了扩展文件名、或者
> 新增/删除了扩展文件，有时需要重新 `pi install <path>` 让 Pi 重新解析
> 包资源清单（`package.json` 中的 `pi` 字段变化时尤其如此）。

### 什么时候才需要重新 `pi install`?

只有当本地路径在 settings 里的注册信息需要刷新时才要重装，例如：

- 改了 `package.json` 里的 `pi` 字段（新增/移除扩展、技能、提示模板等）。
- 改变了包的目录结构。
- 你想把注册从相对路径改成绝对路径。

此时再执行一次 `pi install <path>`，Pi 会重新解析资源并更新 settings。

```bash
pi install /home/ye/code/pi-system-prompt   # 刷新注册（本地路径）
```

---

## 3. 常用命令速查

| 目的 | 命令 |
|------|------|
| 安装（用户级，绝对路径） | `pi install /home/ye/code/pi-system-prompt` |
| 安装（项目级） | `pi install -l /home/ye/code/pi-system-prompt` |
| 查看已装包 | `pi list` |
| 移除 | `pi remove /home/ye/code/pi-system-prompt` |
| 仅本轮临时生效（不写入 settings） | `pi -e /home/ye/code/pi-system-prompt` |
| 源码改动后让扩展生效 | 会话内 `/reload`（或重启 Pi） |
| 注册信息需要刷新时 | 重新 `pi install <path>` |

---

## 4. 常见问题

**Q：改了源码但 `/system-prompt` 没变？**
A：确认是否执行了 `/reload`；另外确认 `pi list` 里注册的是本地路径而不是
某份拷贝。如果之前是用 `pi install` 装的 npm/git 源，改动的是 git 克隆目录，
需 `pi install git:...@新tag` 移动引用。

**Q：本地路径改了设置文件但想让别的机器/同事共用？**
A：本地路径是机器相关的。若要共享，把仓库推到 GitHub 后改用
`pi install git:github.com/<你>/pi-system-prompt`，或发布成 npm 包
`pi install npm:@you/pi-system-prompt`。

**Q：`/reload` 后会丢失已捕获的 system prompt 吗？**
A：会。`lastSystemPrompt` / `lastRawPayload` 是会话内变量，重载后清空。
重新跑一轮对话后再执行 `/system-prompt` 即可拿到最新值。
