---
"@yesifan/pi-weixin-daemon": patch
---

Simplify internal Pi adapters, login records, account lifecycle state and monitor retry handling without changing CLI, RPC or Weixin behavior. Remove unused internal helpers and forwarding modules; keep Pi session operations behind PiSdkHost and preserve exact recipient tokens and session lifecycle safeguards.
