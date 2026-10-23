---
"@yesifan/pi-weixin-daemon": minor
---

BREAKING: move account registration, credentials and project configuration writes to CLI commands coordinated with the read-only daemon by Linux util-linux flock. Stop the old daemon before upgrading CLI and daemon together.

CLI account selectors accept unique, case-sensitive names only, never IDs. Configuration changes resolve names from current disk state under the shared lock. Legacy account/project mutation RPCs are rejected; use CLI configuration commands and `pi-wx reload` to apply current state.

Separate saved configuration, runtime application and best-effort account cleanup. Reject deletion or login replacement while bound, allow confirmed-offline saves, rebuild monitors on credential changes, and expose receivers that remain after a failed stop. AccountManager now owns cancellation and receive tasks; late receive/download work cannot write caches or dispatch after cancellation. Confirm receiver shutdown before removing files; report residual files for manual cleanup without rolling back saved configuration.

Rebuild same-name project instances when their working directory changes between desired-state snapshots, including coalesced deletion and recreation.
