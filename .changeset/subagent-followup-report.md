---
"@yesifan/pi-subagents": patch
---

Show every running, completed, and interrupted direct subagent in Markdown status lists without omitting entries, and remind the parent in every report that it can use `ask_subagent` with any listed idle subagent for related follow-up work. Preserve an earlier interrupted status when an unaccepted follow-up run is discarded. Tool results explain how to steer an active run with `ask_subagent` to adjust its direction or add context, and the `subagent` tool description recommends reusing an idle agent for related follow-up work.
