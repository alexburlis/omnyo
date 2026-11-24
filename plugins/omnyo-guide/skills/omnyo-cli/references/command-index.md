# Core command index

This index lists every command path that the core CLI registers, including aliases: `thread get|view|status` run `thread show`, `thread message|send` run `thread tell`, `thread messages|timeline` run `thread log`, `thread create|new` run `thread spawn`, `terminal read` runs `terminal output`, `plugin uninstall` runs `plugin remove`, and `environment get` runs `environment show`. At the top level `omnyo host`, `omnyo hosts`, and `omnyo machines` run `omnyo machine`, `omnyo env` runs `omnyo environment`, and the plurals `threads`, `projects`, `terminals`, `providers`, `plugins`, and `skills` run their singular command, unless a plugin registers that name. `omnyo guide commands <group>` prints a group's commands with every option on one page. Read the task-specific reference before you use a command. Check live help for flags and defaults.

## question

- `omnyo question`
- `omnyo question list`
- `omnyo question command`
- `omnyo question adopt`

## callback

- `omnyo callback`
- `omnyo callback wait`
- `omnyo callback waiting`
- `omnyo callback clear`

`omnyo callback wait [threadId] --from SOURCE --reason TEXT`,
`omnyo callback waiting [threadId]` and `omnyo callback clear [threadId] --id EXACT_ID`.
Native question and callback commands accept `--self` and `--json`; adoption
accepts `--json`. See thread-operation.md for ownership and lifecycle rules.
`question command` requires `--value JSON`. `question adopt` requires
`--plugin decisions|needs-you`. `callback wait` requires `--from SOURCE` and
`--reason TEXT`. `callback clear` requires `--id EXACT_ID`.

## inbox

- `omnyo inbox`
- `omnyo inbox act`
- `omnyo inbox undo`
- `omnyo inbox failures`
- `omnyo inbox acknowledge-failure`

`omnyo inbox [--json]` prints the owner's Inbox in the app's order.
`omnyo inbox act <threadId> <action>` acts on a top-level chat's card with `ok`,
`archive [--stop-running]`, `wait --until WHEN`, `wait-report --event TEXT`,
`accept-proposal`, `keep-waiting [--until WHEN]`, `remind-later`,
`happened [--note TEXT]`, `shelf`, `unshelf`,
`snooze-question --until WHEN [--question ID]`, `cancel-wait`,
`resume [--target ID]` or `continue-with-result`. `--wait ID` overrides the
card's wait. `omnyo inbox undo [moveId]` defaults to the last move. Inbox card actions
are owner-only: a call from a chat or an automation is refused.

`omnyo inbox failures <threadId> --json` lists retained failure IDs, stored turn
IDs and status. To acknowledge an obsolete failure, use
`omnyo inbox acknowledge-failure <threadId> --failure <id> --turn <stored-turn-id> --reason "<why obsolete>" --json`.
All identities and the audit reason (1–1,000 characters) are required; no latest
failure is selected.
The owner or the target's actual parent/root agent may acknowledge only an
inactive target with no pending work. Active work cannot be cleared.
Acknowledgment preserves history and does not replay work, archive the chat,
declare completion or force archive readiness. Keep the normal caller identity.

## wait

- `omnyo wait`
- `omnyo wait rearm`
- `omnyo wait met`
- `omnyo wait done`
- `omnyo wait cancel`
- `omnyo wait list`
- `omnyo wait sources`
- `omnyo wait check`

Every turn ends by asking a native required question, registering `omnyo wait`, or
stopping. A child chat's question goes to its parent chat as a message, not to
the owner; the result's `routedToThreadId` names the parent, and the parent
answers with `omnyo thread tell <child-id> --mode auto`.
`omnyo wait [threadId] --key KEY --for TEXT` with `--chat ID`, `--event KEY`,
`--check TEXT --at WHEN` or `--report TEXT` registers a continuation. A wake
turn answers with `omnyo wait rearm <id>`, `omnyo wait met <id> --condition KEY`
or `omnyo wait done <id>`. Wait commands take `[threadId]`, `--self` and
`--json`, and default to `OMNYO_THREAD_ID` inside a chat. `omnyo wait sources`
lists the installed event key families and their health; `omnyo wait check KEY`
validates one key and runs its source once. Read thread-operation.md for the
wake decision tree. `omnyo thread wait` is different: it blocks until a thread
reaches a status.

## status

- `omnyo status`

## settings

- `omnyo settings`
- `omnyo settings show`
- `omnyo settings ai-services`
- `omnyo settings ai-services show`
- `omnyo settings ai-services set`
- `omnyo settings ai-services test`
- `omnyo settings general`
- `omnyo settings replay-onboarding`
- `omnyo settings completed-turns`
- `omnyo settings experiment`
- `omnyo settings keyboard`
- `omnyo settings keyboard hints`
- `omnyo settings keyboard list`
- `omnyo settings keyboard set`
- `omnyo settings keyboard reset`
- `omnyo settings ui`
- `omnyo settings ui list`
- `omnyo settings ui get`
- `omnyo settings ui set`
- `omnyo settings ui reset`
- `omnyo settings usage`
- `omnyo settings version`
- `omnyo settings reload`

`omnyo settings usage` accepts `--refresh` to fetch fresh provider usage.

## project

- `omnyo project`
- `omnyo project source`
- `omnyo project source add`
- `omnyo project source update`
- `omnyo project source delete`
- `omnyo project attachment`
- `omnyo project attachment upload`
- `omnyo project attachment download`
- `omnyo project attachment retain`
- `omnyo project attachment diagnostic`

`omnyo project attachment download --thumbnail-width 160|320|640` requests a lossless preview; the exact original remains the default.

- `omnyo project list`
- `omnyo project discover`
- `omnyo project history`
- `omnyo project reorder`
- `omnyo project branches`
- `omnyo project paths`
- `omnyo project commands`
- `omnyo project files`
- `omnyo project content`
- `omnyo project create`
- `omnyo project show`
- `omnyo project update`
- `omnyo project delete`

`omnyo project update` takes `--name`, `--icon PATH.png` and `--reset-icon`; icons
are PNG, up to 512 × 512 pixels and 48 KiB.

`omnyo project show <id>` accepts `proj_personal` to inspect Personal.
`omnyo project commands --snapshot --json` reads prepared metadata and reports
readiness. The default waits for a complete refresh.

## prompt-history

- `omnyo prompt-history`
- `omnyo prompt-history list`

## provider

- `omnyo provider`
- `omnyo provider list`
- `omnyo provider enable`
- `omnyo provider disable`
- `omnyo provider models`
- `omnyo provider claude-profile`
- `omnyo provider claude-profile list`
- `omnyo provider claude-profile add`
- `omnyo provider claude-profile status`
- `omnyo provider claude-profile login`
- `omnyo provider claude-profile login-status`
- `omnyo provider claude-profile login-cancel`
- `omnyo provider claude-profile default`
- `omnyo provider claude-profile pilot`

## machine

- `omnyo machine`
- `omnyo machine providers`
- `omnyo machine enroll`
- `omnyo machine env`
- `omnyo machine env list`
- `omnyo machine env set`
- `omnyo machine env unset`
- `omnyo machine create`
- `omnyo machine list`
- `omnyo machine show`
- `omnyo machine housekeeping`
- `omnyo machine reconnect`
- `omnyo machine direct-access`
- `omnyo machine rename`
- `omnyo machine away`
- `omnyo machine available`
- `omnyo machine remove`
- `omnyo machine suspend`
- `omnyo machine resume`
- `omnyo machine reconcile`
- `omnyo machine retry-cleanup`
- `omnyo machine retry-update`
- `omnyo machine provider-cli`
- `omnyo machine provider-cli status`
- `omnyo machine provider-cli detect <machine>` checks for Claude Code, Codex, and ACP executables.
- `omnyo machine rtk-status <machine>` checks the machine's agent PATH.
- `omnyo machine provider-cli install`

`omnyo thread spawn --new-machine <provider-id>` creates a machine for a new
environment and requires `--environment-provider <id>`. For a composed option,
use `--environment-provider modal-sandbox` alone. `--machine-inputs <json>`
configures the machine with optional configured `preset` and `image` names;
`--environment-inputs <json>` configures the workspace. Neither carries secrets.

## server

- `omnyo server`
- `omnyo server maintenance`
- `omnyo server maintenance status`
- `omnyo server maintenance acquire`
- `omnyo server maintenance prepare`
- `omnyo server maintenance prepare quiesce`
- `omnyo server maintenance prepare create-manual-target`
- `omnyo server maintenance prepare configure-direct-access`
- `omnyo server maintenance prepare convert-to-direct`
- `omnyo server maintenance prepare enable-server-move`
- `omnyo server maintenance prepare rebind-plugin`
- `omnyo server maintenance release`
- `omnyo server maintenance repair-runtime`
- `omnyo server maintenance adopt-identity`
- `omnyo server move`
- `omnyo server move status`
- `omnyo server move cancel`
- `omnyo server export`
- `omnyo server import`
- `omnyo server unlock`
- `omnyo server allow-connect`
- `omnyo server delete-old-copy`
- `omnyo server install-machine-service`

`move`, `move status`, `move cancel`, and `export` call the running server.
Server moves are experimental; agents run `move` (without `--check`),
`move cancel`, and `unlock` only after the user explicitly confirms.
`import`, `unlock`, `allow-connect`, and `delete-old-copy` act on a local data
directory (`--data-dir`, else `OMNYO_DATA_DIR`, else `~/.omnyo`) and never call a
server. `install-machine-service` acts on the same local data directory after a
move and downloads the new server's omnyo-app package for its service.
configuration.md covers maintenance holds, preparation and direct access.

## updates

- `omnyo updates`
- `omnyo updates status`
- `omnyo updates apply`
- `omnyo updates app`
- `omnyo updates app status`
- `omnyo updates app apply`
- `omnyo updates app cancel`
- `omnyo updates app dismiss`
- `omnyo updates web`
- `omnyo updates web status`
- `omnyo updates web apply`
- `omnyo updates web rollback`

Completed app-update cancellations report `outcome: "cancelled"`; `apply --wait`
returns without a failure exit for that outcome. Unexpected restart failures and
unresolved admission holds remain actionable. `app dismiss` acknowledges only
the result ID it read, preserving newer failures.

## preview

- `omnyo preview`
- `omnyo preview register`
- `omnyo preview list`
- `omnyo preview show`
- `omnyo preview status`
- `omnyo preview restart`
- `omnyo preview remove`

Register and list require `--thread <id>`. Registration takes `--url` and the
exact executable/arguments after `--`; it does not start the server. See
thread-operation.md or `omnyo guide previews` before registering a server.

## terminal

- `omnyo terminal`
- `omnyo terminal list`
- `omnyo terminal create`
- `omnyo terminal start`
- `omnyo terminal show`
- `omnyo terminal foreground`
- `omnyo terminal attach`
- `omnyo terminal send`
- `omnyo terminal resize`
- `omnyo terminal output`
- `omnyo terminal read`
- `omnyo terminal wait`
- `omnyo terminal rename`
- `omnyo terminal restart`
- `omnyo terminal close`
- `omnyo terminal stop`

Read [thread command index](thread-command-index.md) for this topic.

## environment

- `omnyo environment`
- `omnyo environment providers`
- `omnyo environment list`
- `omnyo environment delete`
- `omnyo environment cleanup`
- `omnyo environment show`
- `omnyo environment get`
- `omnyo environment status`
- `omnyo environment branches`
- `omnyo environment paths`
- `omnyo environment diff`
- `omnyo environment diff-files`
- `omnyo environment diff-file`
- `omnyo environment diff-patch`
- `omnyo environment update`
- `omnyo environment commit`
- `omnyo environment archive-threads`
- `omnyo environment pull-request`
- `omnyo environment pull-request show`
- `omnyo environment pull-request ready`
- `omnyo environment pull-request draft`
- `omnyo environment pull-request merge`

## file

- `omnyo file`
- `omnyo file read`
- `omnyo file write`
- `omnyo file list`
- `omnyo file list PATH --icons` discovers project icons through Git indexes and bounded directory discovery, excluding hidden paths; JSON reports truncation.
- `omnyo file paths`
- `omnyo file mkdir`
- `omnyo file move`
- `omnyo file remove`

## theme

- `omnyo theme`
- `omnyo theme list`
- `omnyo theme set`
- `omnyo theme dir`
- `omnyo theme favicon`
- `omnyo theme favicon set`
- `omnyo theme favicon reset`
- `omnyo theme show`
- `omnyo theme reset`

## plugin

- `omnyo plugin`
- `omnyo plugin search`
- `omnyo plugin list`
- `omnyo plugin source`
- `omnyo plugin install`
- `omnyo plugin install-jobs`
- `omnyo plugin cancel-install`
- `omnyo plugin outdated`
- `omnyo plugin update`
- `omnyo plugin update-jobs`
- `omnyo plugin new`
- `omnyo plugin types`
- `omnyo plugin migrate`
- `omnyo plugin build`
- `omnyo plugin dev`
- `omnyo plugin reload`
- `omnyo plugin rpc`
- `omnyo plugin rpc list`
- `omnyo plugin rpc inspect`
- `omnyo plugin rpc call`
- `omnyo plugin enable`
- `omnyo plugin disable`
- `omnyo plugin safe-mode`
- `omnyo plugin prune`
- `omnyo plugin relocate`
- `omnyo plugin config`
- `omnyo plugin token`
- `omnyo plugin run`
- `omnyo plugin logs`
- `omnyo plugin remove`
- `omnyo plugin uninstall`

## marketplace

- `omnyo marketplace`
- `omnyo marketplace add`
- `omnyo marketplace list`
- `omnyo marketplace refresh`
- `omnyo marketplace remove`

## skill

- `omnyo skill`
- `omnyo skill list`
- `omnyo skill show`
- `omnyo skill files`
- `omnyo skill update`
- `omnyo skill delete`
- `omnyo skill search`
- `omnyo skill registry`
- `omnyo skill registry detail`
- `omnyo skill registry stage`
- `omnyo skill registry stage-file`
- `omnyo skill install`
- `omnyo skill cli-skills-status`
- `omnyo skill install-cli-skills`

## guide

- `omnyo guide`

## explore

- `omnyo explore`

`omnyo explore [<type>/<slug>] [--type <type>] [--query <text>] [--text] [--json]` reads the public Explore catalog at https://omnyohq.com without the coordinator or any Omnyo caller headers. Types are `prompt`, `workflow`, `skill`, `plugin` and `guide`. `--query` matches every word against title, summary and tags. A key such as `prompt/review-a-product-update` shows one item and its next step; `--text` prints that prompt's exact text and nothing else. A catalog that is not published yet fails with `explore_unavailable`.

`omnyo explore skills [--query <text>] [--json]` reads the separate public source-skill catalog at https://omnyohq.com/explore/skills/catalog.json. Query words match the slug, title, publisher, category, summary, and keywords. Each JSON item includes `slug`, `title`, `category`, `publisher`, `license`, `keywords`, `sourceUrl`, `source`, `revision`, `sha256`, optional `summary`, and `detailPath`. The source URL identifies the reviewed GitHub revision or versioned Omnyo edition. The command does not install or execute skills and does not accept `--text` or `--type`.

`omnyo explore marketplace [--type skill|workflow|connector] [--query <text>] [--category <category>] [--publisher <publisher>] [--json]` reads https://omnyohq.com/explore/marketplace.json without coordinator or caller headers. Category and publisher filters match exact values. Query words match the slug, title, summary, publisher, category, and keywords. JSON returns `{items: [...]}` with common fields `kind`, `slug`, `title`, optional `summary`, `publisher`, `category`, `keywords`, and `detailPath`. Skills also include `source`, `sourceUrl`, `revision`, `sha256`, and `license`; workflows include `sha256` and `requirements`; connectors include `pluginId`, `service`, `requirements`, and `availability`. Browsing installs nothing. `--text` is unavailable in this mode; `--category` and `--publisher` require this mode. Existing Explore keys and the separate `skills` command remain available.

## diagnostics

- `omnyo diagnostics`
- `omnyo diagnostics cli-errors`

`omnyo diagnostics cli-errors` tallies the failed `omnyo` invocations recorded in `<data dir>/logs/cli-errors.jsonl` on this machine. It records the command path, the error code, and the unknown command or flag, never argument values. `OMNYO_CLI_ERROR_LOG=0` turns recording off.

## bug

- `omnyo bug`
- `omnyo bug report`

`omnyo bug report [message] [--message-file PATH|-] [--email ADDRESS] [--json]` sends a bug report as Sentry user feedback through the coordinator, linked to the running release. It sends only the message (up to 4,000 characters) and the optional email, never logs, screenshots or chat content. It fails with `bug_reports_unavailable` when Crash reports is off or the server has no Sentry DSN, and prints the report reference on success. SDK: `system.experimental_reportBug`.

## voice

- `omnyo voice`
- `omnyo voice prepare`
- `omnyo voice transcribe`
- `omnyo voice diagnostic`

## browser

- `omnyo browser`
- `omnyo browser instances`
- `omnyo browser profile-renderer`
- `omnyo browser tabs`
- `omnyo browser create`
- `omnyo browser acquire`
- `omnyo browser connection`
- `omnyo browser release`
- `omnyo browser reveal`
- `omnyo browser close`
- `omnyo browser capture`
- `omnyo browser watch`
- `omnyo browser import-sources`
- `omnyo browser import-cookies`
- `omnyo browser cookie-sync`
- `omnyo browser cookie-sync status`
- `omnyo browser cookie-sync enable`
- `omnyo browser cookie-sync disable`
- `omnyo browser cookie-sync run`

`omnyo inbox --json` includes server-owned state and reason, recap, archiveReady, optionalQuestion, pendingResults and counts.needsYou.
