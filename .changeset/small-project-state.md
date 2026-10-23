---
"@yesifan/pi-weixin-daemon": patch
---

Persist shared default session identities in daemon-owned state at the XDG state directory's `projects.json`, without writing CLI-owned project configuration. Read legacy configuration defaults as a fallback and scope runtime state to each project's name and cwd.
