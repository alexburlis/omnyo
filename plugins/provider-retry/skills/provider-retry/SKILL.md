---
name: provider-retry
description: "Diagnose automatic retries and paused Omnyo threads after transient provider failures or subscription-window limits."
---

# Provider retry

The plugin is enabled on fresh installations. Model overloads, interrupted streams,
temporary connection failures, host connection loss, host daemon restarts and
confirmed HTTP 5xx internal errors retry with
exponential backoff, up to five total attempts. A model still at capacity after
those attempts retries every 15 minutes until the `maximumWait` setting runs
out. The default is `No limit`; an explicit 6-hour or 24-hour cap is preserved.
Authentication, billing, policy and rejected requests stay paused. A structured subscription-window limit with
a reset time queues recovery after the window opens. Core continues accepted
input or re-sends input the provider never accepted; retries preserve the selected
model, tier and permissions.

The chat shows **Paused** with the failure and next action when no recovery is
queued, or a recovery card with its schedule, countdown and blocking wait.
`omnyo thread continue <thread-id> --status --json` and
`sdk.threads.experimental_continuationState` expose the same server-owned message.
Continue never duplicates a scheduled or claimed recovery. `--now` attempts an existing scheduled retry immediately; `--model <model>` selects another model from the same provider without broadening permissions.

A pending retry is an ordinary durable queued row and survives restart. Inspect
it with `omnyo thread queue list <thread-id>` and inspect the failed turn before
manually retrying it; avoid duplicating an existing queued retry.

Use the core `omnyo thread retry` command for an intentional manual retry. Follow
its live help for selection and scheduling flags.

For Account Pooler routes, retry timing comes from the pool’s earliest usable
account for the failed model, including parent pools. A generic provider 429
without quota windows can therefore still schedule a retry. Unknown resets and temporarily unavailable pool sources schedule a slow availability recheck, without promising an account will be ready. Authentication failures remain paused.
When the availability lookup itself fails or times out, the turn retries with
the overload backoff, then a 15-minute recheck after the quick attempts. The next failure checks availability again.

Use `omnyo provider-retry explain [thread-id] [--json]` to inspect the last
recorded decision and why it was skipped. This historical diagnostic survives
restart but does not imply a retry is still pending; use `status` for that.
The plugin RPC `decision.get` accepts `{ threadId }` and returns the same
nullable diagnostic. Decisions before this version was loaded are not backfilled.
