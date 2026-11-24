# Prediction repair failure modes

- A finished chat must have a suggested reply. On 20 November 2026, 18 of 22
  finished Inbox chats had none: the prompt let the model omit a reply when the
  work was complete, and its authority rule made it decline even a forced request
  whose only next step was a release the user still had to request. Finished
  chats and forced requests now require a reply through the prompt and output
  schema, and a result without one fails validation. A suggestion may ask for the
  approval the assistant awaits, because the user reads and sends it, but never
  for more than the assistant proposed. Only work that owns the next step permits
  an omission. A finished chat's stored result without a reply is predicted again
  by the sweep, which skips results already held for the current basis;
  dismissals are kept.

- New turns clear the visible prediction state, but must preserve the separate
  last-failure diagnostic. Diagnostics RPC/CLI reads must never warm a chat or
  request inference. Retain only one safe record per chat; remove it on deletion.
  Native status/error codes and HTTP status require exact-format parsing and an
  allowlist. Never log raw provider errors, prompts, responses or credentials.
  Preserve a fixed cause category for SDK/operation deadlines, HTTP failures,
  allowlisted transport codes, native RPC failures and native process/output
  failures. Old records without a cause remain readable with `cause: null`;
  unknown errors retain no arbitrary error text. SDK timeouts use the transient
  timeout message and the existing bounded retry schedule.

- Hiding or leaving a composer detaches its local view without canceling the
  shared prediction. Reopening must reuse the same completed source and generation.
  Explicit cancellation still aborts inference; dismissal suppresses repeats while
  preserving the completed archive-readiness assessment in optimistic UI, shared
  work and persisted state. New turns still invalidate the assessment.
- Suggestion admission excludes pending interactions, queued messages and live
  chat work. Background admission also waits for owned running or waiting work, so a
  verdict is formed once from a settled chat. Recheck admission after inference.
- Background inference is serial and checks the native Codex profile’s included allowance.
  A finished chat must not wait behind another chat's inference before admission:
  admit it at once, publish checking, and hold only its inference for the shared
  slot, latest finished chat first and ahead of sweeps. Otherwise its assessment
  stays stale and a finished-turn notification leaves before the suggestion exists.
  Transient failures retry with bounded backoff; permanent configuration, model and
  version failures wait for an explicit Retry.

The protected RPC and the Codex child process own these checks.

- A prediction uses a normal ephemeral turn with no execution environments.
  Codex loads the global AGENTS.md even with a zero project instruction budget.
  A dedicated profile separates sign-in from the user's everyday config. Refuse
  inherited instructions, enabled MCP servers and custom inference routes before
  sending the transcript.
- Read managed sign-in and rate limits on the child that will run the turn.
  Require known included allowance and explicit zero paid credits. Missing
  allowance or changed account state stops the attempt. A retry reads new values.
- Read the exact completed source and work basis. The source host need not have
  pool routing, a public coordinator URL or a native checkpoint. A changed
  source cancels the request and discards late output.
- Preserve only fixed error categories across the worker and composer. Provider
  response text, conversation content and credentials belong outside diagnostics.

- Read state does not gate background inference: successful visible root chats
  are eligible whether read or unread, without a mounted composer.
- Archive readiness is a separate advisory assessment in the same model call.
  A null suggestion does not establish completion. The native response must
  include a boolean verdict and a bounded reason; malformed assessments fail.
- The combined host response and protected prediction prompt require daemon
  protocol 262. Missing archive assessments fail validation.
- Stale archive-readiness results follow the same source sequence, cancellation
  and final admission checks as next-message suggestions. They never mark or
  archive a chat.

- A shared five-second signal across sequential readiness requests can expire
  before callback inspection begins. Each request needs its own deadline; run
  independent checks concurrently. Resources gets eight seconds because its
  nested host reads already have five-second bounds.
- "Checking chat work status timed out" usually means the server event loop
  was blocked, not that the work summary is slow. On the VPS, deleted-chat
  history purges and incremental vacuum steps of 0.5–8 seconds caused every
  observed long stall on 28–29 October 2026. On the saturated two-core VPS,
  loopback reads also took 5–10 seconds: the 5-second readiness read failed
  103 times while its 10-second sibling reads failed 13 times. Readiness
  therefore shares the plugin's 10-second read budget. Check `Event loop
stalled` and `Slow DB query` server logs before changing that budget.
- Enqueue background candidates without repeating readiness in warm, drain and
  prepare. Admission runs once per request and again before publishing a result.
  A readiness failure names the failed check and never accepts a stale verdict.

- Typing must not deactivate pending results or hide loading/failure state. Keep draft text untouched; the composer shows the suggestion, its Send action and Tab insertion only while the draft is empty. A cache read must display a valid ready result before admission reads finish, and completed results/dismissals must survive plugin reload with source-sequence validation. Archive inspection failure must not invalidate a valid next-message suggestion or manufacture a positive completion verdict.

- Coordinator startup can precede worker reconnection. Re-seed that host’s idle root chats on `host-connected`, preserving serial inference and completed-source deduplication. A temporary unavailable machine must not require opening every chat manually.

- A worker disconnect during inference clears that interrupted source and shows the unavailable-machine error. Reconnection regenerates it automatically; completed caches and ordinary provider failures remain deduplicated.

- Startup backfill must not delay newly completed chats behind older candidates. Keep one inference in flight, but put new completions ahead of queued startup work; completed cache reads never start another inference.

- Opening a chat must not generate or wait. The composer renders bootstrap and realtime state in its first paint and never calls `request` on open; the conversation reveal never waits for inference. The state lives in an app-wide store, so a composer remount cannot hide and re-show it.
- A background attempt that ends idle or failed must not depend on the composer to retry it. Bounded transient retries and a three-minute sweep requeue it; reading prediction state never queues inference.
- Repeated status notifications for archived chats must not republish unchanged idle state or take the serial queue. Closed chats are skipped until unarchived; unchanged invalidations bump neither the generation nor realtime.
- A stalled native prediction must not block the serial queue. Each prediction has a four-minute deadline, then fails as transient and retries later.
- Generations stay monotonic across plugin restarts, so an app-wide store never ignores newer server state as older.

- A prediction that fails because its machine is offline must not exhaust bounded retries. Classify a transient failure as machine-unavailable when the host is disconnected afterwards, drop its source dedupe so the sweep keeps checking, and regenerate it on that host’s reconnection.
- Failures, queued work and readiness changes must not overwrite the stored result. Store only completed results, dismissals and cancellations for their exact source, reuse that row whenever the latest completed source is unchanged, and keep one row per chat. Deleting a chat removes its row; startup prunes rows for already-deleted chats.
- Long native predictions must not hit an earlier host-call deadline than the runner. The host call allows 155 seconds; a shorter deadline kills the host worker and fails unrelated in-flight calls.
- Close the app-server before deleting its temporary working directory. The dedicated login stays in its own profile.

- A verdict is about the conversation, and obligations veto live at every read.
  Telemetry events, status notifications, restarts and job changes must not make a
  formed verdict stale or spend inference. On 1 November 2026 assessments published
  a median of 12 times per completed turn, and a two-turn idle chat reached 79
  obligation revisions.
- A state read must stay free of side effects. `work-changed` refetches thread detail,
  whose bootstrap reads `state`; publishing there made running chats republish about
  every 20 seconds, adding load to a coordinator that was already stalling reads.
- A failed read must not cost a verdict. A background recheck that cannot read the
  chat leaves a finished verdict alone, and validation reads run after the result is
  stored. Failed reads caused 61 prediction failures in 11 hours on a saturated
  coordinator, each previously replacing a verdict or a paid-for result. A
  published skip survives the same way, and the failure names the read that failed
  rather than claiming a Codex thread could not be read.
- An assessment must be the plugin's current decision, not the last result it
  published. Child and no-completed-turn skips publish `skipped`
  with the current basis (archived and hidden chats publish nothing, because the
  basis does not include archive state or visibility and a published skip would
  outlive it), only when the stored assessment differs and never over a
  current available one. Before this, 16 child chats stayed `assessment-stale` and
  3 `assessment-missing`, and old v1-basis skips could never become fresh. The
  sweep visits child chats for this publication only, without inference.
- A positive prediction must pass a check of the same turn's final top-level
  reply before it can be stored or published. An explicit `Not ready:` report
  blocks readiness. Quoted examples, code blocks, sub-agent replies and earlier
  turns are ignored. An unreadable final reply leaves readiness unassessed.
- During an allowance outage, readiness can use a structured report from the
  matching successful turn and latest accepted input. Reply text cannot create
  a positive assessment. A previously checked verdict can be reused for the
  same source turn, conversation basis and assessment version. An explicit
  blocker still keeps the chat open. Forced suggestions show the allowance
  failure.
- Allowance outages last days and retries must outlast them. Retries repeat the
  longest delay. Permanent configuration, model and version failures still wait
  for an explicit Retry.
