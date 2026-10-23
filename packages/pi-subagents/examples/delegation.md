# Name-based delegation

Create two independent tasks in one assistant turn:

```json
{"name":"reviewer","agent_type":"explore","prompt":"Review authentication; report evidence without editing."}
```

```json
{"name":"tests","agent_type":"general","prompt":"Run the authentication tests and report failures."}
```

Creation and ordinary follow-up return `status: "submitted"`: local preparation is saved and the SDK prompt has been called, not necessarily started or completed. Do not poll or repeat submitted work. While relevant reports are pending, provide a brief progress update and wait for their automatic reports before giving the final answer.

Follow up with the exact full name from the structured result:

```json
{"name":"reviewer","prompt":"Check whether the reported issue also affects password reset."}
```

To adjust an actively streaming task (not an idle or child-waiting task):

```json
{"name":"tests","prompt":"Prioritize the password-reset tests.","isSteer":true}
```

Steering uses public `session.steer()`: `steered` means queued, not necessarily consumed before the original run ends. Handled input is not queued. Skills/templates expand and extension commands are rejected. No separate run or report is created; follow-up asks remain busy until outstanding calls and cleanup finish. Cancellation during an input hook cannot promise zero enqueueing.

Names are case-sensitive and unique among one parent's direct children, including completed children. A different parent may independently have a child named `reviewer`. Old `id` arguments are not supported.

Automatic reports include a validated absolute JSONL path when available. Read it only when additional conversation context is needed; it is not a complete system-prompt/tool-definition snapshot.
