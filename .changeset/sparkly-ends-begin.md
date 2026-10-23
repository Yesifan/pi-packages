---
"@yesifan/pi-subagents": patch
---

Allow multiple windows on the same root to share subagents across idle handoffs. Acquire the whole-tree lock only for execution, refresh saved state on acquisition, and release after all work, reports, and cleanup finish. Cross-window contention rejects only the current request; no IPC or automatic task forwarding is introduced.
