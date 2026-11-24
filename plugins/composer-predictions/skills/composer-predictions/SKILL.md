---
name: composer-predictions
description: Inspect or request the next-message suggestion in a completed Codex, Claude Code or other provider thread.
---

Composer Predictions uses one ordinary Codex app-server turn on the source machine
for every chat provider. It uses the dedicated Codex profile's included allowance.

The server predicts the next message and archive readiness in the background after successful turns on every provider, including already-read chats. Opening a chat shows the prepared state in the first paint from the conversation bootstrap and never requests inference; the source-validated cache keeps only the latest result per chat and survives reloads and restarts, so unchanged chats are not regenerated. A prediction takes several seconds after the turn ends, so the push-notifications plugin holds a finished-turn notification while the prediction is checking, for at most 30 seconds, and opening the chat from that notification shows the ready suggestion. Transient machine, transport, readiness and timeout failures retry automatically after 1, 5 and 20 minutes, and an unavailable machine is retried again when it reconnects; exhausted allowance retries after 30 and 90 minutes; configuration, model and version failures wait for an explicit Retry. Typing preserves pending results, ready suggestions and errors. The suggestion fills the empty prompt box at its full width as muted text above a "Suggested reply" caption; Send sends it in one click without focusing the box. After a click in the box it stays as a lighter shadow with the same controls, Insert or Tab in the empty box inserts it as an editable draft, Cmd+Z undoes the insert, and typing hides it. Running turns, submission, dismissal and navigation suppress stale suggestions.

Inspect the cached state without requesting model work:

```sh
omnyo composer-predictions status <thread-id> --json
```

Read the retained last failure without requesting inference:

```sh
omnyo composer-predictions diagnostics <thread-id> --json
```

The `diagnostics` RPC returns the same `{threadId, lastFailure, lastSkip}` record. `lastFailure` includes
failure time, stage, request ID, source sequence, generation, machine, elapsed time,
retry schedule, safe message and allowlisted native error/HTTP codes. Its `cause`
distinguishes SDK/operation timeouts with their known duration, HTTP status,
allowlisted transport codes, native RPC codes, and fixed native process/output
failures. Unknown errors retain only `kind: "unknown"`; raw error text is never
retained. Older records have `cause: null`. New turns,
successful retries and restarts preserve it; the next failure replaces it and chat
deletion removes it. A null record includes failures before diagnostics were installed.
Server logs use the `Prediction failure:` prefix with this same content-free record.
`lastSkip` records the most recent time a prediction did not run for a chat:
`reason` (`busy`, `queued`, `awaiting-answer`, `closed`, `child`, `hidden`,
`no-environment`, `no-completed-turn` or `changed`), a fixed `message`, the
completed-turn `sourceSeq` and `skippedAt`. A repeated reason for the same turn
is recorded once. Server logs use the `Prediction skipped:` prefix with this record.
A `child` or `no-completed-turn` skip is also the chat's `skipped` work
assessment, with that message as its reason; the chat stays open. `closed` and
`hidden` skips are not published, because archive, visibility and parentage are
not part of the assessment basis and a published skip would outlive its condition.
Never infer the current state from a historical failure; inspect `status` separately.

Explicitly request a suggestion and wait for the result:

```sh
omnyo composer-predictions request <thread-id> --json
```

`request` reuses the stored prediction while the latest completed turn is unchanged. Omnyo's automatic compaction of an idle chat before its prompt cache expires is not a new turn and keeps the stored prediction. The work basis identifies the conversation, so a verdict stays valid while jobs and other obligations change; core vetoes the recommendation live while they are open. Add `--fresh` to run inference again for that same turn, for example to compare results after a prompt change. The RPC equivalent is `request` with `fresh: true`. Each fresh request uses allowance.

A finished chat, where no job, callback, loop or child chat owns the next step, always gets a reply: completed work, a pending decision or an approval the assistant awaits never leaves it empty. A finished chat's stored result without a reply is predicted again; a dismissal is kept. Force a reply while other work owns the next step:

```sh
omnyo composer-predictions request <thread-id> --force --json
```

`--force` runs inference now and requires a reply, so a loop, job or other chat owning the next step no longer causes an omission. The model still will not repeat the latest request unchanged. Running, queued and waiting chats refuse a forced request and report why. The RPC equivalent is `request` with `force: true`; `--force` and `--fresh` cannot be combined. In the app, the same action is Suggest another reply on a suggestion, Suggest anyway on an omitted reply, the Suggest a reply button beside Send while nothing is suggested, and the Suggest a reply command. Each forced request uses allowance. It needs an Account Pooler that accepts `force`; an older one fails with “Update Account Pooler to suggest a reply on demand.” while ordinary predictions keep working.

Codex generates suggestions for every chat provider. The machine that ran the chat
needs Codex signed in to the dedicated prediction profile. In a terminal on that
machine, run the sign-in command and use your existing ChatGPT account.

```sh
CODEX_HOME="$HOME/.codex-omnyo-predictions" codex -c 'cli_auth_credentials_store="file"' login
```

On Windows, use a separate PowerShell window.

```powershell
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex-omnyo-predictions'
codex -c 'cli_auth_credentials_store="file"' login
```

The prediction uses the ordinary Codex allowance of that profile. Omnyo checks
available included allowance and an explicitly zero credit balance before sending
the turn. A missing login, unknown allowance, or available paid credits stops the
request. The old Account Pooler prepaid prediction setting is retired.

Use Composer Predictions settings to enable predictions, select the Codex model
(default `gpt-6.1-sol`), or set the executable resolved on the chat's machine
(default `codex`). The plugin ignores saved backend choices from older versions.

The same prediction call returns an advisory archive-readiness verdict and a short
reason. Ready means the whole requested outcome is delivered with proportionate
evidence and no material obligation remains. Earlier commitments and later
corrections still count. A finished plan, audit, draft, preparation step or bounded
handoff does not wait for unrequested implementation or a possible next project.
A missing screenshot, timed-out test or disclosed limit matters only when it
leaves the requested result unestablished. Verified offered updates do not wait
for owner installation unless installation was explicitly requested.

The chat’s archive control uses this assessment. External acceptance blocks only when it is
part of the requested finish line; a requested submission is complete after
verified submission. Decisions, approvals, access or work still owed by the user
or agent are not external waits. This advice never authorizes implementation or
archives a chat.

Agents use `report_chat_outcome` to record an outcome and evidence or a blocker
and next action. Answer the user normally. Reports apply only to the matching
input and successful turn. A reported blocker overrides a positive prediction.
Older replies with explicit `Not ready:` reports can still keep a chat open.

When prediction allowance runs out, a current report can supply the assessment.
A previously checked prediction can be reused for the same turn, conversation
basis and assessment version. Without usable evidence, readiness stays
unassessed. Forced suggestions show the allowance failure.

When a completed prediction has no suggested reply, the composer shows
“No suggested reply”, its recorded `noSuggestionReason` and Suggest anyway, except
when waiting on an external event or ready to archive. In those cases, only the
chat status appears, unless the user requested the reply; a requested reply that
the model declines always shows its reason. This reason explains
the omission separately from archive readiness; it does not establish a live
background job or external wait. The `status` and `request` CLI commands and RPCs
include `noSuggestionReason` as a string or null. Null means no omission reason
was recorded, including results cached before this field existed. Those results
show “This prediction did not record why it omitted a reply.” without requesting
new inference. A suggestion, new turn or dismissal clears the omission reason.

The `status` and `request` CLI commands and RPCs expose `archiveReadiness`
(`ready`, `reason` and `waitingOn`, the external event or null); it is null before a successful prediction. A new turn or queued work clears both assessments. Open work withholds the
recommendation in core without touching the stored verdict or suggestion. Background inference remains serial and checks the same allowance as manual predictions. A chat that just finished is admitted at once and shows as checking while it waits for the inference slot, ahead of background sweeps, with the latest finished chat first; the four-minute deadline starts when its inference starts.

When Chat Topics is enabled, the same prediction call also picks the one
type-of-work tag from its list that best fits the chat, or none. A pick is sent
once to Chat Topics as a suggestion, which applies only to an untagged chat or
over an earlier predicted tag. There is no extra model call, the composer does not
show the tag, and a reused cached prediction does not suggest again. If the tag
list cannot be read, the prediction runs without tags and logs a warning.

Each readiness operation has its own timeout. Background admission runs once before
inference and waits for owned running or waiting work to clear; final admission still
rejects a result for a conversation that moved on.

Suggestions display in full, with paragraph breaks and lists preserved. Tab
copies the exact complete text.

Predictions use accepted inputs and completed assistant messages in source order.
Each input is labelled by sender so the suggestion reflects what the user writes.
Tool outputs, attachments and provider diagnostics stay out of the transcript.
The context is bounded, and earlier omissions are marked. The runner rejects
inherited instructions and tools before submitting chat text. The conversation
and the prediction are never logged by this plugin.

Archive assessments also expose `ask` and `recap`. `ask` names the single
user decision, approval, access or information required to continue, or is null
when the user owes nothing. A ready assessment always has a null ask. `recap`
summarizes the result and changes since the user's last message in at most two
sentences. Older assessments default both fields to null. Composer Predictions
publishes these fields with the assessment for the server-owned Inbox state and
reason. A private report supplies the outcome or next action as the recap.
