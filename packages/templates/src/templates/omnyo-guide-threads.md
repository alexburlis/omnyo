---
kind: instruction
title: Omnyo Guide — Threads
summary: Command reference for thread spawning, inspecting, messaging, and lifecycle.
intent: Provide complete thread command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation. Run the json-flag-enforcement and command-output tests after changes.
---
Thread commands

Every command supports --json for machine-readable output.

For the native Claude profile pilot, `thread spawn --claude-profile ID`
selects one ready profile and its machine before creating the chat. It selects
the Claude Code provider when `--provider` is omitted. `--claude-profile
unprofiled` explicitly keeps the existing authentication path. Without the flag,
a new Claude chat uses its project default, then its machine default. The saved
binding does not change when defaults change. To continue with another account,
create a handoff with `--origin-kind handoff --source-thread ID`, the destination
`--claude-profile`, the same environment, and a prompt containing `@thread:ID`.
Reuse `--submission-id` when retrying that creation. SDK callers pass the same
selection as `claudeProfile: {kind: "profile", profileId: ID}` or
`{kind: "unprofiled"}` to `threads.submissions.spawn`.

Native questions and callback dependencies:

  omnyo question list [<thread-id>] [--self] --json
  omnyo question command [<thread-id>] [--self] --value '<JSON command>' --json
  omnyo callback wait [<thread-id>] [--self] --from <source-thread> --reason "..." --json
  omnyo callback waiting [<thread-id>] [--self] --json
  omnyo callback clear [<thread-id>] [--self] --id <exact-wait-id> --json
  omnyo question adopt --plugin <decisions|needs-you> --json

Question commands are open, update, answer, answers, skip and withdraw. Open
takes a questions array with prompt, mode (required or optional), options and
input settings. Update takes id, revision and the complete replacement question;
answer takes id, revision and answer { selected: [...], freeText?: "..." }.
Answers takes answers: [{ id, revision, answer }] and resolves several questions
together, with answer null to skip one; all answers arrive as one message and a
stale entry rejects the whole batch. Skip and withdraw take id and revision.
Answers are saved once, then immediately steer a running turn or start a turn
when idle through the normal message path.
Retrying the same answer cannot send it twice. Skipping sends no message and
grants no approval.

A question may set delegable: true (default false) only for a reversible choice
within authority the asking agent already holds, never when it asks the owner to
approve pushing, publishing, deploying, releasing, submitting, sending,
purchasing, deleting data, changing an external service, creating an account or
saving anything that outlives the chat. A parent re-opening a child chat's
question keeps delegable only when the child set it. Callers that identify as a
chat, automation or plugin may answer only delegable questions; a plugin answer
must add delegation { ruleId, reason }, and only plugin answers may carry it.
Every answered question records answeredBy (owner, thread, automation or plugin
with its rule). Only an owner answer marks the chat's Inbox items handled. Required questions block their dependent action; independent
authorized work may continue. When progress makes an open question unnecessary,
withdraw it using the id and current revision from omnyo question list --self --json:

  omnyo question command --self --value '{"action":"withdraw","id":"<question-id>","revision":1}' --json

Withdrawal clears Needs you and rejects late answers without sending a message.
Continuing independent work alone does not invalidate a question that still needs
an answer. Provider-native questions and approvals keep their existing
omnyo thread interactions resolution path; Claude Code uses them for questions
only in plan mode or when the ask-user-question plugin is disabled.

A child chat (spawned with a parent, not a fork or handoff) never asks the owner
while its parent is live. Neither does a chat another chat started: a chat
created through the CLI from inside a chat reports to that launching chat while
it is live, even without --parent-thread. Only chats the owner created ask the
owner directly. Opening a question there, through AskUserQuestion or
omnyo question command --self, stores no question and shows no Needs you; Omnyo
sends the questions to the parent chat as a message. The result's
routedToThreadId names that parent (null for a root chat). The parent answers
with omnyo thread tell <child-id> --mode auto '<answer>', which the child
receives as an ordinary message. When only the owner can decide, the parent asks
its own question and relays the answer; a parent that is itself a child reaches
its own parent. A provider's own blocking question from a child chat, such as
Claude Code's AskUserQuestion in plan mode, is also sent to the parent; the
provider is told it was delivered and that the answer arrives as a message.

Callbacks require a source with running or eligible queued work. Registration
returns callbackMarker; the recorded source must include it in its completion
reply with omnyo thread tell <consumer> --mode auto. A wait does not dispatch work
or schedule a reply. Human actions use the input UI. Resources and scheduled
automations retain their own completion routes. Exact IDs protect replacements
from stale clears. State survives reload and service restart.

SDK: experimental_attention.snapshot/history/command. Native required input,
optional input, callback waiting and dependency failure remain distinct even
when the Needs You visual plugin is disabled.

Inbox, waits and work:

  omnyo inbox [--json]
  omnyo inbox act <thread-id> <action> [--until <when>] [--event "..."] [--wait <wait-id>] [--note "..."] [--question <id>] [--target <thread-id>] [--stop-running] [--json]
  omnyo inbox undo [<move-id>] [--json]
  omnyo inbox failures <thread-id> [--json]
  omnyo inbox acknowledge-failure <thread-id> --failure <id> --turn <stored-turn-id> --reason "..." [--json]
  omnyo wait [<thread-id>] [--self] --key <key> --for "..." [--chat <id>]... [--event <key>]... [--check "..." --at <when>] [--report "..."] [--all|--any] [--by <when>] [--resume "..."] [--after <wait-id>] --json
  omnyo wait rearm|done|cancel <wait-id> [<thread-id>] [--self] --json
  omnyo wait met <wait-id> --condition <key> [--result "..."] [<thread-id>] [--self] --json
  omnyo wait list [<thread-id>] [--self] --json
  omnyo wait sources --json
  omnyo wait check <key> --json
  omnyo thread work [id] --json
  omnyo thread work --self --json
  omnyo thread work publish [id] --plugin <owner> --value <json> --json
  omnyo thread work archive-ready [id] --basis <basis> --json

Each chat family has one server-owned state: needs-you, failed, finished, working,
waiting, resting or archive. Needs you states a question, failure, decision or
assessed ask; finished work without an ask appears in Finished. Working chats
keep optional questions as badges. Result cards and owner actions remain
available while work runs or waits. Ready to archive is a finished state with
archiveReady set. The Shelf is your collection beside these sections.
`omnyo inbox --json` includes each entry's state, reason, recap, archiveReady,
optionalQuestion and pendingResults, plus counts.needsYou. The app shares this
snapshot across its Inbox, Glance chip, Home counts and composer reason.
Legacy view, card, primary, actions and latch fields keep their action contract.
Inbox card actions are owner-only.

`omnyo inbox failures <thread-id> --json` lists retained failure IDs, stored turn
IDs and status. To acknowledge an obsolete failure, use
`omnyo inbox acknowledge-failure <thread-id> --failure <id> --turn <stored-turn-id> --reason "<why obsolete>" --json`.
All identities and the audit reason (1–1,000 characters) are required; no latest
failure is selected.
The owner or the target's actual parent/root agent may acknowledge only an
inactive target with no pending work. Active work cannot be cleared.
Acknowledgment preserves history and does not replay work, archive the chat,
declare completion or force archive readiness. Keep the normal caller identity.


Agents end every turn by asking a native required question, registering
omnyo wait, or stopping. In a wake turn they answer with omnyo wait rearm (nothing
changed), omnyo wait met (one condition of a joined wait) or omnyo wait done (the
owner's message reports the event). Wait commands default to OMNYO_THREAD_ID.
Event keys look like <family>:<target>. omnyo wait sources lists every installed
family with its key format, an example and its health: Omnyo's own
host-reconnect:<hostId>, coordinator-version:<version> and
automation-run:<automationId>, plus plugin families such as
github-pr:<owner>/<repo>#<number> and github-checks:<owner>/<repo>#<number>.
omnyo wait check <key> validates a key and runs its source once without
registering a wait; it exits 1 when the key is invalid or the check fails. An
agent's wait on a family marked "asks the owner" becomes a proposal. Plugins add
families with api.experimental_eventSources.register.

tell --self --send-at registers a check (omnyo wait --check --at). A tell to
another chat with --send-at shows on that chat as a dated row; if that chat is
archived when it comes due, nothing is delivered and your root shows "Couldn't
post to <chat>: archived". omnyo pursue goal keeps a chat Running and holds each
iteration's result for its judge; omnyo pursue loop is a check that only
omnyo wait rearm keeps silent.

The shared work summary reports Needs you, Working, Blocked, Waiting, Open,
External (only an outside event remains) or Ready to archive, with reasons, actors and simultaneous activity/input facts.
Unreadness and Inbox/Shelf/Archive placement are independent. Missing suggestions
retain their assessment availability and recorded explanation. Reading this
state never requests new inference. Work publication returns {threadId, work};
work reads return the summary directly.

Publish a typed assessment against the captured work.basis, or a producer's
signals snapshot. The basis identifies the conversation: new input, a started turn
or a completed turn moves it. Open work vetoes the recommendation live instead. Each owner namespace replaces only its own observation.
Unregistered active owners declare validUntil from their actual job deadline.
Expired ownership becomes unverified. A terminal failure remains visible until
the owner clears it. Ready-only archive rechecks the current basis and completion
recommendation before archiving this chat; ordinary manual archive is unchanged.

A chat is never Ready to archive while a chat it started still has work. Omnyo
records the chat that ran omnyo thread spawn or fork as the launcher, with or
without --parent-self. The launcher shows Working while a launched, child or
lifecycle-owned chat works, and Waiting while a visible one needs an answer,
recovery or an outside event. Its own completion report applies once that work
settles. Recording the launcher changes no question routing, visibility or
archiving.

An open omnyo wait or omnyo callback wait also keeps a chat Waiting and out of
Ready to archive until the wait closes. The turn a wait woke closes that wait
when it ends, including when it registers a follow-up wait with --after.

When a chat you wait on with --chat goes idle without delivering, Omnyo asks it
once, with the exact omnyo thread tell <your-id> --mode auto "<marker> <result>"
command. If it still owes the result ten minutes later, Omnyo tells your chat,
not the owner: ask the source again with omnyo thread tell, or end the wait with
omnyo wait cancel. Only a wait the owner created, or a source the owner stopped,
puts the source in the owner's Needs you.

Spawning:

  omnyo thread spawn --project <id> --prompt "..." [options]
  omnyo thread spawn --project <id> --prompt-file <path> [options]

    --prompt <prompt>              Initial prompt (one of --prompt or --prompt-file is required)
    --prompt-file <path>           Read the prompt from a file; `-` reads stdin. Use this for
                                   multi-line or Markdown prompts: inside double quotes the shell
                                   runs `backticks` and $(...) before Omnyo sees them
    --title <title>                Thread title
    --project <id>                 Project (required; when omitted the error prints this thread's project ID to add)
    --parent-thread <id>           Parent thread (may be in another project)
    --parent-self                  Parent to the current thread (OMNYO_THREAD_ID)
    --lifecycle-owner-thread <id>  Archive/delete with this owner
    --provider <id>                Provider override
    --model <model>                Model override
    --reasoning-level <level>      Reasoning level id the model lists: low, medium, high, xhigh, max, or a provider-specific id
    --environment <id-or-path>     Attach to an existing environment (ID or workspace path)
    --new-environment <kind>       Create a fresh personal workspace or managed worktree
    --base-branch <branch>         Base branch or ref for a new managed worktree
                                   (--new-environment worktree only)
    --environment-provider <id>    Run on an environment provider by id (list them with
                                   `omnyo environment providers`). The provider
                                   provisions where the thread runs; its steps show in the
                                   thread's workspace-setup block. Its `requires` names the
                                   facts it consumes: `host` takes --machine (the local
                                   machine by default); `gitCheckout` needs this project's
                                   checkout on that machine to be a Git repository with
                                   commits; `gitRemote` needs a project remote;
                                   `projectless` serves only threads with no project.
    --environment-inputs <json>    JSON value for an --environment-provider that declares
                                   inputs; `omnyo environment providers --json` prints each
                                   provider's inputs as JSON Schema (null when it takes
                                   none). Required when the provider declares inputs,
                                   refused when it does not
    --machine <id-or-name>         Run on a machine (--host is an alias)
    --service-tier <tier>          Service tier id the provider lists for the model, such as
                                   default or fast (see `omnyo provider models`)
    --option <option=value>        Choose a value for an option the provider's model lists, applied
                                   before the first message; true or false for an on/off option
                                   (repeatable; see `omnyo provider models`)
    --permission-mode <mode>       Permission mode: accept-edits, auto, or full
    --plan                         Send the prompt as the provider's /plan action (plan first, execute after approval)
    --section <id>                 Create the thread in a section
    --pinned                       Create the thread in Pinned
    --visibility <visibility>      visible or hidden; a child inherits its parent by default
    --send-at <when>               Dispatch the first message at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --submission-id <id>           Retry-safe create: repeat the same ID (sub_ plus 32 lowercase hex digits)
                                   after a lost reply and Omnyo returns the chat it created the first time
    --file <path>                  CLI-local absolute path, file: URL, or uploaded file path
    --image <path>                 CLI-local absolute path, file: URL, or uploaded image path
    --origin-kind <kind>           fork (copies the source history) or handoff (links a chat that continues the source)
    --source-thread <id>           Source thread for a fork or handoff
    --source-seq-end <seq>         Fork after the source turn containing this event sequence

  Execution defaults resolve from explicit flags, live parent execution, and
  remembered project defaults. With no remembered model, Omnyo uses the explicitly
  requested provider or Codex and resolves its provider-reported default model
  on the target machine. The product reasoning and permission defaults are
  medium and auto.
  accept-edits uses workspace sandboxing with user-reviewed escalation. auto uses
  the same workspace sandbox with provider-native automatic review. full is the
  explicit sandbox and approval bypass. Plan mode is separate from permissions.
  Subagents inherit the parent's permission mode by default, adapted to the child provider's supported modes. Explicit requests and a thread's recorded mode take precedence; nesting a thread does not cap its permissions. The host permission ceiling still applies.
  Parenting is opt-in. Inside a thread, pass --parent-self to parent the new thread to the current thread.
  A thread spawned from inside a thread always records that thread as its launcher, which keeps the launcher out of Ready to archive while the new thread works.
  The parent answers the child's questions; the owner never sees them.
  Hidden threads are for plugin/background workers. They remain addressable by
  ID while staying out of sidebar organization and unread/pending favicon
  attention. Thread lists exclude them unless
  --include-hidden is passed; direct-ID operations remain available.
  A new child thread inherits the visibility of its parent, so the subagents of
  a hidden thread stay hidden too. Pass --visibility to override the inherited
  value. A hidden child still reports its turns, blockers and questions to its
  parent thread; only source-derived forks stay silent. A child that fails
  before a turn starts is reported as failed, including when Omnyo stops it
  because its provider did not start the turn within 5 minutes.
  A machine selector accepts an exact ID or an unambiguous name. It works with
  an unmanaged --environment path, --new-environment worktree, or the personal
  workspace. It cannot be combined with an existing environment ID because that
  environment already selects its machine. Without the flag, local/server
  machine resolution is unchanged. A machine chosen with --machine pins the
  new thread there; without it, a waiting new thread can start on another
  machine when concurrency-limit overflow is on.
  Omit --base-branch for Omnyo's default. Default and named branches use the
  remote when local is equal or behind, preserving local commits when ahead
  or diverged. Explicit refs are honored exactly. Selected remote refs are
  fetched before creation; when the fetch of an automatically chosen remote
  fails, the worktree starts from its last fetched commit.
  Before selecting a provider, run `omnyo environment providers --project <id>
  --machine <id-or-name>` to see whether it is available, needs setup, or is
  unavailable and why. The first-party providers are Project checkout,
  Worktree, and Personal workspace.

Handoff:
  In the follow-up model picker, Handoff to new thread starts a new-thread
  draft with a reference to the source thread and closes the picker. Choosing
  another provider's model, reasoning cell or favorite starts the same handoff
  on that choice. While handoff is active, every choice, including one from
  the current provider, sets the new thread's model. Exit handoff restores the
  original execution settings and keeps draft edits, removing the automatic
  source reference. Closing the picker keeps handoff active; the composer also
  has Exit handoff.
  The new thread keeps its own place in the list and links back to its source:
  its composer shows Continued from, the source shows Continued in, and
  omnyo thread show prints Continued from: THREAD_ID. CLI callers can use
  omnyo thread spawn with --provider, --model, --environment, --origin-kind
  handoff, --source-thread THREAD_ID and --prompt 'Continue from
  @thread:THREAD_ID ...'. SDK callers use threads.spawn with the corresponding
  execution, environment and input fields, originKind "handoff" and
  sourceThreadId.

Forking:

  omnyo thread fork <source-thread-id> [options]

    --prompt <prompt>              Optional first prompt; omit for an idle fork
    --prompt-file <path>           Read the first prompt from a file; `-` reads stdin
    --lifecycle-owner-thread <id>  Archive/delete with this owner
    --source-seq-end <seq>         Fork after the source turn containing this event sequence (tip by default)
    --environment <id-or-path>     Existing environment ID or unmanaged workspace path
    --new-environment <kind>       Create a fresh personal workspace or managed worktree
    --base-branch <branch>         Base branch or ref for a new worktree; omit for the project default
    --title <title>                Thread title (idle forks default to "(1) <source title>")
    --permission-mode <mode>       Inherit source by default; accepts accept-edits, auto, full
    --visibility <visibility>      visible (default) or hidden
    --agent-context-seed <text>    Persist agent-only context without a first run
    --file <path>                  CLI-local absolute path, file: URL, or uploaded file path
    --image <path>                 CLI-local absolute path, file: URL, or uploaded image path

  Forks clone the source provider session on the same machine and inherit the
  source conversation in their timeline. --source-seq-end anchors the fork on
  the completed source turn that contains that sequence: the clone and the
  inherited timeline both end with that turn (an anchor on a user message
  branches before it, like editing it). Without it a fork clones the session
  tip and inherits every completed turn. Providers that can only clone a whole
  session accept an anchor only on the source's latest turn. A fork reuses the
  source environment by default. Use --new-environment personal for a fresh
  personal workspace or --new-environment worktree for a fresh worktree on the
  source machine; --environment can select another environment or unmanaged
  path on that machine. A different machine is rejected because the source
  provider session lives on its original machine. Omit --prompt to create an
  idle fork. A visible idle fork without --title is named after its source with
  a numbered prefix: "foo" becomes "(1) foo" and "(1) foo" becomes "(2) foo".
  Forks created with a first prompt get a title from that prompt.

Editing a sent message:

  omnyo thread edit-message <id> --message "Replacement text"
    --self                              Target the current thread (OMNYO_THREAD_ID)
    --expected-request-sequence <seq>   Select the message and reject a stale target

  Without --expected-request-sequence, the latest eligible message is edited.
  Codex, Claude Code, and Pi threads are supported. The original conversation
  remains unchanged until the provider prepares the replacement history.
  Failed and incomplete turns are eligible. If the thread is running,
  submission stops the current turn and waits for it to settle. It then
  replaces the selected turn and every later turn while retaining workspace
  changes. Unsent queued messages remain in the queue and dispatch after the
  replacement turn when their waits clear. An already-sending queued message
  must finish before the edit can start. Retries of turns replaced by the edit
  are removed from the queue. From an agent thread, the command
  carries `OMNYO_THREAD_ID` so the replacement runs under agent permission policy.
  An edit is refused if removing its history would erase ownership evidence
  shared with another thread. Use omnyo thread clear <id> to start a new session
  while keeping the history and its ownership evidence.

Listing:

  omnyo thread list                           List threads
    --project <id>                         Filter by project
    --environment <id>                     Filter by environment
    --machine <id-or-name>                 Filter by the machine the environment is on (alias --host)
    --parent-thread <id>                   Filter by parent thread
    --thread <id>                          Only this thread; unknown or deleted IDs are left out (repeatable, up to 200)
    --archived                             Show only archived threads
    --shelved                              Show only shelved threads, in Shelf order
    --section <id>                         Filter by section
    --unsectioned                          Show only threads outside sections
    --group <id>                           Filter by chat group
    --include-hidden                       Include hidden threads

  The table prints ID, Title, Project, and Status. Title uses the thread
  title, then the fallback title from the first prompt, then "-". Long
  titles are cut at 60 characters. Project shows the project name; the
  personal project shows "-". Use --json for the full thread records.
  Each record's activity counts live work; activeSubagentCount is the
  number of subagents running now (delegated agents in the open turn,
  background agents, and running workflow agents).

  omnyo thread search <query> [--limit <1-50>]
                                             Search threads and messages
  omnyo thread history <id>                   List prompt history

  omnyo thread count                          Count threads without listing them
    --status <status>                      Count threads in this status: pending, idle, starting, active, stopping, error
    --host <id>                            Count threads whose environment is on this machine
    --provider <id>                        Count threads running on this provider
    --project <id>                         Count threads in this project
    --parent <id|none>                     Count one thread's children, or 'none' for threads with no parent
    --by <dimension>                       Group the count by host, provider, or project

  Counting happens in the database, so use it instead of listing threads and
  counting rows: `omnyo thread list` pages a bounded window and would miscount.
  Archived, deleted, and hidden threads are excluded. Without --by the command
  prints one number; with --by it prints a count per group (threads with no
  host/provider/project group under "-") followed by the total.

Sections:

  omnyo thread section list
  omnyo thread section create <name>
  omnyo thread section rename <id> <name>
  omnyo thread section delete <id> [--yes]

Groups:

  omnyo thread group list [--project <id>]
  omnyo thread group create <threadIds...> [--name <name>]
  omnyo thread group rename <id> <name>
  omnyo thread group delete <id>

  A chat group is a purely visual, named folder that holds top-level chats
  from one project; grouped chats run, ask and appear in the Inbox exactly as
  before. A chat is in at most one group. Without --name, create names the
  group after the words the chats' titles share, else "New group". Delete
  ungroups: the chats stay where they are. In the app, select chats in the
  sidebar and right-click → Group, or press Mod+G (rebindable as
  thread.group).

Inspecting:

  omnyo thread proof [id]                     Look up redacted command executions (--command, --event-seq, --self, --json)
  omnyo thread context [id]                   Show recorded context usage, available breakdown and automatic compaction state (--self, --json)
  omnyo thread commands [id]                  List the slash commands the thread's agent has advertised (--self, --json)
  omnyo thread options [id]                   List the session options the agent reports, with current values (--self, --json)
    --set <option=value>                   Choose a value, applied on the thread's next turn (repeatable)
    --clear <option>                       Drop a choice that has not been applied yet (repeatable)
  omnyo thread show [id]                      Show thread details and pull request status
    --include environment,host,experimental_pluginData  Include optional detail in --json
    --self                                 Target current thread
    --work-status                          Include git working-tree status
    --git-diff                             Include git diff
    --diff-target <type>                   Diff scope: uncommitted, branch_committed, all, commit
    --diff-sha <sha>                       Commit SHA (for --diff-target commit)
    --diff-merge-base <branch>             Override merge-base branch for diff

  Shows pull request status for the attached environment branch when available.

  omnyo thread log [id]                       Show thread event log
    --self                                 Target current thread
    --format <format>                      Output format: conversation (message JSON), json (events with redacted or withheld text), minimal, verbose
    --limit <count>                        Max entries: messages for conversation (oldest first, default 20, max 100);
                                           events for json (oldest first, default 100);
                                           user-message turns for minimal/verbose (newest first, default 20, max 100)
    --after-seq <seq>                      Paginate after sequence number (json/conversation)
    --through-seq <seq>                    Hold the conversation snapshot upper bound
    --all                                  Print the whole thread, paging through every entry
    --message <seq>                        Print one message
    --context <count>                      With --message, also print this many messages around it (max 20)

  Conversation JSON returns {rows: [{seq, role, text}], hasMore, nextAfterSeq, maxSeq}.
  Continue with --after-seq <nextAfterSeq> --through-seq <maxSeq>. Conversation
  --all retains the first page snapshot. Restart after history edits.
  History exports redact supported credential text and mask environment values.

  Human formats end with a notice when older history was omitted; --json warns
  on stderr when more events exist beyond the printed page. Human-format --all
  walks a consistent history snapshot and joins paginated group contents.
  Appends stay outside that walk; rerun the command if a history edit invalidates it.

  Minimal and verbose formats add a Git: line under the final assistant message
  of each completed turn that committed or pushed: commit count, branch, push
  target and repository. Verbose also lists each commit and push.

  omnyo thread output [id]                    Get the final output of a thread
    --self                                 Target current thread

  omnyo thread wait <id>                      Wait for a thread status or event (defaults to --status idle)
    --status <status>                      Wait for this status
    --event <type>                         Wait for this event type
    --timeout <duration>                   Seconds, or a duration with a unit: 90s, 20m, 4h (default: 1200s / 20 min)
    --poll-interval <duration>             Milliseconds, or a duration with a unit

  A failed thread with an automatic retry queued remains eligible for waiting.
  A timeout reports its pending retry; an error with no automatic retry fails immediately.

Opening threads and files in the app:

  In chat, reference a thread as @thread:thr_abc123, substituting its actual ID.
  Omnyo renders the correct project-aware link; do not construct thread URLs manually.
  Pasting a bare thread URL from the current Omnyo origin into a composer turns it
  into the same thread pill when the target resolves. Undo restores the URL;
  paste without formatting (Cmd/Ctrl+Shift+V) keeps it literal. Links with query
  strings or fragments, quoted/code text, and links to other origins stay literal.
  CLI prompts can use @thread:<id> directly; URL conversion only runs on a user paste.
  Reference one message as @thread:thr_abc123#msg=42, taking the number from
  sourceSeq in `omnyo thread search --json`. Read it, or a copied message link
  (…/threads/thr_abc123#msg=42), with `omnyo thread log thr_abc123 --message 42`.

  omnyo thread open <path>                    Open a file in the current Omnyo thread panel
  omnyo thread open <thread-id> [path]        Open a thread, optionally with a panel file
    --line <number>                        Line number to focus
    --split <placement>                    right, down, left, top, or replace
  omnyo thread pane <action> [thread-id]      Maximize, restore, toggle, spotlight, or clear spotlight

  Inside an Omnyo thread, OMNYO_THREAD_ID selects the current thread automatically and
  the thread ID argument is omitted for file-only opens. Outside an Omnyo thread,
  pass the thread ID as the first argument. A thread already open in a pane is focused instead of
  duplicated. Edge placement creates panes through the eighth pane; at eight
  panes, it replaces the focused pane.
  Pane actions broadcast to connected Omnyo app windows and affect the matching
  already-open pane without changing its split tree. Spotlight focuses that
  pane and dims the others; clear-spotlight focuses it and removes split dimming.
  Paths can be thread-relative workspace paths, or absolute paths inside the
  target thread workspace. Absolute paths under OMNYO_THREAD_STORAGE open as
  thread-storage files for the current thread. Use this for Markdown or HTML
  artifacts you create for the user so they open in the Omnyo IDE.

Messaging:

  omnyo thread tell <id> <message>            Send a follow-up message
  omnyo thread tell <id> --message-file <path>
                                           Read the message from a file; `-` reads stdin. Use this for
                                           multi-line or Markdown messages: inside double quotes the
                                           shell runs `backticks` and $(...) before Omnyo sees them
    --mode <mode>                          Message mode: steer (default), queue, or auto
    --model <model>                        Model override for this turn
    --reasoning-level <level>              Reasoning level override
    --plan                                 Send the message as the provider's /plan action
    --send-at <when>                       Dispatch at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --send-now                             Bypass plugin dispatch holds, including concurrency limits
    --compact-first                        Compact the idle thread's context, then send when compaction finishes
    --file <path>                          CLI-local absolute path, file: URL, or uploaded file path
    --submission-id <id>                   Retry-safe queued send (needs --mode queue): repeat the same
                                           ID after a lost reply and Omnyo returns the first acceptance
                                           instead of queueing the message twice. The ID is sub_ plus 32
                                           lowercase hex digits, for example sub_$(openssl rand -hex 16)
    --image <path>                         CLI-local absolute path, file: URL, or uploaded image path

  Tell steers by default, delivering the message immediately into the active
  turn. Use --mode queue for non-urgent follow-ups that can wait until the agent
  is free; --mode auto steers a live turn and starts a new one on an idle
  thread. Input sent while a turn is starting stays in the queue with
  `waitingOn: turn-starting`; `turn/started` wakes it and steers it into that
  turn. A target that is awaiting user interaction (an open question or
  approval) cannot take a prompt; tell then adds the message to the thread's
  queue and dispatches it once the interaction settles. That outcome is not a
  failure, so do not resend. `--json` reports `delivery` as `sent` or `queued`,
  and a queued answer carries the complete row as `queuedMessage`, including
  its `id`, `waitingOn`, and `sendAt`. A deferred message waits for a thread
  that failed while it was deferred, and delivers when the thread is retried.

  --plan sends the same structured /plan command the composer's plan action
  sends, so the agent proposes a plan for approval before executing (Claude
  Code and Codex threads). Plain "/plan ..." text is not recognized; it reaches
  the provider as literal text. Approve or deny the proposed plan with
  `omnyo thread interactions`; `omnyo thread cancel-plan` leaves Plan mode early.
  SDK callers build the same input with
  `createBuiltinPlanCommandTextInput(text)` from `@omnyo/sdk` and pass it as
  `input` to `threads.spawn` or `threads.send`.

  omnyo thread stop [id]                      Stop work and release the agent runtime
  omnyo thread compact [id]                   Request compaction of an idle or errored thread's context
  omnyo thread clear [id]                     Clear model context for an idle or failed thread
  omnyo thread cancel-plan [id]               Exit the provider's active Plan mode
  omnyo thread clear-goal [id]                Clear the provider's active Goal
    --self                                 Target current thread

  `thread compact` enqueues the same structured /compact turn used by the
  composer. Follow the thread timeline for the eventual compaction result.
  `thread clear` keeps the Omnyo thread, workspace, durable event history, and
  sticky execution settings. Its active timeline starts at one visible
  `Context cleared` boundary, and its next prompt starts a fresh provider
  conversation in the same thread. With
  `omnyo settings general keepHistoryAfterContextClear true`, earlier messages
  stay visible above that boundary.

  omnyo thread auto-compaction <id>           Allow or stop automatic compaction before the prompt cache expires
    --on                                   Allow it for this chat again
    --off                                  Keep this chat's full history

  With the `autoCompactBeforeCacheExpiry` experiment on, Omnyo runs the same
  /compact turn on an idle Claude Code chat 50 to 55 minutes after its last
  request, while the one-hour prompt cache is still warm. It runs as a silent
  maintenance turn with initiator `system`: no unread mark, Inbox receipt or
  push. `--off` opts the chat out, like Keep full history on the composer chip.
  The SDK equivalent is
  `threads.experimental_setAutoCompaction({ threadId, enabled })`.

Ownership:

  omnyo thread update [id]                    Update thread metadata
    --self                                 Target current thread
    --title <title>                        Set title
    --title-if-untitled                     Set --title only while untitled; title changes only
    --parent-thread <id>                   Assign to a parent thread
    --clear-parent-thread                  Remove parent assignment
    --section <id>                         Move into a section
    --clear-section                        Remove section assignment
    --group <id>                           Move into a chat group of the same project
    --clear-group                          Remove the chat from its group
    --model <model>                        Set the sticky model for the next and later turns
    --reasoning-level <level>              Set the sticky reasoning level (provider-dependent)
    --service-tier <tier>                  Change session speed immediately (default, fast, ultrafast)
    --visibility <visibility>              Set visible or hidden

  `omnyo thread update ID --title 'Short title' --title-if-untitled [--json]`
  requires --title without other metadata changes. It reports whether the title
  applied and the current stored title; an existing title is preserved.

  Clearing a parent inherits the former parent's section unless --section or
  --clear-section is also supplied. Children released by environment archiving
  also inherit their former parent's section.

  Model and reasoning updates stay within the thread's current provider. Omnyo
  validates them against that provider's current model catalog, applies them on
  the next turn, and keeps using them on later turns until changed.

  omnyo thread read [id]                      Mark read
  omnyo thread unread [id]                    Mark unread
  omnyo thread reorder-pinned <id> [--after <id>] [--before <id>]

Interactions:

  omnyo thread interactions list [id]         List a thread's pending and past interactions
  omnyo thread interactions show <interaction-id> [id]
                                           Show one interaction (approval details, questions, or a plugin form's data)
  omnyo thread interactions approve <interaction-id> [id]
                                           Allow a command, file-change, plan, or tool-use approval
  omnyo thread interactions deny <interaction-id> [id]
                                           Deny an approval
  omnyo thread interactions grant <interaction-id> [id] --scope turn|session
                                           Grant a permission interaction
  omnyo thread interactions answer <interaction-id> [id] --choice <questionId=value> --text <questionId=text>
                                           Answer a provider's user question
  omnyo thread interactions respond <interaction-id> [id] --value '<json>'
                                           Answer a plugin form: a plugin's own request, or a request the agent raised through a provider (kind `<pluginId>/<name>`)
    --self                                 Target current thread (every subcommand)
    --json                                 Machine-readable output (every subcommand)

  `show` prints a plugin form's `Data` so you can shape the `--value` JSON.
  A provider's plugin-defined request cannot be cancelled; stop the thread to
  back out of it.

Queued messages:
  A newer user or agent message overtakes queued retries from other request chains.
  Accepted input is dropped; unsent input remains Not sent (`waitingOn.kind = superseded`)
  until explicitly sent or deleted. Core system notices do not supersede user retries.

  omnyo thread queue list [<thread-id>] [--wait-holder plugin:<plugin-id>]
  omnyo thread queue create <thread-id> <message> [--file <path>] [--image <path>]
  omnyo thread queue update <thread-id> <message-id> <message> [--file <path>] [--image <path>] [--model <model>] [--reasoning-level <level>]
  omnyo thread queue send <thread-id> <message-id> [--mode auto|steer]
  omnyo thread queue reorder <thread-id> <message-id> [--after <id>] [--before <id>]
  omnyo thread queue group <thread-id> <boundary-id> --prefix <comma-separated-ids>
  omnyo thread queue delete <thread-id> <message-id>
  omnyo thread queue restore <thread-id> <message-id>

  The `Sender` column identifies agent threads and system notices; user messages
  leave it blank. The SDK and `--json` include `initiator` and `senderThreadId`.

  A queued message is one that could not dispatch yet. Every one carries a
  typed reason in its `Waiting on` column: waiting for the current turn to
  finish, for the workspace, for a pending interaction, for a clock (`Send at`),
  or for a plugin that has queued it. `queue list` with no thread id lists every
  queued row in the workspace; `--wait-holder plugin:<plugin-id>` narrows it to
  the rows one plugin is holding.

  A thread holds at most one pending copy of a message. When `tell`, `queue
  create` or the SDK would queue a message identical to one already waiting
  (same text, attachments, sender, execution options and `Send at`), Omnyo returns
  the existing row instead of adding another. A failed row does not count, so a
  new copy queues beside it.

  Failed rows show their failure reason instead of their previous wait, followed
  by a recovery command: `omnyo thread queue send <thread-id> <message-id>`.
  Use it to retry immediately, including after automatic retries are exhausted.
  Editing the message does not clear its failure or trigger a retry.

  `queue send` dispatches a row now, bypassing every plugin wait and its own
  schedule — the invariants (a running turn, an unfinished workspace, an
  unanswered interaction) still apply, and a message that hits one simply queues
  again. `--mode steer` uses those same send-now bypasses and re-attempts the row
  as a steer; it does not bypass the invariants, so a provisioning row remains
  queued until the workspace is ready.
  `queue delete` discards it instead. Both are always permitted.
  `queue restore` puts a deleted row back for one hour after the delete (until
  the server restarts), with its original position, group and `Send at`.

  `tell --send-now` uses the same bypass as `queue send`: plugin holds and
  schedules are skipped; host, interaction, and lifecycle admission still apply.
  The SDK equivalent is `sendNow: true` on `threads.send`.

  --send-at takes an ISO 8601 timestamp (2026-08-25T09:00, local without an
  offset) or a duration from now (30s, 10m, 2h, 7d). A time that has already
  passed is rejected, as is a bare date, which has no time of day. Several
  queued rows on one thread are normal: two scheduled sends coexist.

  --compact-first runs the same /compact turn as `omnyo thread compact` and queues
  the message behind it, so it needs an idle or errored thread whose provider
  supports manual compaction; it cannot be combined with --send-at. The SDK
  takes `compactFirst: true` on `threads.send`, which also rejects
  `mode: "steer"`. With the default-on `compactExpiredCache` setting,
  `omnyo thread context` reports `usage.compactionOfferAt`, when the provider's
  prompt cache for this context expires (Claude Code and Pi report cache
  lifetimes); after it, `--compact-first` avoids re-reading the context uncached.
  No offer is reported while the latest request is a compaction that is running
  or completed; a failed or stopped compaction keeps the offer. With the
  `autoCompactBeforeCacheExpiry` experiment on, `usage.autoCompactionAt` is when
  Omnyo will compact the idle chat itself (with
  `usage.autoCompactionOptedOut: true` when the chat is opted out), and
  `autoCompaction` reports `{ state, at, reason, cacheReadShare }`:
  `scheduled`, `skipped`, `disabled`,
  `done`, `failed` or `stopped`, with the compaction's cache-read share when
  done.

Persisted panel tabs:

  omnyo thread tabs show <thread-id>
  omnyo thread tabs set <thread-id> --expected-revision <n> --tabs-json '<json>'

Lifecycle:

  omnyo thread continue [id]                  Continue an errored chat; --status inspects, --now tries queued recovery, --model selects a model
    --self                                 Target current thread
    --all                                  Continue all eligible visible errored chats
    --status                               Inspect eligibility without starting work

  Continue uses the failed request, original startup intent or workspace
  provider as needed. Scheduled, claimed and running recovery is preserved.
  Missing setup or request facts produce an explicit refusal. Continue all
  reports each chat independently and excludes archived and hidden chats.

  omnyo thread retry [id]                     Retry the thread's failed turn
    --self                                 Target current thread
    --turn <requestId>                     Retry this turn request id specifically; fails when it is not the thread's failed turn
    --send-at <when>                       Dispatch at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --reason <text>                        Why it is being retried, shown on the queued row

  Retry re-submits the failed turn by reference: no duplicated user message in
  the timeline, and an attempt number that increments (2 is the first retry).
  What the provider is sent follows its own acceptance record — an input it
  never accepted is re-sent verbatim, while an accepted turn (already in the
  provider's conversation) is continued with a nudge rather than asked twice.
  With no --turn it retries the most recent turn, the
  one whose failure put the thread in error; --turn asserts which turn you mean
  and fails when the thread has moved on, as does retrying a thread that has not
  failed or a turn that already has a retry queued. Without --send-at the retry
  is attempted now, and may still queue behind a busy thread or a plugin.

  omnyo thread archive [id]                   Archive a thread (and children/hidden forks)
    --self                                 Archive current thread

  `thread stop` preserves the thread history, metadata, environment, and future
  resume behavior. It stops active work and releases an idle agent runtime.
  The command succeeds when no runtime is loaded. Archive a finished hidden
  worker first, then stop it to release memory promptly. A stop that only
  releases an idle runtime adds no interruption: it leaves the timeline and any
  pending interaction of that thread untouched. An explicit stop wins over work
  that is still running: when the machine still runs a turn for a thread the app
  shows as idle or failed, or a turn starts while the stop is being delivered,
  the stop interrupts that turn and waits for the attempt. If the interrupt
  fails, the thread remains stopping; check `omnyo thread show <id> --json` before
  treating the stop as confirmed.

  omnyo thread unarchive [id]                 Unarchive a thread
    --self                                 Unarchive current thread

  omnyo thread restore-environment [id]       Restore a destroyed workspace
    --self                                 Restore current thread

  omnyo thread start-on [id]                  Start a waiting new thread elsewhere
    --machine <id-or-name>                 Machine to start on; omit to list
    --self                                 Target current thread
    --json                                 Machine-readable output

  A new thread that waits for capacity before its first turn can start on
  another machine. Without --machine the command lists each machine and why
  it can or cannot take the thread. Moving pins the thread to the chosen
  machine. Only threads in a git worktree or a personal workspace can move;
  a refusal prints its reason and exits 1. In the app, the waiting thread's
  first queue row offers the same move as Start on another machine. A worktree
  thread moved to a machine without the project's checkout runs in a temporary
  copy; `omnyo temporary-copy sync <id>` copies its commits back to the original
  checkout.

  Archiving a thread retires its environment, and a managed workspace is removed
  from disk once the provider's grace window passes. Sending to a thread whose
  workspace is gone fails; `restore-environment` asks the environment provider
  to build it again and attaches it, leaving the conversation where it was.
  Each provider decides what that means: a worktree is re-created on the branch
  it held, a project checkout switches back to that branch, and a personal
  workspace cannot be restored. It starts no turn — the thread settles back to
  idle with a live workspace (check `canRestoreEnvironment` on `omnyo thread show
  --json`). Unarchive the thread first; the command is refused while the thread
  is archived, while its workspace is still there, and when the provider does
  not restore, is gone, or its machine is gone. Uncommitted changes in the
  removed workspace are not recoverable.

  omnyo thread delete <id>                    Delete permanently
    --yes                                  Skip confirmation

  Deleting a thread removes its record immediately, but provider-owned
  environment cleanup is asynchronous. Use `omnyo environment show <id>` to
  inspect teardown until the lifecycle reaches destroyed.

Shelf:

  omnyo thread shelve [id]                    Shelve a top-level thread and its child threads
    --self                                 Shelve current thread
  omnyo thread unshelve [id]                  Unshelve a thread and the rest of its family
    --self                                 Unshelve current thread
  omnyo thread list --shelved                 List shelved threads in Shelf order
  omnyo thread reorder-shelved <id> [--after <id>] [--before <id>]
                                              Move a top-level Shelf chat between neighbors

  The Shelf is your collection. Only the owner moves chats on or off the
  Shelf; Omnyo never shelves, unshelves or archives Shelf chats. A shelved chat
  keeps its view: its Inbox cards carry a Shelf mark, and with nothing pending
  it rests on the Shelf. Shelving marks the thread read; history, worktree,
  pin and section stay. Only top-level threads can be shelved, and archived
  threads cannot be. Unshelve accepts any thread in the family. In the app,
  Mod+Shift+F shelves or unshelves the open thread. A newly shelved chat goes
  to the top of the Shelf; drag Shelf rows, or use reorder-shelved, to change
  the order. Omit --after to move a chat to the top and --before to move it to
  the bottom.

Read-only commands require a thread ID or --self where supported.
Mutating thread lifecycle and messaging commands require an explicit ID or --self.

`omnyo thread context [id]` reads the latest stored context measurement without
starting a provider request. Use `--self` for the current thread and `--json` for
`{ usage, autoCompaction }`; `usage` is `null` when unavailable, and
`autoCompaction` is the automatic pre-expiry compaction state with its `at`,
`reason` and `cacheReadShare`. Claude Code refreshes the estimated
breakdown after turns and compaction when its SDK supports context inspection.
A later aggregate-only measurement replaces any older breakdown. Other providers
continue to expose their available totals.

Lifecycle ownership:
  spawn and fork accept --lifecycle-owner-thread <id>. SDK arguments use
  lifecycleOwnerThreadId, also returned in thread responses (null if independent).
  The owner must be live; projects, hosts and environments may differ.
  Ownership is immutable. Archive recursively archives/stops dependents; delete
  recursively deletes them after runtime/storage cleanup. Failed cleanup retries
  durably. Unarchive the owner before explicitly restoring a dependent. Stop does
  not cascade. Sidebar parents and ordinary forks retain their existing policies.

Thread storage deletion and orphan cleanup stop processes whose working
directories are inside that storage before removing files, including dev
servers in nested checkouts. On macOS and Linux this uses the same SIGTERM
grace period and SIGKILL fallback as worktree removal. Windows does not
enumerate process working directories.

Script and SDK messages show their source in chat. `omnyo thread tell --source "Runner name"` labels a script; without it CLI messages show CLI or the calling chat. SDK send and queued create accept `messageSource` as `{ kind: "script", label }` or `{ kind: "user" }`. Bound plugin SDKs record the plugin automatically. Older unmarked requests keep their recorded attribution.

`omnyo thread proof [id] --command 'pnpm test' --event-seq 42 --json` looks up
completed command executions through the same compact SDK route used by Glance.
Repeat either selector up to ten total. Command matching uses a unique exact
normalized command in the latest 500 completed events; explicit sequences can
select older runs. With no selectors, it validates that the chat exists.
