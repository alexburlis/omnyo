# Thread coordination and inspection

## Ending a turn: ask, wait or stop

Every turn ends in exactly one of three ways:

- **Ask:** open a native required question when you need the owner's judgment
  or authority now. In a child chat the question goes to your parent chat
  instead; see Native questions and callbacks.
- **Wait:** register a continuation with `omnyo wait`, then end the turn.
- **Stop:** anything else. The owner gets your result.

Never write "waiting for X" without `omnyo wait`. Prefer a callback or chat
delivery over a timed check, and decide who acts on the wake before you choose
a time.

| Situation                                                     | Use                                                     | On wake                              |
| ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| Own producer (sub-chat, workflow, Resources job, pursue goal) | Nothing; its completion route wakes the chat            | Agent                                |
| Another Omnyo chat will deliver                               | `--chat <id>`, delivered through the server             | Agent, with the result               |
| Omnyo can observe the event                                   | `--event <key>` with a registered key                   | Agent                                |
| The agent can check it itself                                 | `--check "<what>" --at <when>`                          | Agent: one evaluation turn at a time |
| Only the owner can notice it                                  | `--report "<event>"`, a proposal the owner accepts once | Agent, with the owner's report       |
| The owner's judgment or authority is needed now               | Ask                                                     | n/a                                  |

```sh
omnyo wait --self --key <stable-key> --for "<60 characters or fewer>" \
  [--chat <id>]... [--event <key>]... [--check "<what>" --at <when>] \
  [--report "<event>"] [--all | --any] [--by <deadline>] \
  [--resume "<next step>"] [--after <waking-wait-id>] [--json]
```

- `--key` names one logical wait. The same key with the same content returns
  the existing wait; the same key with different content fails.
- Times take an ISO 8601 timestamp (`2026-11-02T09:00`) or a duration from now
  (`30s`, `10m`, `2h`, `7d`), like `omnyo thread tell --send-at`.
- The deadline defaults to 7 days. A wait an agent registers ends at most 30
  days after the owner last touched the chat. At the deadline the server
  returns the chat to the owner and never runs the resume step.
- Checks back off from the first interval, doubling up to 24 hours.
- A `--chat` source needs running work or a wait that will deliver. The command
  prints the wait's marker and the reply the source sends:
  `omnyo thread tell <waiter> --mode auto "<marker> <result>"`. The server stores
  that reply as the condition's result; no turn starts until the wait is ready.
  Several conditions join with `--all` (the default) or `--any`.
- Event keys look like `<family>:<target>`. `omnyo wait sources` lists every
  installed family with its format, an example and its health; an unknown
  family or malformed target fails at once with the expected format. Run
  `omnyo wait check <key>` to validate a key and run its source once before you
  wait on it. A family marked "asks the owner" turns an agent's wait into a
  proposal the owner accepts.
- An agent's `--report` becomes a proposal the owner accepts once. It stays
  armed until the owner reports the event, cancels or archives; reminders never
  end it.
- `--after <id>` registers the successor of the wait that woke this turn and
  keeps its deadline.

In a wake turn, end with one of these calls, or end normally and the owner gets
the result:

- `omnyo wait rearm <id>`, only when nothing changed since the wait woke you;
- `omnyo wait met <id> --condition <key>` (`check`, `chat:<id>` or `event:<key>`)
  for one condition of a joined wait; the turn stays silent while others are
  unmet;
- `omnyo wait done <id>`, only when the owner's message reports the event of a
  report-it wait.

`omnyo wait list` shows the chat's open waits and their condition keys.
`omnyo wait cancel <id>` ends a wait; an agent's cancel of a wait the owner
created or accepted becomes a proposal instead. Wait commands default to
`OMNYO_THREAD_ID` inside a chat. `omnyo thread wait` is a different command: it
blocks until a thread reaches a status.

## The owner's Inbox

`omnyo inbox` prints the owner's Inbox: Question cards first, then the other cards
oldest first, then Waiting (On you, Comes back by itself) and Running.
`omnyo inbox --json` prints the same snapshot, in the same order, as the app.
Every entry adds `state`, `reason.text`, `recap`, `archiveReady`,
`optionalQuestion` and `pendingResults`; `counts.needsYou` counts actual asks
and blockers. Finished turns without asks use `finished`. Legacy action fields
and latches retain their meaning.

`omnyo inbox act <thread-id> <action>` acts on a top-level chat's card, and
`omnyo inbox undo [move-id]` reverses the owner's most recent move. Inbox card actions
are owner-only: core Omnyo commands send `OMNYO_THREAD_ID` and an automation's IDs
with every request, so a call from a chat or an automation is refused. Agents
propose with `omnyo wait` instead.

`omnyo inbox failures <thread-id> --json` lists retained failure IDs, stored turn
IDs and status. To acknowledge an obsolete failure, use
`omnyo inbox acknowledge-failure <thread-id> --failure <id> --turn <stored-turn-id> --reason "<why obsolete>" --json`.
All identities and the audit reason (1–1,000 characters) are required; no latest
failure is selected.
The owner or the target's actual parent/root agent may acknowledge only an
inactive target with no pending work. Active work cannot be cleared.
Acknowledgment preserves history and does not replay work, archive the chat,
declare completion or force archive readiness. Keep the normal caller identity.

## Native questions and callbacks

`omnyo question list --self --json` reads open required and optional questions.
`omnyo question command --self --value JSON --json` opens, updates, answers,
skips or withdraws a native question. Mutations use its current revision. The
`answers` action resolves several questions at once (`answer: null` skips one)
and delivers every answer in one message.
Batch replies require coordinator support. When connected to an older coordinator,
use one `answer` command per question until the coordinator is updated.
Answer acceptance and queue insertion commit together; repeated acceptance
cannot send twice. Skip is silent and grants no approval.
Set `delegable: true` on a question only for a reversible choice within
authority you already hold, never when it asks the owner to approve pushing,
publishing, deploying, releasing, submitting, sending, purchasing, deleting
data, changing an external service, creating an account or saving anything that
outlives the chat. When you re-open a child chat's question, keep `delegable`
only when the child set it. A chat, automation or plugin caller may answer only
`delegable` questions; plugin answers add `delegation: { ruleId, reason }`.
Provider-native questions continue to use `omnyo thread interactions`; Claude
Code asks that way only in plan mode or when the ask-user-question plugin is
disabled.

A child chat (spawned with a parent, not a fork or handoff) never asks the owner
while its parent is live. Opening a question there, through AskUserQuestion or
`omnyo question command --self`, stores no question and shows no Needs you;
Omnyo sends the questions to the parent chat as a message. The result's
`routedToThreadId` names that parent and is `null` for a root chat. The parent
answers with `omnyo thread tell <child-id> --mode auto '<answer>'`, which the
child receives as an ordinary message. When only the owner can decide, the
parent asks its own question and relays the answer; a parent that is itself a
child reaches its own parent. A provider's own blocking question from a child
chat is also sent to the parent, and the provider is told it was delivered.

Use `omnyo callback wait --self --from SOURCE --reason TEXT --json` only after the
source owns running or eligible queued work. Include the returned exact
`callbackMarker` in its completion request and require its reply through
`omnyo thread tell CONSUMER --mode auto`. Registration records the dependency;
it never starts work or schedules a reply. Inspect with `omnyo callback waiting
--self --json`; clear a verified resolved/cancelled dependency with
`omnyo callback clear --self --id EXACT_ID --json`. Human actions require input,
and Resources and scheduled automations keep their existing completion routes.

Native status distinguishes Needs your answer, Optional question, Waiting for
another chat and Dependency needs attention. Needs You only styles this state.

`omnyo question adopt --plugin decisions --json` or `--plugin needs-you` transfers
retained legacy records to native ownership after its old writer is stopped.
The original rows remain fenced and cannot overwrite later native resolutions.

## Coordinating Work

- Use one clear owner per task.
- Spawn independent tasks separately when parallel work is useful.
- Let threads work after spawning. Do not poll with shell sleeps, repeated log
  reads, or repeated status reads.
- Use `omnyo thread wait <thread-id>` when you explicitly need to block until a
  thread finishes. It defaults to waiting for `idle` for up to 20 minutes;
  pass `--status` or `--event` for a different target, and `--timeout
<duration>` (seconds, or a duration with a unit such as `90s`, `20m`, `4h`)
  when you need a shorter or longer budget.
- Use `omnyo thread tell <thread-id> "..."` when requirements change, a blocker
  needs clarification, or follow-up work is needed. For multi-line or Markdown
  text use `omnyo thread tell <thread-id> --message-file <path>` (`-` reads
  stdin): inside double quotes the shell runs `backticks` and `$(...)` before
  Omnyo sees the message. `omnyo thread edit-message`, `omnyo thread queue create`, and
  `omnyo thread queue update` take `--message-file` too.
- Make a scripted send safe to retry with
  `omnyo thread tell <thread-id> --mode queue --submission-id <id> "..."`. Choose
  the ID once (`sub_` plus 32 lowercase hex digits, such as
  `sub_$(openssl rand -hex 16)`) and reuse it on every retry. Omnyo queues the
  message once and returns the same receipt each time, with `replayed: true` in
  `--json` output after the first. Different text under the same ID is refused.
  The flag needs `--mode queue` and excludes `--send-at`, `--compact-first` and
  `--send-now`.
- Add `--plan` to `omnyo thread spawn` or `omnyo thread tell` to send the prompt as
  the provider's structured `/plan` action: the agent proposes a plan for
  approval before executing when supported by the provider. Plain `/plan ...` text is
  not recognized and reaches the provider as literal text. Review the proposed
  plan with `omnyo thread interactions`; `omnyo thread cancel-plan` leaves Plan mode
  early. The SDK equivalent is `input: [createBuiltinPlanCommandTextInput(text)]`
  (exported by `@omnyo/sdk`) on `threads.spawn` / `threads.send`.
- Use `omnyo thread edit-message <thread-id> --message "..."` to replace and rerun
  the latest eligible user message in a supporting provider thread. Pass
  `--expected-request-sequence <sequence>` to select an earlier message. Failed
  and incomplete turns are eligible; submitting against a running thread stops
  and settles its current turn first. Opening edit mode in the app is
  non-destructive; history changes only when the edit is submitted successfully,
  and workspace changes remain. When an agent edits another thread, the CLI
  carries its `OMNYO_THREAD_ID` so the replacement runs under agent permission
  policy.
- Add `--send-now` to `omnyo thread tell` to bypass plugin dispatch holds, including
  concurrency limits, like the composer's Cmd/Ctrl+Enter. Host, interaction, and
  lifecycle admission still apply. SDK: `threads.send({ ..., sendNow: true })`.
- Add `--send-at <when>` to `omnyo thread spawn` or `omnyo thread tell` to schedule
  the dispatch instead of attempting it now. `<when>` is an ISO 8601 timestamp
  (`2026-08-25T09:00`, local when no offset is given) or a duration from now
  (`30s`, `10m`, `2h`, `7d`); a time in the past and a bare date are both
  rejected. A scheduled spawn creates the thread `pending` with no turn and no
  environment work — no worktree and no setup script run until it is due — and a
  scheduled tell neither sends nor runs. Both report `delivery: "queued"` and
  dispatch on the sweep after the requested time. The SDK equivalent is `sendAt`
  (epoch ms) on `threads.spawn` / `threads.send`.
- `omnyo thread queue list` shows a Sender for agent threads and system notices.
  SDK queue rows and `--json` include `initiator` and nullable `senderThreadId`.
- A send that cannot run right now does not fail: it joins the thread's queue
  with a typed reason. `--json` reports `delivery: "queued"` plus
  the complete `queuedMessage` row, so a script can inspect its `id`,
  `waitingOn`, and `sendAt` without guessing. `queuedMessage.waitingOn.kind` is
  one of `time`, `thread-busy`, `turn-starting`, `stopping`, `provisioning`,
  `host-offline`, `host-away`, `interaction`, `server-update`, or `plugin`
  (which also carries `pluginId` and a human reason).
- A thread holds at most one pending copy of a message. Queuing a message
  identical to one already waiting (same text, attachments, sender, execution
  options and `sendAt`) returns that existing row instead of adding another,
  so a repeated tell during a long wait never stacks duplicates. Failed rows do
  not count.
- Inspect and act on queued dispatches with `omnyo thread queue list [<thread-id>]
[--wait-holder plugin:<plugin-id>]`, `omnyo thread queue send <thread-id>
<message-id>` (send it now, bypassing every plugin wait and its schedule), and
  `omnyo thread queue delete <thread-id> <message-id>` (discard it;
  `omnyo thread queue restore <thread-id> <message-id>` puts it back in place
  within one hour, until the server restarts). Omitting the
  thread lists every queued row in the workspace. The list shows `Waiting on`
  and `Send at` columns. Several queued rows on one thread are normal. The SDK
  equivalents are `threads.queue.list` (cross-thread) and
  `threads.queuedMessages.list/send/update/delete/experimental_restore` (one thread).
- Failed queue rows show the failure reason and an exact recovery command.
  Use `omnyo thread queue send <thread-id> <message-id>` to retry immediately,
  including after automatic retries are exhausted. Editing does not clear a
  failure or trigger a retry; send still respects core readiness requirements.
- `omnyo thread queue send <thread-id> <message-id> --mode steer` re-attempts the
  row as a steer with the same send-now behavior: it bypasses the row's schedule
  and plugin waits, while core waits still apply. During provisioning it reports
  that the row is still queued and leaves it waiting for the workspace.
- Queueing writes nothing to the timeline: a queued message reaches the thread
  log only once it dispatches. Ask the queue instead. In the app the same fact
  reaches the sidebar as a clock on any thread that holds queued work and is not
  running (the failure glyph instead if a drain attempt failed); a thread list
  entry carries it as `queuedWork: "none" | "waiting" | "failed"`.
- Use `omnyo thread list --thread <id>` to inspect specific threads without paging through the workspace. Repeat `--thread` for up to 200 IDs; unknown or deleted IDs are left out. The SDK equivalent is `threads.list({ threadIds })`; an empty array returns no threads.
- Use `omnyo thread count` when you need how many threads there are, never a list
  plus a row count: the count is a database aggregate, while `omnyo thread list`
  pages a bounded window and would miscount. Narrow with `--status
<pending|idle|starting|active|stopping|error>`, `--host`, `--provider`,
  `--project`, and `--parent <id|none>` (`none` counts only threads that have no
  parent at all; pass an id to count one thread's children). Archived, deleted,
  and hidden threads are excluded. Plain output is one number; `--by
host|provider|project` prints a count per group (a thread with none groups
  under `-`) and the total. The SDK equivalent is `threads.count({ status,
hostId, providerId, projectId, parentThreadId, groupBy })`.
- `omnyo thread tell` steers by default, delivering the message immediately into
  the active turn. Use `--mode queue` when the message is non-urgent and the
  agent can finish its current work first. Steer is especially important for a
  wrong direction, hard stop, or critical clarification.
  Example: `omnyo thread tell <thread-id> "Stop and use approach B" --mode steer`.
- Input sent while a turn is starting stays queued with
  `waitingOn.kind: "turn-starting"`. The `turn/started` event wakes it and
  steers it into that turn. Do not resend it.
- If the target thread is awaiting user interaction (an open question or
  approval), `omnyo thread tell` cannot interrupt it. The message joins the
  thread's queue with `waitingOn.kind: "interaction"` and dispatches once the
  interaction settles; the CLI prints that it is queued and why. That outcome is
  not a failure, so do not resend. For a hard stop use `omnyo thread stop
<thread-id>`. `--json` reports `delivery` as `sent` or `queued`. If the thread
  fails while the message is queued (its provider exited), the message waits
  until somebody retries the thread.
- `omnyo thread archive` is not a hard stop. For 30 seconds after archiving, a
  thread keeps its terminals and a mid-turn thread keeps running, so
  `omnyo thread unarchive` inside that window leaves everything in place; Omnyo stops
  the thread and closes its terminals once the grace elapses. Use
  `omnyo thread stop <thread-id>` when the run must end now.

## Inspecting Results

`omnyo thread proof <id> --command 'pnpm test' --event-seq 42 --json` reads compact,
already-redacted command execution facts. Repeat either selector up to ten total.
Commands require a unique exact match after trimming and CRLF normalization in the
latest 500 completed events. An explicit same-thread sequence can select an older
completed command. The response distinguishes matched, missing and ambiguous
selectors. With no selectors, the command validates the chat without loading history.

- Use `omnyo thread search <query> [--limit <1-50>]` for sidebar search. Use
  `history`, `read|unread`, and `section` for organization and recall. The
  `omnyo thread queue` group contains the queued-message operations. Queue updates
  use the listed version and accept repeatable `--file` and `--image` options;
  absolute file/image paths and `file:` URLs are uploaded from the CLI machine before the update.
- Use `omnyo thread show <thread-id>` for status, parent, environment, pull request
  status, and result.
- Use `omnyo thread show <thread-id> --git-diff` to review file changes.
- Use `omnyo thread log <thread-id>` to inspect the conversation. The default
  shows only the newest 20 user-message turns and ends with a notice when older
  history was omitted. For timeline text, `--limit <n>` accepts at most 100.
  `--all` prints the whole thread. Human formats use a consistent history
  snapshot and join paginated group contents. Appends remain outside that walk;
  rerun after a cursor-invalidated error from a history edit. JSON accepts any positive limit. It defaults
  to the oldest 100 events and warns when more exist. Event bodies can contain
  redacted values or an explicit withheld-content marker; IDs, sequence and
  ordering are preserved. Page with
  `--after-seq <seq>` or pass `--all`.
  Grep the `--all` output, not the default page, when checking whether a
  thread ever received a message.
- To check whether a chat committed or pushed, read the `Git:` line that
  minimal and verbose `omnyo thread log` output print under the final assistant
  message of each completed turn. It gives the commit count, branch, push
  target and repository; verbose output also lists each commit and push.
- Use `omnyo thread log <id> --format conversation --limit <1-100>` for compact
  JSON: `{rows: [{seq, role, text}], hasMore, nextAfterSeq, maxSeq}`. Continue
  with `--after-seq <nextAfterSeq> --through-seq <maxSeq>`; `--all` holds the
  first snapshot. Restart after history edits. Raw `--json` retains its event
  array shape. Supported history exports mask environment values and redact
  credential text.
- Read a message reference (`@thread:<id>#msg=<seq>` or a `…/threads/<id>#msg=<seq>`
  link) with `omnyo thread log <id> --message <seq> [--context <n>]`.
- Use `omnyo thread output <thread-id>` to read the latest final output, or
  `omnyo thread output --self` for the current thread.

For review or fix pipelines, get the environment ID from
`omnyo thread show <thread-id> --json`, then spawn the follow-up with
`--environment <environment-id>` so it sees the same files.

## Opening Threads And Files In The App

- Reference an Omnyo thread in chat as `@thread:thr_abc123`, substituting its
  actual ID. Omnyo renders the mention with the correct project-aware link; do not
  construct `/threads/...` or `/projects/.../threads/...` URLs manually.
- Pasting a bare thread URL from the current Omnyo origin into a composer creates
  the same thread pill after resolution. Undo restores the URL; Cmd/Ctrl+Shift+V
  keeps it literal. CLI prompts use `@thread:<id>` directly; they do not rewrite URLs.
- Show dashboards and reports built for the conversation inline without
  creating or opening a separate HTML file by default. Prefer Canvas
  (`omnyo canvas on`) with `html` nodes for an evolving interactive dashboard or
  visual workspace. Use a fenced `inline-vis` block for a small,
  self-contained visual.
- Honor explicit HTML-only, file, download and standalone-website requests
  with the requested output. Existing file previews remain supported. Use
  `omnyo thread open <path>` inside an Omnyo thread when a separate file preview is
  requested. It opens a Markdown, HTML, or other workspace file in the Omnyo IDE's
  thread panel. An HTML file renders and widens the panel to at least 60% of
  the window.
- Use `omnyo thread open <thread-id> --split right|down|left|top|replace` to open
  or focus a thread in the current app split layout. `replace` is the default;
  an already-open thread is focused. Edge splits create panes through the
  eighth pane; at eight panes, they replace the focused pane.
- A file path is optional when a thread ID is explicit:
  `omnyo thread open <thread-id> [path] [--split <placement>]`.
- Paths can be thread-relative workspace paths, or absolute paths inside the
  target thread workspace.
- Absolute paths under `OMNYO_THREAD_STORAGE` open as thread-storage files for the
  current thread.
- Use `omnyo thread pane maximize|restore|toggle|spotlight|clear-spotlight
[thread-id]` to change a matching open pane in every connected Omnyo app window.
  Inside an Omnyo thread, omit the ID to use `OMNYO_THREAD_ID`. The command reports
  how many connected clients received the ephemeral action. The SDK equivalent is
  `sdk.threads.paneAction({ threadId, action })`.
- Users can also toggle the focused pane from its header or with the configurable
  `pane.maximize.toggle` app command (default `Mod+Shift+E`).

## Files And Voice

- Use `omnyo file read|write|list|paths|mkdir|move|remove` for SDK-equivalent host
  file access. `--host` targets another machine; `--root` confines mutations.
- File write requires exactly one of `--content` and `--stdin`. File paths lists
  files and directories when neither selector is present. File list and file
  paths include dot-prefixed entries; `--no-hidden` skips them. Both skip
  `node_modules`, `.venv`, `.pnpm-store`, and root-relative `.claude/worktrees`
  by default. `--exclude <names...>` replaces that set; entries match basenames
  at any depth or exact root-relative paths using `/` separators.
- File remove supports `--recursive` and requires `--yes` without a terminal.
  Recursive directory removal, including orphaned thread storage cleanup,
  stops processes working inside that directory before deleting files on
  macOS and Linux, matching worktree removal. Thread deletion also stops these
  processes before deleting its storage. Windows does not enumerate process
  working directories.
- Use `omnyo voice transcribe <file> [--type <mime>] [--prompt <text>]` without the
  app composer. The MIME type defaults to `audio/webm`.
- `omnyo voice prepare [--json]` asks the selected voice service to get ready,
  for example by loading its local model, and returns without waiting. The app
  does the same when recording starts. Failures appear only in the server log
  as `Voice input prepare failed`; SDK: `system.experimental_prepareVoiceInput`.
- Voice failures automatically write content-free `Voice input diagnostic`
  records to the private coordinator log. Match `recordingId` and `attempt` to
  transcription errors; `occurredAt` and `clientBundle` identify the failing
  client even after offline replay. `omnyo voice diagnostic <report.json> [--json]`
  and `sdk.system.experimental_recordVoiceDiagnostic` submit the same strict
  format. Never include audio, text, raw errors, URLs or device identifiers.

## Long-Running Commands

- Use `omnyo preview register --thread <id> --url <loopback-url> [--cwd <path>]
[--readiness-path <path-and-query>] -- <exact-command...>` for a web preview
  that needs private remote access and one-tap recovery. Registration stores
  its original host/environment/endpoint and exact launch without starting it.
  Use the project's real protected launcher; never guess a recipe from an old
  URL or put secret values in arguments or registration data.
- `omnyo preview list --thread <id>` returns `{previews: [...]}` with --json.
  `show <preview-id>` returns the public binding, including `url` and
  `remoteUrl`, without its recipe. Put the original loopback URL in chat; Omnyo
  resolves local versus private remote access from host identity.
- `omnyo preview status <preview-id>` checks the owning machine's readiness and
  process ownership. `restart <preview-id> [--request-id <id>]` ensures that
  exact server is ready; a live owned run is reused and concurrent taps share
  one start. Reuse the request ID after an uncertain request. It never kills a
  foreign listener or substitutes another port. An offline host must reconnect.
  Restart exits nonzero if the result is not online. After a starting result,
  check status for readiness. `remove <preview-id>` deletes a saved recipe
  that nothing runs, such as one whose workspace is gone, and drops it from the
  chat's Dev servers shelf; it refuses a running or starting server and never
  stops one. All commands accept --json;
  the SDK equivalent is `sdk.previews.register/list/get/status/restart/experimental_remove`.
- Use `omnyo terminal ...` for long-running commands the user may need to inspect
  or stop later: dev servers, watch tasks, REPLs, database consoles, and similar
  processes. The terminal is a real persistent PTY shown in the Omnyo UI.
- `list` and `create` require exactly one explicit scope: `--thread <id>`,
  `--environment <id>`, or `--machine <id-or-name>` (`--host` is an alias).
  Add `--cwd <path>` only to a machine scope. Machine targets resolve to an
  explicit host ID; terminal commands never silently fall back to the server machine.
- Start a server with
  `omnyo terminal create --thread <thread-id> --title "pnpm dev" --command "pnpm dev"`.
- A terminal runs the machine's own shell: `$SHELL` (then zsh, bash, sh) on
  macOS and Linux; PowerShell 7, then Windows PowerShell, then cmd on Windows.
  `--command` text is parsed by that shell, so write it in that shell's syntax.
  When the target may be Windows, pass the program and its arguments after `--`
  instead (`omnyo terminal create --thread <id> -- pnpm test "my file.ts"`); the
  machine quotes each argument for its shell. The terminal's exit code is the
  command's exit code on every shell.
- `omnyo terminal start` is an alias for create. `omnyo terminal stop` is an alias
  for close.
- Use `omnyo terminal show`, `attach`, and `resize` for session inspection,
  interactive attachment, and PTY size changes. Use live help for their flags.
- All existing-session operations need only the terminal ID; they accept and
  ignore the scope flags of `list` and `create`. Use
  `omnyo terminal wait <terminal-id> --contains "Local:" --timeout 120` to wait
  for readiness from new output. Pass `--from-start` only when matching existing
  scrollback is intentional. When the terminal exits before the text appears,
  wait stops at once with exit code 124, the terminal's exit code, and its last
  output.
- Use `omnyo terminal output <terminal-id> --json` to read bounded output, then
  continue with `--since-seq <nextSeq>` when polling. The response carries
  `status`, `exitCode`, and `closeReason`. Output stays readable for 30 minutes
  after the command exits, until the machine's daemon restarts. Use
  `omnyo terminal send <terminal-id> --text "..." --enter` for interactive input
  (`--enter` presses Enter),
  `omnyo terminal rename <terminal-id> <title>` to rename, and
  `omnyo terminal close <terminal-id>` when the process is no longer needed.
  `omnyo terminal foreground <terminal-id>` reports whether a command still
  runs in the shell's foreground before you close it.
- `omnyo terminal restart <terminal-id>` replaces the session with a shell in the
  same scope, size, and title. It does not replay the original launch command.

Clearing a thread's parent with `omnyo thread update --clear-parent-thread` inherits the former parent's section unless the update explicitly supplies a section. Children released by environment archiving also inherit their former parent's section.

`omnyo thread show <id> --include experimental_pluginData --json` includes opted-in plugin reads
from the same thread response. Combine `environment,host` in the comma-separated include when needed.

Script and SDK messages show their source in chat. `omnyo thread tell --source "Runner name"` labels a script; without it CLI messages show CLI or the calling chat. SDK send and queued create accept `messageSource` as `{ kind: "script", label }` or `{ kind: "user" }`. Bound plugin SDKs record the plugin automatically. Older unmarked requests keep their recorded attribution.

# Shared chat work summary

`omnyo thread work [id] --json` or `omnyo thread work --self --json` reads the same
work snapshot as the sidebar and composer. Its six primary labels preserve
simultaneous required input, optional input, activity, failures and next actors.
Unreadness and shelf placement do not determine work status.

`omnyo thread work publish [id] --plugin OWNER --value JSON --json` publishes a
validated assessment or signals contribution and returns `{threadId, work}`.
Assessment writes require the captured basis, which identifies the conversation:
new input, a started turn or a completed turn moves it. Open work vetoes the
recommendation live instead. Producer namespaces replace only their own observations. Unregistered running owners use their real job deadline
as `signals.validUntil`; terminal failures can persist with no validity bound.

`omnyo thread work archive-ready [id] --basis BASIS --json` rechecks current
completion and obligations before archiving the chat and its descendants.

Use `omnyo thread update ID --service-tier default|fast|ultrafast` to change session speed. Supported tiers depend on the provider and model. Active Codex and Claude sessions receive the update immediately; already-started model requests keep their captured settings. The session header shows the confirmed speed. `sdk.threads.update({ threadId, serviceTier })` uses the same path.
