---
"@yesifan/pi-weixin-daemon": minor
---

BREAKING: Frame each local RPC request with a newline so fragmented JSON and UTF-8 are buffered before dispatch. CLI and daemon versions must match; restart the daemon after upgrading. Unterminated requests are never dispatched, including at EOF, and incomplete requests close after 15 seconds of read inactivity. Each connection dispatches only its first request; responses remain EOF-delimited. Request-read timeouts are disabled before dispatch, preserving long-running broadcasts. No legacy protocol detection or automatic retries are added.
