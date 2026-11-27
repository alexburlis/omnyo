# Smart Queues

Routes messages queued behind a busy Omnyo chat. Open **Smart Queues** in the
sidebar to inspect routes and open their chats.

| Route    | Behavior                                                                  |
| -------- | ------------------------------------------------------------------------- |
| Steer    | Send an ordered prefix as a correction to the active work.                |
| New chat | Automatically create a visible chat with exact messages and user history. |
| Queue    | Keep messages for the source chat's next turn.                            |
| Combine  | Deliver related messages together using Omnyo's native grouping.          |

## Batching and cost

The router waits 1.5 seconds after a change, with a maximum three-second burst
window. Each source has one classifier in flight. Changed queues or turns
invalidate old decisions and schedule the changed batch. There is no cooldown.
Idle chats, scheduled messages, retries, failed items and agent messages are
excluded. An unchanged batch is not classified repeatedly.

The default classifier is Claude Haiku 5.5 through the existing Claude Code
subscription, at the default service tier. No API key, account or billable
resource is created. Subscription limits still apply. Check your provider
entitlement before changing the provider or model.

Omnyo's explicit queue-create API currently emits no queue event. The plugin uses
one global queue read per second plus native events. Polling does not call a
model for each message.

## Instruction preservation

The model returns only a route, prefix count and short reason. It cannot edit
message blocks. Steering and grouping retain originals and their order.

A new chat receives every historical user prompt in order and the exact queued
blocks, including attachment paths and mentions. Generated context has separate
delimiters. Prior routing receipts are expanded from retained originals when
building later handoffs.

Before changing the source queue, the plugin saves the originals and complete
destination input in SQLite, creates a held destination, and checks its exact
queued input. It then replaces source items with routing receipts using
expectedUpdatedAt. It never deletes a source row during handoff.

The destination appears immediately and waits until the source and other
active or background work in the same environment finish. An incomplete handoff
stays held and exposes a recovery error. **Restore source** restores receipts
that still match. Originals and held destinations remain available if recovery
cannot be confirmed.

The public SDK has no atomic cross-thread move or atomic snapshot-and-steer
operation. Crash or final send races can retain duplicates. The ledger prevents
instruction erasure during handoff; it does not guarantee exactly-once delivery
or that a model will follow every instruction. Omnyo's manual **Send now** bypasses
dispatch hooks and remains an explicit override.

## Install and operate

```sh
npm ci
omnyo plugin build .
omnyo plugin install .
omnyo plugin config smart-queues set enabled true
```

Automatic routing defaults to off for fresh installations. This installation is
enabled. Pause without removing the ledger, inspect routes, or choose a prefix:

```sh
omnyo plugin config smart-queues set enabled false
omnyo smart-queues status
omnyo smart-queues route thr_example new-chat --count 2
omnyo smart-queues classify thr_example
omnyo smart-queues restore JOB_ID
```

All commands accept --json. Routes select contiguous eligible front messages.
A prefix stops when explicit model, reasoning, permission or service-tier
settings change. Steering requires an active source turn.
Messages queued during an automatic compaction are not routed; they drain after
it. Its end settles a source like an idle turn. An older Omnyo without that
event loads the plugin normally.
A retired classifier stops and removes only this plugin's obsolete prompts from
its positively owned router. Source, destination, human and foreign plugin
inputs remain. A handoff already in progress finishes its ownership transfer.
Cleanup failures appear in the routing ledger and logs; a later router settlement
retries that cleanup. Startup retires interrupted active jobs without scanning
historical jobs. Shutdown waits for already requested classifiers and retires
late spawn results before closing the plugin. After editing, build and reload with
`omnyo plugin reload smart-queues`. The public SDK is pinned to 0.6.15.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
omnyo plugin build .
```

Registered-plugin harness cases use real SQLite. They cover exact history,
attachments and mentions, partial handoffs, concurrent edits and recovery,
source notification failure, execution settings, ordered contradictions,
stopping and stale turns, pause/resume, burst batching and router ownership.
Classifier retirement also covers timeout, terminal lifecycle paths, interrupted
startup, foreign input conservation, cleanup failure and reentrant stop events.
This plugin uses only public SDK entrypoints.
