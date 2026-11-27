---
name: smart-queues
description: Inspect Smart Queues routes and recover an incomplete queued-message handoff through its public CLI.
---

# Smart Queues

Automatic routing batches human-authored messages behind busy chats. The model
chooses `steer`, `new-chat`, `queue` or `combine` and an ordered prefix count.
Never rewrite a queued instruction or manipulate the plugin's SQLite ledger.

Use these commands when the user requests inspection or an explicit route:

```sh
omnyo smart-queues status --json
omnyo smart-queues route THREAD_ID new-chat --count 2 --json
omnyo smart-queues route THREAD_ID steer --count 1 --json
omnyo smart-queues route THREAD_ID combine --count 2 --json
omnyo smart-queues route THREAD_ID queue --count 1 --json
omnyo smart-queues classify THREAD_ID --json
omnyo smart-queues restore JOB_ID --json
```

`route` selects front messages. `classify` uses the configured existing
subscription and acts on a busy queue. `restore` applies only to incomplete
handoffs and receipts that still match. A changed receipt requires inspection.
The retained destination stays held after restoration. Report visible failures
instead of deleting messages or canceling a retained destination.

Pause or resume automatic routing only when requested:

```sh
omnyo plugin config smart-queues set enabled false
omnyo plugin config smart-queues set enabled true
```

Do not rotate credentials, create accounts, add provider spending, push or
publish as part of routing. New chats inherit applicable user constraints and
existing authority. Mention Omnyo chats using `@thread:THREAD_ID`.
