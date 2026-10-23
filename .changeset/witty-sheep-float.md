---
"@yesifan/pi-weixin-daemon": patch
---

Keep the project runtime and active/default session unchanged when an account owner changes. Only rebuild the affected receiver and clear its Weixin token caches, avoiding timing-dependent project restarts during account reloads.
