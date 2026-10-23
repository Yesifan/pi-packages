---
"@yesifan/pi-weixin-daemon": minor
---

BREAKING: CLI account selectors now accept unique, case-sensitive names only, while account-selection RPCs accept registered IDs only. Project RPCs require accountIds and reject the legacy accounts field. Online selection uses the daemon account list; logout and doctor fall back locally only on definite connection failure. Upgrade CLI and daemon together and restart the daemon.
