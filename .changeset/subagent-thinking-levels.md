---
"@yesifan/pi-subagents": minor
---

**BREAKING:** `thinking` now accepts only `off`, `low`, `medium`, `high`, and `max`, both as the `subagent` tool parameter and in `agents/*.md` frontmatter. `minimal` and `xhigh` are rejected with `INVALID_AGENT_DEFINITION` for agent files. Stored role snapshots and inherited parent thinking levels are unchanged, so existing subagent history keeps working.
