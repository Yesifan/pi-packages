---
"@yesifan/pi-weixin-daemon": patch
---

Buffer RPC response bytes until EOF before decoding and parsing JSON, preserving fragmented UTF-8 responses and rejecting empty or incomplete replies.
