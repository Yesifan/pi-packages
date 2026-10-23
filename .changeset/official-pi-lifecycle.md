---
"@yesifan/pi-subagents": minor
"@yesifan/pi-weixin-daemon": patch
---

BREAKING: Subagent creation and ordinary asks return submitted after local persistence and SDK submission, rather than a synchronous started handshake. Steering uses public steer with skill/template expansion and extension-command rejection; queued does not guarantee consumption or cancellation rollback. Agents remain busy through outstanding calls and cleanup. History restoration follows SDK defaults/fallback instead of requiring an exact historical model/thinking selection.

During root shutdown, abort captured sessions again if an ordinary prompt resumes from an input hook and starts a run; retain the writer lock until pending calls and cleanup finish.

Use Pi 1.4.0 official session services and lifecycle APIs while retaining history identity, ownership, trust, and role tool policies. Upgrade the daemon's embedded Pi runtime to 1.4.0 and use public UI types without changing Weixin routing or delivery behavior.
