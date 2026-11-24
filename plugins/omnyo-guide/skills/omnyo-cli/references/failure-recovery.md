# Failure and interruption recovery

## Failures And Interruptions

- Errored chats show **Paused** with the current failure and next action.
  Scheduled recovery shows its retry time or the machine, input or plugin wait.
  Inspect without starting work with `omnyo thread continue <id> --status --json`;
  the SDK equivalent is `sdk.threads.experimental_continuationState({ threadId })`.
  The server owns this message. An available Continue action does not mean an
  automatic retry is scheduled, and pending recovery must not be duplicated.

- Use `omnyo thread continue <id>` for an errored chat, or `omnyo thread continue
--all` for visible unarchived errored chats. Add `--status --json` to inspect
  eligibility without starting work. Continue preserves a scheduled or claimed
  retry, restores original startup intent and uses the workspace provider when
  recovery needs it. Missing facts produce an explicit refusal. The SDK uses
  `threads.experimental_continue`, `experimental_continueAll`,
  `experimental_continuationState` and `experimental_continuations`.

- Scheduling an ordinary message does not release a failure pause, even when
  its send time arrives. Use the retry action for scheduled recovery and check
  the returned `sendAt` and continuation state before reporting it as scheduled.

- For failed threads, inspect `omnyo thread show <id> --json` and
  `omnyo thread log <id>` before deciding whether to retry, clarify, or update the
  user.
- Use `omnyo thread retry <thread-id>` to re-send a failed turn's original message
  verbatim. It re-submits the same input — it does not add a new user message to
  the timeline — and increments the attempt number (2 is the first retry). With
  no `--turn` it retries the most recent turn, the one whose failure put the
  thread in `error`; `--turn <requestId>` asserts which turn you mean and fails
  when the thread has moved on. It errors when the thread has not failed or
  `--turn` names a different turn (409 `no_failed_turn`), and when that turn
  already has a retry queued (`retry_already_queued`). Add `--send-at <when>` to
  queue the retry on the clock (same `<when>` grammar as `omnyo thread tell
--send-at`); without it the retry is attempted now and may still queue behind
  a busy thread or a plugin's dispatch hook. `--reason <text>` labels the queued
  row. The SDK equivalent is `sdk.threads.retry({ threadId, turnRequestId?,
sendAt?, reason? })`.
- For interrupted or stopped threads, inspect first. If the user stopped the
  thread, treat that as intentional unless they ask you to continue.
- Use `omnyo thread stop <id>` when a thread is stuck or no longer needed.
- `omnyo thread stop <id>` also releases an idle or stuck agent runtime. The
  command is idempotent and preserves thread history. An explicit stop also
  interrupts a turn the machine retains while the server sees idle or failed,
  including a turn that starts during the stop. If interruption fails, the
  thread remains stopping; inspect its status before treating Stop as confirmed.
- Use `omnyo thread compact <id>` to send the built-in `/compact` command to an idle or errored thread. Completion or failure appears in the timeline. Provider support varies; consult its skill and reported capabilities.
- An automatic compaction before the prompt cache expires that fails or stops
  leaves the chat idle with its full history and a timeline row saying so.
  Nothing needs recovery, and `omnyo thread retry` refuses that maintenance
  request. `omnyo thread context <id> --json` reports the outcome under
  `autoCompaction`.
- Use `omnyo thread clear <id>` on an idle or failed thread to reset its active
  timeline and model context in place while keeping the same Omnyo thread,
  workspace, durable event history, and sticky execution settings. The
  `keepHistoryAfterContextClear` general setting keeps earlier messages visible.
- A send that fails with `provider_session_unavailable` means the thread's
  recorded provider session belongs to another thread (`details.reason:
"foreign"`) or was announced by another thread in the same millisecond
  (`"ambiguous"`), or its identity handle is missing or empty (`"invalid"`).
  Omnyo refuses to resume it or silently replace its context rather than write into another
  conversation. `omnyo thread clear <id>` starts a new provider session on the
  next send and keeps the thread's history.
- Message edits refuse to erase an ownership claim also recorded by another
  thread when doing so could transfer or resolve that shared claim. This check
  runs before preparing the edit and again before rewriting history. Use
  `omnyo thread clear <id>` to start fresh while retaining the ownership evidence.
  Ownership still depends on retained records; purging all records of the
  original owner removes that protection.
- Use `omnyo thread cancel-plan <id>` to exit an active Plan turn without
  optimistically clearing its banner. Use `omnyo thread clear-goal <id>` to clear
  a thread's durable active Goal when supported by its provider. Both wait for provider confirmation.

## Continue now or change model

Use `--now` to attempt a scheduled retry immediately under normal admission
  rules. Use `--model <model>` to select another model from the same provider;
  it reuses the existing retry and preserves the failed request's permission
  mode. Claimed retries cannot be replaced. The SDK accepts
  `{ threadId, now?: boolean, model?: string }`. Continuation state includes
  `retryAt`, `retryAttempt`, `canRetryNow`, `model`, and a concise `failureLabel`;
  `cause` retains diagnostics separately from the recovery instruction.
