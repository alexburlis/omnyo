---
name: ready-to-archive
description: "Use when asked which chats are finished, Ready to archive or safe to tidy, or why a chat is or is not offered. Agents cannot mark chats: readiness comes from Omnyo's shared work summary. Inspect with Omnyo tidy list, check and show."
---

# Ready to archive

Ready to archive means Omnyo's current work summary recommends archiving. Core
combines the source-bound completion assessment with current work, input and
ownership evidence. Tidy shows the recorded reason and concurrent signals.
The user decides whether to archive. Agents cannot mark or unmark chats, and
cannot archive.

## Before every final response

Before every final response, assess whether the whole requested outcome is delivered with proportionate evidence and no material obligation from that request remains. Include earlier commitments, corrections and explicit user-approved scope changes. Only the user can accept a narrower finish line; do not silently substitute a substep, local trial or handoff for the requested outcome.

A plan, audit, draft, preparation step or handoff is complete only when that bounded deliverable is the user's requested outcome or the user explicitly accepts the changed scope. Once that request is verified, optional polish, speculative follow-up and unrequested later stages do not keep it open.

A provider refusal, partial trial, failed attempt, stopped run or delegated handoff leaves a larger requested outcome unfinished. Report completed parts as progress while the requested outcome remains unmet.

Anything your final response reports as still open, unfixed, unresolved or remaining keeps the chat open, including a defect or stale state you found during this chat's work. Fix it within existing authority before responding, or report the remaining obligation.

Continue recoverable work within existing authority. When a required action cannot proceed safely because authority, access, essential information or an external condition is unavailable, preserve progress and report the exact gate and next actor. Do not retry indefinitely or invent a blocker for optional work.

An approval or outside event matters only when required for the requested finish line. Waiting for the user to install an update you already delivered does not by itself block completion. Foreign workspace changes are not this chat's work.

A missing screenshot, timed-out test or disclosed limit blocks only if it leaves the requested result unestablished. A bare claim of completion cannot close missing core verification or a lost requested deliverable. Finish necessary work within existing authority before responding.

Use `report_chat_outcome` when available to record a verified outcome and evidence, or the material blocker and next action. Answer the user normally and honor their output format. Keep completion bookkeeping out of the reply.

Without an assessment or a report, readiness remains unassessed. Current work, questions and callback guards still apply.

Agents cannot set readiness or archive; Omnyo combines the assessment with current obligations after the turn ends.

The report records the agent's evidence. Core assesses the request and current obligations.

## Inspect readiness

```sh
omnyo tidy list [--project <project-id>] [--json]   every ready chat
omnyo tidy check [<chat-id>|.] [--json]             shared work, reason and workspace notes
omnyo tidy show [<chat-id>|.] [--json]              one ready chat
```

`omnyo tidy check .` reports the shared recommendation, recorded reason, completion
assessment and work snapshot. Run inside the chat's own turn, it reports working
until that turn ends, so it cannot show the chat's own readiness. Waiting reasons come from that snapshot. Workspace notes such as
uncommitted files print under their own advisory heading: they never block
readiness, and in a shared checkout they often belong to other chats. Missing or stale relevant evidence prevents
the core recommendation.

Tidy refreshes on work changes and reconnects. Its Archive action rechecks the
current work basis in core before changing the chat. A concurrent turn or
obligation can withdraw readiness. Reading only changes unread status, and
shelving only changes placement. The ordinary manual Archive action remains
available independently.

## Propose one archive approval in this chat

Run `omnyo tidy propose`. It pins one approval for the ready chats in this
project above the user's composer in this chat, which stays usable. It
stays there until the user archives them, chooses Not now, or none of them is
ready any longer.
A later proposal from the same chat replaces the earlier one. The user can
archive the reviewed chats with one tap; changed chats are skipped. The proposal
itself creates no Inbox prompts and archives nothing.

Do not paste a directive, repeat the chat list or ask the user to confirm in
your reply; the pinned approval is the only place to act. Agents cannot approve
or archive on the user's behalf. Say in one short line that the approval is
pinned above the composer, if you mention it at all.

## Not done

`omnyo tidy dismiss [<chat-id>|.]` is the user's Not done: it hides a chat until
new input arrives in it. An automatic compaction is not new input. Use it only
when the user asks.
