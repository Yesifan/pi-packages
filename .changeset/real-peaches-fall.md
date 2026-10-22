---
"@yesifan/pi-weixin-daemon": patch
---

Remove the unused mid-broadcast session guard. An already-started broadcast continues attempting all bound users after a session stops or changes; stale events and deliveries that have not started remain isolated.
