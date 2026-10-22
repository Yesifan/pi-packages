---
"@yesifan/pi-weixin-daemon": patch
---

Persist each project's default Pi session and restore it on demand after idle release or restart. Automatically use the first successfully activated session as default; add shared active/default selection, explicit new/resume/default controls, and project-wide switch notifications independent of reply targets.

Add `pi-wx prompt` over the local UDS control plane with default, specified, or new-session selection and combinable caller/project-user reply targets. Support text-based interaction answers from subsequent local CLI prompts in the same project, preserve busy rejection and independent Agent-turn broadcasts, and allow project-scoped Weixin tool delivery independently of final reply targets. Report execution and delivery outcomes without automatic retries.
