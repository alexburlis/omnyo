# Tidy

Tidy offers chats that Omnyo's shared work summary recommends **Ready to archive**.
The recommendation combines a current completion assessment with the chat's
current obligations. A stopped or idle turn alone does not establish completion.

## What you can do

The Tidy page lists recommended chats with their recorded reason. Archive one,
archive the selected chats, or choose **Not done**. A failed archive keeps the
chat in the list and shows the failure.

When an agent runs `omnyo tidy propose`, Tidy pins one approval for the ready
chats in that project above the composer of the agent's chat, which stays
usable; on phones it shows as a chip that opens when tapped. The user archives
the reviewed chats there or chooses **Not now**; the transcript keeps a
one-line receipt such as "Archived 2 chats", or "Already archived" when the
chats were archived some other way. The approval is stored until it is answered,
re-pinned after a restart or a stopped turn, withdrawn once none of its chats is
still ready, and expires after seven days. Older transcripts that contain an
`::archive-chats` directive show a static one-line note with no buttons.

**Not done** hides the recommendation until a new input arrives. An automatic
compaction is not new input. It also publishes
the existing core work postponement, so sidebar rows, groups and counts update
immediately for connected clients. A failed core update keeps the action available
for retry.
Reading the chat does not clear this override. Unreadness and Shelf placement
remain independent of work status. Hidden, shelved and child chats are not
offered by Tidy.

## One readiness policy

Tidy reads `thread.work` from the core list/detail API. It does not call Composer
Predictions for each candidate or independently inspect questions, callbacks,
Resources jobs and child activity. Core owns those facts and their freshness.
An unavailable work summary stays unavailable and cannot recommend archiving.

The existing service subscribes to core work and placement changes. It reads a
batched snapshot on first load, reconnect, explicit reads and every five minutes as
a repair, and rereads only the chats that changed in between. There is no prediction polling loop. An older
snapshot cannot restore a recommendation after a newer change, and a stream of
changes on one chat cannot hold back another chat's recommendation.

A failed read is not evidence that a chat changed. Tidy keeps the last known list,
reports the failure through `queue.error`, `ready_ids.stale`, the readiness window
event and the existing retry controls, and retries every 30 seconds. Core's archive
check protects the action.
Workspace changes are displayed as advisory notes and do not redefine eligibility.

An explicit archive action calls `threads.experimental_archiveReady` with the
current work basis. Core rechecks the current basis and recommendation before
archiving. Deliberate manual archiving through Omnyo remains available separately.

## Completion reports

Ready means the whole requested outcome is delivered with proportionate evidence
and no material obligation from that request remains. The assessment includes
earlier commitments, corrections and explicit user-approved scope changes. Only
the user can accept a narrower finish line.

A plan, audit, draft, preparation step or handoff can finish a request that asks
only for that deliverable. Optional polish and unrequested later stages do not
keep such a verified request open. These bounded tasks do not let an agent close
a larger implementation, experiment or delivery request after an attempted substep.

A provider refusal, partial trial, failed attempt, stopped run or delegated handoff
leaves the larger outcome unfinished. Completed parts are progress. The agent
continues recoverable authorized work or reports the exact required gate and next
actor when safe progress cannot continue. It does not retry indefinitely or invent
blockers for optional work. Missing core verification and lost requested deliverables
remain unfinished. Waiting for the user to install an update the agent already
delivered does not by itself block completion.

Agents use `report_chat_outcome` when available to record completion and evidence,
or an unmet obligation and the next action. The report stays separate from the reply.
Without prediction allowance, Composer Predictions can use a current report or
reuse a current assessment. Core's work, question and callback guards still
apply. Tidy presents core's recommendation.

## CLI

```sh
omnyo tidy list [--project <project-id>] [--json]
omnyo tidy check [<chat-id>|.] [--json]
omnyo tidy show [<chat-id>|.] [--json]
omnyo tidy propose [--json]
omnyo tidy dismiss [<chat-id>|.] [--json]
```

`.` selects the current chat. `check` returns the same work summary, archive
recommendation and recorded reasons, with the completion assessment on its own
line. A check run inside the chat's own turn reports working until that turn ends.
Workspace notes remain advisory.
`propose` pins the approval described above and returns `{ threadIds, pinned }`
with `--json`. The CLI has no archive command.

## Storage and compatibility

Tidy stores Not done dismissals and the readiness revision in its existing
SQLite database, and open archive approvals in plugin key-value storage keyed
by the source chat and the proposed chat set. Earlier `flags` records remain untouched and are not read.
The page shows at most 100 recommended entries and reports any omitted count.

The `ready_ids` RPC and the existing `omnyo-tidy:readiness` window event remain for
Tidy's installed app integration. They carry `{ threadIds, waiting, revision }`, and the RPC adds `stale`.
Other work-status consumers use core `thread.work` directly. They must not use
Tidy's recommendation list to reconstruct a chat's work status.

## Development

The SDK artifact is produced from the canonical
`omnyo/packages/plugin-sdk` source and pinned in this package and lockfile.
Install the frozen dependency closure and use the declared Node/compiler tools.
Run the focused tests, typecheck, lint, formatter check and `omnyo plugin build`.
The
standalone package/install scripts retain their exact old-state binding.
