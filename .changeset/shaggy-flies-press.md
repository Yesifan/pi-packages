---
"@yesifan/pi-weixin-daemon": minor
---

BREAKING: Unify Weixin recipients around each project's bound accounts and their saved `userId`, removing the observed-participant registry. Agent replies, typing and notifications can now reach bound users before they speak in the current daemon process; directed output goes to the source account's saved user. Missing user IDs, exact recipient context tokens or transports are skipped rather than borrowing another sender's token. Inbound project routing remains unchanged and does not add sender identity filtering.
