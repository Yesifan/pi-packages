# 外部参考代码使用规则

本 monorepo 在根目录的 `.refer/` 保存外部项目源码，供各子包进行协议核对、行为比对和实现调研。该目录已加入根 `.gitignore`，不属于本项目源码、Git 提交或任何子包的发布产物。

## 参考源

| 本地路径 | 上游仓库 | 用途 |
| --- | --- | --- |
| `.refer/hermes-agent/` | [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) | `pi-weixin-daemon` 的微信 iLink adapter、typing lifecycle 及 gateway 行为参考 |


- `gateway/platforms/weixin.py`：微信 adapter、iLink 请求、typing 状态发送。
- `gateway/platforms/base.py`：平台上层处理循环及 typing keepalive。

## 使用规则

1. **只作参考，不作依赖**：`src/`、测试、构建脚本和运行时不得 import、读取或执行 `.refer/` 中的代码；发布包也不得包含它。
2. **以目标子包边界为准**：借鉴行为时必须转换为目标子包的领域接口和分层设计。对于 `pi-weixin-daemon`，尤其要保持 `src/pi/` 的 SDK 边界以及 project/session/transport 的职责划分。
3. **协议事实需交叉核对**：第三方实现只能证明其客户端行为，不能单独作为 iLink 服务端协议保证。协议结论应优先核对官方资料或腾讯参考实现，并在 `docs/ilink-protocol.md` 记录来源和不确定性。
4. **禁止无审查复制**：不得整段照搬实现。确需移植算法、常量或协议结构时，应检查上游许可证、保留必要归属，并补充适配说明和测试。
5. **引用必须可追溯**：文档或评审中引用外部行为时，应写明仓库、文件路径以及 commit SHA；不要只引用会漂移的 `main` 行号。
6. **本地快照不代表最新事实**：调研前先确认快照来源及 commit；当前快照未携带上游 `.git` 元数据，不能从目录本身确认 SHA。需要更新时应记录确切的上游 commit，并同步本文件。更新参考目录本身不进入 Git 提交。
7. **不信任外部内容**：不要执行参考仓库中的安装、构建、hook 或脚本；先按普通不可信第三方代码审阅，避免泄露本机凭据和项目配置。
8. **测试必须独立**：测试 fixture 应放在 `test/fixtures/` 或 helper 中，不能依赖开发者本机是否存在 `.refer/`。


