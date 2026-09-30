---
"@yesifan/pi-subagents": patch
---

Add mutually exclusive `disallowedTools` role denylists that filter built-in and extension tools, including dynamic re-registration, while preserving saved role policies across asks and recovery. Change the built-in `explore` role to exclude `edit`, `write`, and `bash` instead of allowlisting only built-in search tools; available extension tools remain usable, so this is not a strict read-only guarantee.
