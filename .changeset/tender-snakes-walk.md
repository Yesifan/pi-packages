---
"@yesifan/pi-weixin-daemon": patch
---

Propagate credential deletion errors other than missing files so logout cannot silently unregister an account or report successful cleanup after a deletion failure.
