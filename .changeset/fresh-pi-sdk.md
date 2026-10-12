---
"@yesifan/pi-weixin-daemon": minor
"@yesifan/pi-system-prompt": minor
"@yesifan/pi-subagents": minor
---

Upgrade the workspace Pi SDK baseline from 1.0.0 to 1.1.0.

BREAKING: Require Node.js 22.19.0 or newer consistently across the workspace, including pi-system-prompt. Pi 1.1.0 renames the Azure provider from `azure-openai-responses` to `azure`; users of that provider must update their authentication and model/settings configuration. Existing subagent histories using the old provider can fail to resume rather than silently fall back.

### Azure configuration migration

Before starting Pi or restarting pi-weixin-daemon:

1. Back up the affected Pi configuration files. In the active agent directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`), rename the provider key `azure-openai-responses` to `azure` in `auth.json`, or run `/login` in Pi again for Azure.
2. Rename the provider key in `models.json`. In user and project `settings.json` files, update `defaultProvider`, provider prefixes in `enabledModels` patterns, and provider prefixes in `modelThinkingLevels` keys from `azure-openai-responses` to `azure` where present.
3. Keep existing `AZURE_OPENAI_*` environment variables unchanged; the provider rename does not require renaming them.
4. Restart Pi and pi-weixin-daemon after updating configuration, then verify the selected provider/model before sending a prompt.

Old Azure sessions may fall back to another model when resumed, and their prompt cache is not reused. pi-subagents rejects an unavailable historical model or SDK fallback, so updating configuration alone does not guarantee old Azure child histories can be asked again. This upgrade does not rewrite or migrate persisted session histories. Start new sessions/subagents using the `azure` provider when necessary.

BREAKING: The upgraded SDK changes tool filtering: non-empty allowlists without an MCP entry can retain MCP tools, and `*` in excluded tool names is interpreted as a wildcard. Strict exact-name role filtering compatibility is an unresolved upgrade blocker and must be addressed before this release is merged.
