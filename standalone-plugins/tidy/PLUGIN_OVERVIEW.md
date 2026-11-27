# Tidy

Tidy displays core's Ready to archive recommendations and owns its existing
user-directed Archive and Not done controls.

- Readiness comes from `thread.work.archive.recommended` in batched list/detail
  snapshots. Core owns the assessment basis, live obligations and unknown evidence.
- Completion means the whole requested outcome is delivered with proportionate
  evidence and no material obligation remains. Only the user can accept a narrower
  finish line. A bounded plan, audit, draft or handoff completes only that requested
  deliverable, not a larger implementation or experiment after a partial attempt.
  Refusals and stopped runs leave unmet outcomes unfinished. Agents continue safe
  recoverable work or report the exact required gate, without endless retries or
  optional blockers. Unrequested later stages and waiting for the user to install
  an already delivered update do not by themselves keep a finished request open.
- Agents report the result or blocker separately using `report_chat_outcome`
  when available. Without an assessment, readiness stays unassessed. Current
  core obligations remain authoritative.
- Not done persists until new accepted input. Reading and shelving do not change
  the underlying work status.
- Archive submits the current basis to `threads.experimental_archiveReady`.
  Core rejects a changed basis or a withdrawn recommendation. Manual archive
  remains a separate Omnyo action.
- Workspace notes are advisory. Tidy does not duplicate runtime, callback,
  question, child or Resources classifiers.
- The existing service subscribes to `work-changed`, status and placement events,
  rereads only the changed chats and resyncs on reconnect. It does not poll
  predictions. A failed read keeps the last known list and reports it as stale.
- Archive proposals are pinned approvals above the proposing chat's composer
  (`api.ui.requestInput` with the `archive-approval` renderer), never transcript
  content. They persist until answered, withdrawn or seven days old.
- The page, row marker and CLI share the same Tidy recommendation
  snapshot. The existing `ready_ids` RPC and window broadcast remain for those
  integration callers. Sidebar work labels consume core directly.

Core work status has six finite display labels. Completion assessment availability,
required/optional attention, unreadness and placement are separate facts.
