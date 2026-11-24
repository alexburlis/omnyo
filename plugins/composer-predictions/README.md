# Composer Predictions

`omnyo composer-predictions diagnostics <thread-id> --json` reads the last failure
and last skip without requesting inference. The `diagnostics` RPC returns the same
`{threadId, lastFailure, lastSkip}` record. `lastFailure` retains the failure time, stage, request ID,
source sequence, generation, machine, elapsed time, retry schedule and safe public
message. Native failures include only allowlisted status/error codes and HTTP
status. Chat content, credentials and arbitrary provider diagnostics are excluded.
The record survives new turns, successful retries and restarts until the next
failure replaces it; deleting the chat removes it. The server also logs this safe
record under `Prediction failure:`. A null record means no retained failure,
including failures before this logging was installed.
`lastSkip` records the most recent time a prediction did not run for a chat:
`reason` (`busy`, `queued`, `awaiting-answer`, `closed`, `child`, `hidden`,
`no-environment`, `no-completed-turn` or `changed`), a fixed `message`, the
completed-turn `sourceSeq` and `skippedAt`. A repeated reason for the same turn
is recorded once. Server logs use the `Prediction skipped:` prefix with this record.

Bundled into Omnyo as `omnyo--composer-predictions`. The server
prepares a suggestion for every idle, completed chat on any provider before you open it. The
composer renders the prepared state in its first paint from the conversation
bootstrap and an app-wide realtime store, so opening a chat never requests or waits
for inference. The suggestion fills the empty prompt box at its full width as muted
text, with paragraphs and lists preserved, above a "Suggested reply" caption. Send
sends it in one click without focusing the box. After a click in the box it stays
as a lighter shadow with the same controls, so it can be read before Insert or Tab
puts it in the draft as editable text; Cmd+Z undoes the insert and brings the
shadow back. Typing hides it, and Escape or the dismiss control dismisses it.
Leaving an empty box restores the suggestion. Desktop auto-focus does not hide it.
Running turns, submission and new turns invalidate the suggestion.

A finished chat always gets a suggested reply. When no job, callback, loop or
child chat owns the next step, the prediction must return one: completed work, a
pending decision or an approval the assistant is waiting on, such as a release, is
never a reason to omit it. The suggestion may ask for exactly that approval, because
you read and send it yourself, but never for more than the assistant proposed. It
does not resume work you paused, and it suggests reviewing a draft before anything
you have not seen leaves Omnyo. A reply is omitted, with a reason, only while other
work owns the next step. A finished chat's stored result without a reply, such as
one saved before this rule, is predicted again; a dismissed suggestion stays
dismissed.

Force a reply when none is showing or the suggestion is not useful. The caption's
Suggest another reply, Suggest anyway on an omitted reply, the composer's Suggest a
reply button and the Suggest a reply command in the command palette all run
inference now and require a reply even while a loop, job or other chat owns the
next step. The model still will not repeat the latest request unchanged. Chats that
are running, queued or waiting for an answer refuse a forced request and say why. `omnyo composer-predictions request <thread-id> --force`
and the RPC `request` with `force: true` are the same action. Each forced request
uses allowance. Forcing needs an Account Pooler that accepts `force`; an older one
fails with “Update Account Pooler to suggest a reply on demand.” and ordinary
predictions keep working.

The server prewarms successful chats on every provider, including already-read chats, at startup, when chat state
changes and every three minutes. It runs one background prediction at a time, bounds each to four minutes and checks the Codex subscription’s included allowance. After a restart, stored predictions for unchanged chats are restored in parallel without waiting behind new inference, and the most recently active chats are predicted first. Pending questions, queued or scheduled messages, and active chat work exclude a chat. Archived chats are skipped, and unchanged idle state is never republished. Running or waiting work the chat owns, such as a job, child chat or callback, delays background inference until it clears. Core vetoes the archive recommendation live while it is open. Eligibility is checked again before accepting the result. Leaving or hiding the composer keeps the shared prediction;
explicit cancellation and dismissal still stop it. Transient machine, transport, readiness and timeout failures retry automatically after 1, 5 and 20 minutes and then every 20 minutes, ahead of the waiting queue. A failure caused by an unavailable machine never exhausts its retries: the three-minute sweep keeps checking it and the machine’s reconnection regenerates it immediately; exhausted allowance retries after 30 minutes and then every 90 minutes until it returns, unless a current assessment or an explicit blocker settles the turn; configuration, model and version failures wait for an explicit Retry.

## Account and allowance

Every chat provider, including Claude Code, uses a Codex subscription already
connected to Account Pooler. Enable Codex routing and keep an eligible account
in the pool. Before sending chat text, Account Pooler checks included allowance
and an explicitly zero credit balance. If no account qualifies, Composer
Predictions reports the allowance problem and uses its existing retry schedule.

The prediction uses a bounded transcript of accepted inputs and completed
assistant messages. It excludes attachment contents and tool output, and marks
earlier omissions when the history exceeds the budget. The request disables
tools and returns a structured reply and assessment. The prediction uses the
model in Composer Predictions settings, which defaults to `gpt-6.1-sol`.
Cached suggestions and dismissals for unchanged chats remain available.

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

Agents can use `report_chat_outcome` to send the outcome and its evidence, or
the blocker and next action, outside the visible reply. Reports apply only to
the input and successful turn they came from. A reported blocker overrides a
positive prediction. Older replies with explicit `Not ready:` reports can
still keep a chat open.

When prediction allowance runs out, a current report can supply the
assessment. A previously checked prediction can be reused for the same turn,
conversation basis and assessment version. Without usable evidence, readiness
stays unassessed. Forced suggestions show the allowance failure.

When a completed prediction has no suggested reply, which happens only while
other work owns the next step or for results saved before finished chats required
one, the composer shows
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
(`ready`, `reason` and `waitingOn`, the external event or null); it is null before a successful prediction. A new turn or queued work clears both assessments. Open work withholds the recommendation in core without touching the stored verdict or suggestion. Background inference remains serial and checks the same allowance as manual predictions. A chat that just finished is admitted at once and shows as checking while it waits for the inference slot, ahead of background sweeps, with the latest finished chat first; the four-minute deadline starts when its inference starts. `request` reuses the stored prediction for an unchanged completed turn; `omnyo composer-predictions request <thread-id> --fresh` (RPC `fresh: true`) runs inference again for that turn, and `--force` (RPC `force: true`) also requires a reply while other work owns the next step.

When Chat Topics is enabled, the same prediction call also picks the one
type-of-work tag from its list that best fits the chat, or none. A pick is sent
once to Chat Topics as a suggestion, which applies only to an untagged chat or
over an earlier predicted tag. There is no extra model call, the composer does not
show the tag, and a reused cached prediction does not suggest again. If the tag
list cannot be read, the prediction runs without tags and logs a warning.

Completed predictions and dismissals persist per chat and exact completed source sequence through plugin reloads and server restarts. Storage keeps only the latest result per chat; failures, queued work and readiness changes never overwrite it, so a chat whose messages are unchanged reuses it instead of regenerating. Deleting a chat removes its row, and startup removes rows for chats deleted earlier. The conversation bootstrap reads that validated cache, and the first read of a chat the server has not checked queues background inference; draft edits never trigger inference. Each readiness operation has its own timeout. Background admission runs once before
inference; final admission still rejects a result for a conversation that moved on.
The result is stored before that recheck, so a failed read cannot discard it, and a
failed background read never replaces a finished verdict or a published skip.

The plugin renders no card of its own. Its bare composer banner publishes the
current state through `useComposer().experimental_setSuggestion`, and Omnyo's
composer draws it: a ready suggestion, "Suggesting a reply…" with a moving shimmer
while inference runs, "Couldn’t suggest a reply" with its message and Retry after a
failure, or "No suggested reply" with its reason. The plugin adds only the Suggest
a reply button, shown beside Send only while it can be used: the draft is empty and
no suggestion is showing in any state, so it never repeats the loading card with a
spinner of its own. Tab copies the exact complete text.

The server-owned `thread.work` summary supplies the composer status and archive
recommendation. Composer Predictions publishes its existing result with the
work `basis` captured before inference through
`sdk.threads.experimental_publishWork`. The basis identifies the conversation: it
moves only on new input, a started turn or a completed turn. A verdict therefore
stays valid while jobs, telemetry, status changes and restarts come and go. Core
evaluates those live facts at every read and vetoes the recommendation while they
are open. One completed turn needs one inference. When Omnyo compacts an idle
chat on its own before its prompt cache expires, the stored suggestion and verdict
stay current, and the compaction starts no inference.

Cached predictions are restored only when the completed turn, conversation
basis and assessment version still match. Results from older policies are
reassessed. Bump `ASSESSMENT_VERSION` in `contract.ts` when assessment rules
change. A failed attempt may reuse a still-current verdict. Reading prediction
state does not start inference. A skipped running chat publishes nothing, and core
reports its live work instead. A chat that background predictions will not assess,
because it is a child or its last turn did not complete, publishes a
`skipped` assessment with the current basis and that reason, once per basis and
reason. It never replaces an available assessment for the current basis, and it
leaves the chat open. The three-minute sweep also visits idle child chats whose
assessment is not yet that skip; it only publishes the skip and never infers.
Failed and disabled states read the current basis when they have none, so their
reason stays visible. A failure names the read that failed: the chat, its turns,
its work status, its machine or the stored prediction.

The composer shows only a current suggestion, inference in progress, a failed
prediction or a recorded omission. Chat status, its reason and next actors belong
to the chat's status strip (Glance), so they appear once. Disabled and skipped
predictions show nothing in the composer; `omnyo composer-predictions status` still
reports their recorded reason. Only a suggestion whose basis matches current work can be inserted or sent.
Archive eligibility comes from the common server projection. Independent
callback, Resources and decision RPC checks have been removed from this plugin.
