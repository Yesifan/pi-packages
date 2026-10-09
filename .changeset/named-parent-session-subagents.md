---
"@yesifan/pi-subagents": minor
---

**BREAKING:** Address subagents by their exact parent-local names instead of generated agent/run IDs. Store minimal direct-child metadata per parent session in the global agent directory, with child conversation histories in Pi SDK default cwd-grouped session directories. Replace business run/mount/report identities and root epochs with in-memory execution/scope ownership and online report-processing barriers. Restore saved roles and historical model/thinking without parent overrides; unfinished tasks become interrupted and old reports are not replayed. Old project-local and legacy subagent stores are not migrated or loaded, and their agents cannot be asked after upgrading; old files are left untouched. Reports include saved roles and validated complete-conversation paths.
