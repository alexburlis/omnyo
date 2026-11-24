# Thread, project, environment, and machine creation

## Spawning Threads

- Use `omnyo thread spawn --project <project-id> --prompt "..."` to create another
  thread. For a multi-line or Markdown prompt use `--prompt-file <path>` (`-`
  reads stdin) instead of quoting it inline; `omnyo thread fork` takes it too.
  Pass the intended project explicitly; the CLI does not infer it from
  context variables, and when `--project` is missing the error prints the
  current thread's project ID to add. Omitted execution flags use remembered project defaults;
  without a remembered model, Omnyo resolves the selected provider and its reported
  default model on the target machine.
- Make a scripted `omnyo thread spawn` safe to retry with `--submission-id <id>`
  (`sub_` plus 32 lowercase hex digits, such as `sub_$(openssl rand -hex 16)`).
  Reuse the ID on every retry: Omnyo creates the chat once and returns that same
  chat each time. Forks are not accepted with this flag.
- Select a target with `--environment`, `--new-environment`, `--base-branch`,
  or `--machine`. Select execution with `--provider`, `--model`,
  `--reasoning-level`, `--service-tier`, and `--permission-mode`. A service
  tier is a provider-defined id (`default`, `fast`, Codex `ultrafast`);
  `omnyo provider models <provider-id>` lists the tiers each model accepts.
- List plugin-provisioned environment choices with `omnyo environment providers`. Add `--project <id>` and optionally `--machine <id>` to omit providers whose declared requirements are unmet. Without a machine, the project listing includes providers structurally eligible on any persistent machine. Git inspection and plugin availability run only for the selected provider and machine during thread creation. `--json` includes each provider's `description` and `icon`, its `requires` facts and its `inputs` JSON Schema or null.
  Pass the selected ID to `--environment-provider`. Add
  `--environment-inputs <json>` only when the provider's schema does not accept
  an empty object; otherwise the CLI supplies `{}` when the flag is omitted.
  `--machine` picks the existing machine.
- List machine providers with `omnyo machine providers`. Create a
  new provider machine with
  `omnyo thread spawn --new-machine <provider-id> --environment-provider <id>`.
  For Modal's composed environment, use `--environment-provider modal-sandbox`
  without machine selectors; `--machine-inputs <json>` configures that composed
  machine with optional configured names such as
  `{"preset":"Large","image":"Node 22"}`. These inputs are persisted and
  readable by plugins, so keep credentials in plugin settings and send only
  non-secret configuration or references.
- Omit `--base-branch` for Omnyo's default. A named branch uses
  `origin/<name>` unless the local branch has commits it lacks; use
  `refs/heads/<name>` to force the local branch. It applies to `--new-environment
worktree` only; a provider takes its branch through `--environment-inputs`.
- Spawn also accepts `--title`, `--origin-kind`, `--source-thread`,
  `--source-seq-end`, `--agent-context-seed`, and `--json`.
- Add repeatable `--file <path>` / `--image <path>` flags for structured prompt
  attachments, `--section <id>` to add the new thread to a section, and
  `--pinned` to pin it at creation. Section and pinning can be combined;
  unpinning then reveals the thread in its section.
  Both flags upload absolute paths and `file:` URLs from the CLI machine
  before sending and pass relative server-upload tokens through unchanged.
  Use an absolute path (for example, `--file "$PWD/report.pdf"`) for local files.
- Spawn creates a root thread unless you pass `--parent-thread`.
- Handoff can target any model, including one from the source provider. In
  the follow-up picker, choose **Handoff to new thread**; **Exit handoff** in
  the picker or composer restores the source execution settings and retains
  draft edits without the automatic source reference. Closing the picker
  keeps handoff active. The new thread inherits the source title unless an
  explicit title is supplied. The source and its existing children become
  children of the new thread, keeping earlier handoffs at one level. The new
  thread links back to its source (`originKind: "handoff"`, `sourceThreadId`); its composer
  shows Continued from, the source shows Continued in, and `omnyo thread show`
  prints `Continued from: THREAD_ID`. Use `omnyo thread spawn --provider PROVIDER
--model MODEL --environment ENV_ID --origin-kind handoff --source-thread
THREAD_ID --prompt 'Continue from @thread:THREAD_ID ...'` for the same thread
  creation through the CLI, or `threads.spawn` through the SDK.
- Use `omnyo thread fork <source-thread-id>` to clone a provider session. The
  fork inherits the source conversation in its timeline. It creates an idle
  fork in the source environment by default; add `--prompt`, select an existing
  environment with `--environment`, or create a fresh personal workspace or
  worktree with `--new-environment personal|worktree`. `--base-branch` matches
  spawn for worktrees, while the target machine is always derived from the
  source environment. Anchor with
  `--source-seq-end` on a completed source turn (the clone and inherited
  timeline both end with the turn containing that sequence). Permission mode
  inherits the source thread unless explicitly overridden. A visible idle fork
  without `--title` is named after its source with a numbered prefix (`foo` →
  `(1) foo`, `(1) foo` → `(2) foo`); a fork with a first prompt is titled from
  that prompt.
- Pass `--visibility hidden` for background/plugin workers that should remain
  out of sidebar organization without contributing unread/pending favicon
  attention. `omnyo thread list` excludes them by
  default; pass `--include-hidden` when a hidden worker must be discovered.
  Direct-ID lifecycle and messaging operations remain available. A root thread
  is visible by default; a child thread inherits its parent's visibility, so a
  hidden thread's subagents are hidden too. Pass `--visibility` to override the
  inherited value. A hidden child still reports its turns, blockers and
  questions to its parent thread; only forks and side chats stay silent.
- A plugin can keep one of its own chats as a home chat (for example the chat
  behind a plugin page's embedded conversation). Home chats are visible and
  hold native questions, but the sidebar, Inbox, counts, pushes and default
  search leave them out. `omnyo thread list` still shows them, marked
  `home of <plugin>`. Disabling or removing the plugin clears the mark.
  Promote or hide an existing thread with
  `omnyo thread update <id> --visibility visible|hidden`.
- Stop a finished hidden worker with `omnyo thread stop <id>` to release its agent
  runtime promptly. Archive it first when it no longer belongs in active thread
  lists. Stop preserves the thread and supports a later resume.
- Add remote execution machines from Settings → Machines. Its one-line
  installer stores the account machine credential locally and configures
  both the daemon protocol and agent-launched `omnyo` CLI to traverse the account
  gate; revoke a lost machine from the omnyo.link dashboard. It uses
  the server's exact `/install/omnyo-app.tgz` artifact and stops when the server
  does not provide it. It installs under the enrollment's Omnyo data directory, without
  `sudo` or a global npm configuration, and enables daemon `--auto-update`.
  Newer protocol mismatches update that private install with a persisted
  exponential retry backoff from 5 seconds to 5 minutes, then let
  launchd/systemd restart the daemon. Auto-update never downgrades. To bypass a
  transient backoff, use `omnyo machine retry-update <id-or-name>`. Remove
  `--auto-update` from the service definition and reload it to opt out.
- Run `omnyo machine list` to see machine names, the server role, IDs, type,
  connection status, and last seen time (`--json` returns the raw host list). It shows persistent
  machines; pass `--all` to include the disposable sandboxes environment
  providers create per thread. Use `--machine <id-or-name>`
  (alias `--host`) on `omnyo thread spawn` to run in a personal or unmanaged
  workspace, or combine it with `--new-environment worktree`. Do not combine a
  machine selector with an existing environment ID, which already owns its
  machine.
- Each machine carries a permission limit (`maxPermissionMode`, default
  `full`): the highest permission mode a thread on that machine may run with.
  The server resolves any higher request down to it, and refuses a provider
  that supports no mode under it. Only the owner can change it, on the machine
  page at Settings → Machines → the machine — there is no CLI, SDK, or API
  surface that sets it, and machine credentials are refused — so read it from
  `omnyo machine list --json` or `omnyo machine show` and ask the user to change it
  in the app.
- `omnyo machine providers`, `show`, `rename`, `retry-update`,
  `suspend`, `resume`, `retry-cleanup`, and `remove` cover the Settings →
  Machines lifecycle. Use `omnyo machine provider-cli status|install` to inspect
  or install provider CLIs on a selected machine.
- `omnyo updates` runs the default `omnyo updates status` action. It aggregates Omnyo and provider
  CLI update state across every machine — the CLI counterpart of Settings →
  Updates. `omnyo updates apply [--machine <id-or-name>] [--yes]` runs every available
  provider CLI install/update sequentially. `--yes` pauses chats on each affected
  machine and resumes them after installation. Without it, busy machines block
  installation. `omnyo machine provider-cli install MACHINE PROVIDER --action update --yes`
  applies the same workflow to one CLI. `omnyo updates app` shows whether Omnyo
  can update itself, which it cannot when started with `--no-in-app-updates`;
  `omnyo updates app apply [--yes] [--no-wait]` downloads the
  update and restarts Omnyo into it, without rolling back if it fails to start.
  Running it from a thread restarts Omnyo and interrupts that thread. On a private
  coordinator, `apply` without `--yes` instead installs once every chat is idle,
  without holding new messages, and returns; `omnyo updates app cancel` stops it.
  If chats are still running 10 minutes after the apply, the coordinator stops
  them, restarts and resumes them (`activity.stopsRunningChatsAt` in JSON).
  `--yes` does this immediately, without waiting for worker admission. The
  launcher stops both local processes and sends SIGKILL after five seconds if
  needed. Ordinary idle updates retain the worker admission check.
  Source installs show their Git revision and use manual Git updates without the
  update shim. They are never compared with npm releases; unavailable release
  checks report “Latest unknown”.
  Private server releases identify their private channel and direct the owner to
  the verified private release installer instead of querying npm.
- Use `omnyo project create --name <name> --root <path> --machine <id-or-name>`
  to bind a new project's local path to a connected enrolled machine. Use
  `--host` as an alias. Without a selector, the CLI asks its local host daemon.
- `omnyo project list` preserves the ordinary-project-only default. Pass
  `--include-personal` when the singleton personal project must be discoverable.
- Use `omnyo project source add <project-id> --machine <id-or-name> --path <path>`
  to register a path on another connected machine. It uses the same selector
  resolution and fallback as project create. Use `--clone` instead of `--path`
  to clone the project's remote there; `--remote-url` and `--target-path` are
  optional clone overrides.
- `omnyo project paths|files|content|commands` accept `--machine <id-or-name>`
  (`--host` alias) or `--environment <id>`, but not both. An environment uses
  its owning machine and workspace; an explicit machine uses that machine's
  project source; omitting both intentionally uses the server machine's source.
  `omnyo project content --json` returns UTF-8 text or base64 binary content with
  an explicit `contentEncoding`.
  Project/environment file and path searches honor Git ignore rules, retaining
  tracked and non-ignored untracked files, including hidden files. Non-Git
  workspaces use filesystem listing. `omnyo file list|paths` can inspect ignored
  files, subject to their exclusion options.
- Use `omnyo project attachment upload <project-id> --client-file <path>` when the
  bytes live on the CLI machine, including when the CLI and omnyo server are on
  different hosts. It reads locally and sends multipart bytes through the
  configured `OMNYO_SERVER_URL` (and its enrolled-machine authentication proxy),
  returning the stable server attachment DTO. Optional `--filename` and
  `--mime-type` override inferred metadata. Thread `--file` and `--image` perform this
  upload automatically for absolute paths and `file:` URLs; use the explicit
  command when a reusable attachment token is needed. Attachments are
  capped at 35MB, empty files are rejected with `attachment_empty`, and
  image/heic or image/heif uploads
  are rejected (convert them to JPEG or PNG first). `omnyo project attachment
download <project-id> <attachment-path> --client-file <path>` writes existing
  attachment bytes on the CLI machine. There is no project-attachment list or
  per-file remove API.
- Use `omnyo project attachment retain <source-project-id> <owner-thread-id>
<paths...>` to retain up to 24 existing attachments without sending a prompt.
  The owning thread may belong to another project; attachment bytes stay in
  the source project. Repeated claims are safe. Same-project thread forks
  preserve ownership, and deleting the last owning thread releases it.
  Missing, pending or expired paths reject the whole request.
- `omnyo project history|reorder` exposes project prompt recall and sidebar order.
- Use `omnyo project show|update|delete` for one project. Use `omnyo project source
update|delete` for one source. Use `omnyo project branches` for branch data.
- Direct environment inspection accepts any environment ID: use `omnyo environment
status|branches|paths|diff|diff-files|diff-file|diff-patch <id>` and `omnyo
environment pull-request show <id>`. Diff commands require an explicit target
  and the matching merge-base or commit flags; all support `--json`.
- `omnyo environment pull-request ready|draft|merge` manages pull-request state;
  `omnyo environment archive-threads` bulk-archives an environment's threads.
- Use `omnyo environment show|update|commit` for environment metadata
  and Git changes. Check live help before a commit or merge.
- Spawned child threads inherit permission from explicit flags, then the
  parent thread's last execution, then project defaults. The parent's mode is
  a hard ceiling: an explicit flag can lower it but never exceed it.
- Public permission modes are `accept-edits`, `auto`, and `full`.
  `accept-edits` keeps workspace sandboxing and asks the user to review
  escalations. `auto` keeps the same workspace sandbox while using the
  provider's automatic reviewer. `full` explicitly bypasses sandbox and
  approval protections. Plan mode remains separate. The product default is
  `auto` when no inherited or project default applies.
- Subagents inherit the parent's permission mode by default;
  `--permission-mode full` only takes effect when the parent itself runs full.
- Use `--parent-self` inside a thread to parent the new thread to the current
  thread.
- Use `--parent-thread <thread-id>` to choose another specific parent.
- A child's questions go to its parent chat as messages, not to the owner. The
  parent answers with `omnyo thread tell <child-id> --mode auto`, or asks its
  own question when only the owner can decide and relays the answer. See
  thread-operation.md.
- A parent can live in a different project. Pass `--project <other-id>` with
  `--parent-self` to delegate work in another repository; the child still
  reports back to its parent and inherits its permission mode by default, adapted
  to the child provider's supported modes. Explicit requests and recorded modes
  take precedence over inheritance; the host permission ceiling still applies.
- If provider or model choice matters, inspect options with `omnyo provider list`
  and `omnyo provider models <provider-id>`. Both accept `--machine <id-or-name>`
  (alias `--host`) or `--environment <id>` to inspect the machine where work
  will run; the selectors cannot be combined. With neither selector they
  intentionally inspect the server machine. Model lists answer from the
  machine's last stored list while a background refresh runs, so a list can be
  hours old. A provider whose refresh keeps failing or timing out keeps
  answering from its last stored list. When nothing can be listed, the command
  prints the provider, failure code, and underlying host message on stderr.
  A plugin notice, such as the Account Pooler's "OpenAI used up until … ·
  Using openai2@", also prints on stderr until the time it names.
- Top-level `customModels` in the same `config.json` registers extra picker
  models. Use a provider ID returned by the target host's catalog. Acceptance
  of unlisted models is provider-specific; consult that provider's skill.
  This list has no set/unset CLI surface. Edit the JSON and restart Omnyo.
  The `streamerMode` General preference hides every entry from model lists.
- Top-level `sharedSkillRoots` uses the same relative `user` and `project`
  paths. Omnyo lists these skills as read-only. Omnyo injects them into each provider,
  so one physical skill collection can support Omnyo and standalone provider CLIs.

Give spawned threads clear prompts: objective, constraints, expected deliverable,
validation to perform, and what to report back. Ask for outcome, changed files
or artifacts, validation performed, and blockers.

`omnyo environment show <id>` includes the core-owned lifecycle phase, retirement deadline, and teardown status/attempt/message. Archive or delete the last live thread to begin its provider's retirement grace; unarchive cancels pending retirement. Teardown failures retry automatically. Checkout policy keeps its directory indefinitely.

### Standalone machine creation

`omnyo machine create --provider <id> [--key <idempotency-key>] [--inputs <JSON>]
[--no-wait] [--json]` creates a machine without a thread. Omitted
inputs are null and must satisfy the provider schema; omitted key is generated
by the server. Supply a stable key to recover the same creation across retries.
Creation is durable. `--no-wait` returns the host ID; `omnyo machine show
<host-id>` inspects it and `omnyo machine remove <host-id>` cancels it. SIGINT
stops following and exits with status 130 while creation continues. Machine
lists and name/ID selectors include machines still being created. Standalone
machines remain until explicitly removed.

`omnyo machine show <id-or-name> --json` includes `providerDetails` inventory and
estimates when available. Suspend requires idle threads and no open terminals;
empty machines use the provider’s opt-in idle timeout. Resume waits for pending
suspension and leaves an already-active machine active.

### Local machine lifecycle

`install-machine.sh --start|--stop|--uninstall --host-id <id>` operates on that machine's local
installation. Optional `--server-url` and `--data-dir` assert its identity and
installation location; OMNYO_DATA_DIR is also an assertion, never permission to
remove another installation. Uninstall checks ownership before stopping its
service, releasing its port reservation and deleting its private files.

### Moving the server

Moving the server needs the default-off `serverMove` experiment:
`omnyo settings experiment serverMove true`. Without it the server refuses
`omnyo server move`, `omnyo server export`, and old-copy deletion with
`server_move_experiment_disabled`.

Server moves are experimental. As an agent, never start a move, abandon one,
or unlock an old copy unless the user explicitly confirmed that action in the
conversation. Run `--check`, show the user the checklist, and wait for their
confirmation before running the command; don't pass `--yes` to skip the
confirmation on their behalf.

Run `omnyo server move --to <machine> --check` first. It prints blockers,
warnings, and notes and exits nonzero while the move is blocked. A
direct-address server also needs `--address <url>`: the URL every machine and
app will use to reach the new server. When the target already has omnyo server
data, pass `--archive-existing-data` to move it aside; it is never merged.
Without `--check`, the command confirms (pass `--yes` in a non-interactive
shell), stops all running work, and follows the steps. It exits 0 once the
server has moved, 1 when the move fails or is cancelled, and 2 when the target
never confirmed the switch; `--json` prints the final status. SIGINT stops
following while the move continues. `omnyo server move status` shows the steps or
the last move and also exits 2 while a move needs recovery.
`omnyo server move cancel` cancels before the switch starts. While a move needs
recovery (`recovery_required`: the old server stays up read-only and keeps
retrying activation and checking `<serverUrl>/health`), cancel abandons it,
rolling back the lock and `config.json` and keeping the server here; it warns
and asks first because a target that already took over would leave two
servers, and `--yes` skips the question.

`omnyo server export --out <file>` writes a gzip archive of a running server with
file mode 0600 and keeps it only when it matches the SHA-256 digest the server
sent. The archive is not encrypted and holds the server's credentials and
plugin secrets; the command warns about that, and `--json` prints `path`,
`sizeBytes`, `sha256`, and `warning`.
`omnyo server import <file> [--data-dir <dir>]` installs an export into a local
data directory without calling a server. It refuses when that directory has a
`app.db` or Omnyo is running from it, refuses an export made by a newer Omnyo or by a
server with the `serverMove` experiment off, and asks you to re-export an
archive encrypted by an older Omnyo. A rerun rolls back an interrupted import from
`server-import-journal.json` before importing again (`--json` reports
`rolledBackInterruptedImport: true`), and Omnyo refuses to start a
server on an interrupted import until then. Stop the original server before
you start the imported one: both hold the same Omnyo account credential and would
take each other's tunnel.

An import also writes `server-connect-hold.json`, so the imported server starts
without its connect tunnel or Omnyo account. After the original server is stopped,
`omnyo server allow-connect [--data-dir <dir>] [--yes] [--json]` removes the hold
(`--json` prints `dataDir` and `connectHoldRemoved`); both start the next time
that server starts.

The old computer's data directory keeps a `server-moved.json` lock, so Omnyo runs
there as a regular machine. `omnyo server delete-old-copy` deletes the server files
the move left behind and keeps the lock. The desktop app installs a persistent,
self-updating machine service there after the move; until that succeeds, and
after a move from `omnyo-app`, the machine stays connected only while the app runs.
`omnyo server install-machine-service [--data-dir <dir>] [--yes] [--json]` stops
Omnyo there and runs `install-machine.sh --adopt --data-dir <dir>` to install the
persistent, self-updating service with the same machine ID. It runs on macOS
and Linux only and refuses on Windows. It needs Node.js
22.19 or newer on the PATH, and `omnyo server unlock` refuses while the service
exists. `omnyo server unlock` removes the lock so
the old copy can start again; everything since the move is lost there, and the
new server must be stopped first. It probes `<serverUrl>/health` (connect
mode: `/api/v1/system/version` with the machine grant in `config.json`) and
refuses while the new server answers, unless you pass `--force`; Omnyo on that computer
then starts the old server within a few seconds. Unlock also removes the new server's
`serverUrl`, `serverHeaders`, `machineCredential`, and `connectMachineId` from
that directory's `config.json`. These two commands also act on the local data
directory only.

### Private machine enrollment

For an existing machine, use `omnyo machine create --provider manual` and run the
printed command on the target. That command installs Omnyo if needed and enrolls
the machine with this server.

Use `omnyo machine enroll --bootstrap-file <path>` or `--bootstrap-env <NAME>` on a machine that already has the CLI. Core prepares the versioned bundle; transport it through a private file or environment/stdin, never command arguments, logs, resource JSON, or a transcript. Enrollment refuses a different existing host/server identity and succeeds without another exchange when the same identity is already enrolled. The installer accepts `--bootstrap-env <NAME>` and invokes this command after installing Omnyo. Machine state defaults to `~/.omnyo-machines/<server-host>`; an explicit `OMNYO_DATA_DIR` must be isolated from the default Omnyo instance. For remote non-login commands, discover `omnyo` on PATH and fall back to `~/.local/bin/omnyo`.

Delivered enrollment bundles from v1 remain valid until their expiry. The CLI accepts both file and environment forms, upgrades the bundle to v2 headers locally, and persists legacy Connect redemption before enrollment so a retry reuses it. The installer upgrades v1 environment bundles before authenticated artifact downloads.

The core `manual` provider appears as Manual machine setup. `omnyo machine create --provider manual` waits for the enrollment command to become ready, prints it once, and follows until the daemon connects; `--no-wait` returns the creating host ID. Commands are no longer available after enrollment or removal. Manual machines never suspend or retire automatically. Removal revokes access; run the original installer with `--uninstall --host-id <id>` on the target using its original data directory.

For paths a provider owns, Omnyo runs `.omnyo-env-setup.sh` after create and
`.omnyo-env-teardown.sh` before remove on that machine, with separate 15-minute
timeouts. Setup failure fails the launch with output in provisioning progress;
teardown script failure is logged and removal continues. Attaching a user-maintained project checkout or personal workspace skips both
hooks. A fresh core clone on a new machine is owned and runs the hooks. Providers do not run these
core hooks themselves.
Thread startup does not validate agent credentials, fingerprint the checkout, or install agent CLIs.

`omnyo machine list --json` includes lifecycle phase, progress, and any suspension or resume error.
Maintenance interrupts active turns and closes terminals before saving. Submit a
new continuation turn after restore; interrupted turns are never reported successful.

Resuming a machine restores its provider state without rerunning environment setup.

Personal file access: `omnyo project paths|files|content proj_personal` requires
an explicit `--environment <id>` belonging to Personal. Personal has no default
project source; the selected environment must be ready.

## Lifecycle ownership

Use `--lifecycle-owner-thread <id>` on spawn or fork only when the new thread
should archive or delete with that owner. SDK spawn/fork use
`lifecycleOwnerThreadId`. Responses return null for independent threads. The
owner must be live; other projects, environments and hosts are allowed.
Ownership is immutable. Stop does not cascade. Archive retains history; delete
waits for dependent storage cleanup with durable retries. Unarchive the owner
before explicitly unarchiving dependents.
