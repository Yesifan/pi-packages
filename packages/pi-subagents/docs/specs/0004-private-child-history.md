# Spec 0004：新 Child History 不参与普通 Pi 发现

---

status: completed
execution_time: "2026-10-10 / 2026-10-10"
commit: null
version: null
related_documents:
  - "[Spec 0002](0002-prompt-and-session-storage.md)"
  - "[ADR-0004](../adr/0004-private-child-history.md)"
  - "[权威规格](yesifan-pi-subagents-spec.md)"

---

## 1. 范围与批准边界

用户仅批准新建 subagent histories 不参与普通 Pi discovery；没有批准禁止独立打开。本规格替代已完成 Spec 0002 的 D3 普通发现行为和 D4 新 history 默认 cwd 分组位置，不改写其历史决定或完成记录。D2 独立打开、exact-path 恢复、其余 metadata/生命周期/授权契约保持不变。Spec 0003 不在范围内。

新 child 使用 public `SessionManager.create(cwd, privateDir)`，其中 `privateDir` 为 `<getAgentDir()>/subagents/histories`。该目录在 Pi 普通 `<agentDir>/sessions` 扫描根之外，SDK 不再额外追加 cwd 分组；JSONL 文件名、header、entry、模型和 thinking 恢复仍由 SDK 管理。不应用 CLI `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、global/project settings `sessionDir`，不继承 root CLI override；`PI_CODING_AGENT_DIR` 仍决定 agentDir。

不新增 index、input/switch/session-start guard、owner marker、全局关系扫描或新工具；不改 mtime，不修改 root history，不搬迁、删除、标记或迁移既有 Spec 0002 histories。存量记录仍以保存的 ID+实际绝对路径恢复，普通发现可能继续列出存量默认目录 histories。更早被 Spec 0002 排除的 legacy stores 仍不加载。

## 2. 路径、权限与兼容

```text
<getAgentDir()>/subagents/
  sessions/<owner-sessionKey>.json
  locks/<rootKey>/
  histories/<SDK-generated-session-file>.jsonl
```

保持现有排他预创建 0600 空文件、public `SessionManager.open(file, directory, cwd)` 写入有效 header 的适配。检查实际 history directory 及其 ancestor chain 为 ordinary nonsymlink directories，SDK 创建后仅把本次新建目录设为 0700；既有目录权限不改。不再扫描无关的普通 Pi sessions/cwd groups，其 symlink 不应阻止 private history 创建。损坏、不安全或不可写的实际路径 fail closed，仍不是 filesystem sandbox 或全部 TOCTOU 保护。

Parent metadata schema、root lock 与 exact history identity 不变。新目录使新 histories 不成为默认 list/listAll/picker/continue 候选，但不阻止读取或独立打开；整树锁仍不协调用户直接写入 child JSONL 的竞争。

## 3. 锁定 SDK 证据与可见性边界

基线为 catalog/lockfile Pi 1.0.0 的实际安装产物：

- `dist/core/session-manager.js`：`create(cwd, sessionDir)` 直接使用 custom directory；`list(cwd)` 扫描默认 cwd group；默认 `listAll()` 只扫描普通 sessions 根的直接子目录及其中 JSONL；`continueRecent(cwd)` 只在其选定目录找历史。
- `list(cwd, privateDir)`、`listAll(privateDir)`、`continueRecent(cwd, privateDir)` 可显式访问新 histories。
- `dist/main.js`：`--session /explicit/file.jsonl` 直接解析为文件路径；`SessionManager.open(file)` 无目录访问限制。

因此“不参与普通发现”仅指默认目录查询：用户显式设置 CLI/env/settings sessionDir 指向 private directory 或主动以 SDK 查询该目录时，仍能发现；显式文件打开/resume/继续聊天仍允许。没有 SDK exclusion flag，也不承诺隐藏于所有第三方 discovery 或提供安全隔离。

## 4. 验收与验证

1. 使用隔离的临时 `PI_CODING_AGENT_DIR` 和真实锁定 SDK；不调用真实模型，不写用户状态。
2. 新 child 为有效 native JSONL，位于 privateDir；新文件 0600、新目录 0700，existing permissions 保留，CLI/env/settings override 不传播。
3. 同 cwd ordinary session 与新 header-only/有消息 child 并存时，默认 `list`/`listAll` 不列 child，默认 `continueRecent` 返回 ordinary session；显式 private-directory 查询、continue 和 explicit file open 正常。
4. 存量默认目录 history 按 exact identity 恢复，路径/内容不改，仍可被普通 discovery 列出。
5. 实际 agentDir/subagents/histories ancestor symlink 和 non-directory 拒绝；无关普通 sessions symlink 不拒绝；保留恢复 identity/header/realpath 校验测试。
6. 每阶段 Biome 格式化，受影响包 typecheck、完整测试、build、pack 内容检查与文档链接检查。

2026-10-10 验证：tests-first 确认旧实现的 9 项相关测试失败；修改后 39 项 child-session 测试通过，受影响包 typecheck、完整 21 文件 / 245 项测试、build、pack 均通过。新 Spec/ADR 已在 tarball 中，无测试、AGENTS 或开发配置混入；变更及新 Markdown 的 52 个相对链接全部可解析，改动源码/测试/package.json 已按根 Biome 格式化。独立审查由主代理后续执行，本记录不声称已复审。未运行实际交互 TUI/CLI 手测或真实模型；这里的 discovery 验收基于锁定 SDK API 直接测试。
