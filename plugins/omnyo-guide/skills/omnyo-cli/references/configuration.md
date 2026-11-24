# Configuration and skill management

Omnyo's installer-owned `stateMigration` configuration binds one profile to a
durable write-admission journal outside its data trees. Launcher, CLI, server
and daemon startup refuse invalid admission. Do not remove this field or its
journal to force an old runtime to open migrated data. Recovery after admission
preserves current work through the migration owner; see `docs/configuration.md`.

## Environment Setup And Teardown Scripts

- To make a repo work with Omnyo worktrees, run `omnyo guide environments`. It
  documents the repo-level `.omnyo-env-setup.sh` and `.omnyo-env-teardown.sh` hooks,
  and the `.worktreeinclude` file.
- A new worktree checks out tracked files only. Commit a `.worktreeinclude`
  file at the repo root to list untracked files, such as `.env`, that Omnyo must
  copy from the source checkout. It uses gitignore pattern syntax. Omnyo copies
  the matches before it runs `.omnyo-env-setup.sh`.

- Hooks require ownership confirmed by successful provider creation. Attached
  checkout and personal-workspace paths skip both hooks. Server restart resumes
  the saved hook operation; cleanup waits for daemon-confirmed termination
  after a transport failure and retries while the daemon is unreachable.

- Missing default environment plugins cause creation to fail before a thread is
  inserted. Enable the plugin or explicitly select another environment.
- Host-dependent environment preflight requires a connected machine. Directory
  switching creates a core-owned attachment without claiming plugin provenance.

## App settings

- Read `references/app-settings.md` for every general key, experiment, default,
  and effect.
- Use `omnyo settings show` and `omnyo settings ai-services` for current values.
- Use `omnyo settings ai-services set <thread-title|commit-message|voice>
<automatic|off|service-id>` to choose which plugin AI service writes titles,
  commit messages, or voice transcripts, and `omnyo settings ai-services test
<thread-title|commit-message>` to try the current choice. Add
  `--plugin <plugin-id>` to `set` when two plugins register the same service
  id.
- Use `omnyo settings general <key> <value>` or
  `omnyo settings experiment <key> <value>` for updates.
- Use `omnyo settings keyboard list`, `set`, and `reset` for shortcut overrides.
- Use `omnyo settings usage [--machine <id-or-name>] [--refresh]` for provider limits. `--refresh` bypasses completed cached results; ordinary reads may reuse results for 10 seconds.
  `--host` is an alias for `--machine`.
- Use `omnyo settings version [--force]` for release information.
- Use `omnyo settings reload` to reload Omnyo-managed configuration.
- These commands support `--json`.

Omnyo accepts request hosts that are `localhost`, IP addresses (including LAN and
Tailscale IPs), or the hostname in `OMNYO_APP_URL`. For a custom DNS name or reverse
proxy, set `omnyo-app config set OMNYO_APP_URL https://omnyo.example.com` before
connecting, including from the CLI or SDK. A matching `Host` and `Origin`, or
`X-Forwarded-Host`, cannot authorize an unconfigured DNS name. A proxy can
preserve the configured host or forward to localhost. Omnyo Connect rewrites
requests to the local server address and needs no additional configuration.
`OMNYO_SERVER_BIND_HOST=0.0.0.0` remains supported for direct remote access.

To reach the same server under more DNS names, set `OMNYO_APP_ALIAS_URLS` to a
comma-separated list of https origins, for example
`omnyo-app config set OMNYO_APP_ALIAS_URLS https://app.example.com,https://omnyo.example.org`.
Each entry must be an absolute `https://` origin without a path, query,
credentials or wildcard. Aliases are accepted only as request hosts and browser
origins. `OMNYO_APP_URL` stays the canonical URL for generated links, and a
server move does not rewrite aliases. `omnyo-app config` applies the change live.

## Agent Instructions

- Add `AGENTS.md` to the Omnyo data dir (usually `~/.omnyo/AGENTS.md`) to inject
  user-level default instructions for every provider-backed thread across all
  projects.
- Add `.omnyo/AGENTS.md` at a workspace root to inject repo-specific instructions
  into every thread that runs there. Track the workspace file with git so fresh
  managed worktrees include it.
- Omnyo appends data-dir instructions first, then workspace instructions, to the
  thread system prompt for all providers when a provider session starts.
- Only the plural `AGENTS.md` is read, only from those exact locations (no
  parent-directory walk); an empty file is ignored. Run
  `omnyo guide agent-configuration` for details (it also covers project
  `.omnyo/skills/`).

## Skills

- Use `omnyo skill list` to inspect installed and discovered skills. It defaults to
  `OMNYO_PROJECT_ID`, then the personal project; pass `--project` or
  `--environment` to select another workspace.
- Copy the opaque ID from `omnyo skill list`, then use `omnyo skill show <skill-id>`
  or `omnyo skill files <skill-id>` to read that exact skill.
- `omnyo skill show <skill-id> --json` returns the revision. Pass that revision,
  plus `--file`, to `omnyo skill update <skill-id>`. Use update or delete only when
  the list says editable.
- Use `omnyo skill search [query]` for live skills.sh results. With no query it
  lists what is trending. The page defaults to zero, and the page size defaults
  to 24. The `ranking` field names the selected leaderboard. The `coverage`
  field identifies semantic, catalog-name, or leaderboard-name matches.
- In JSON, `installs` is the ranking-window count. `lifetimeInstalls` is the
  resolved lifetime count or `null`. Resolution covers at most 48 rows and can
  fail at any page size. Human output prints `—` for an unresolved lifetime
  count.
- Stage the exact registry ID with `omnyo skill registry stage <registry-skill-id>`.
  Read an included text file with
  `omnyo skill registry stage-file <registry-skill-id> <digest> <path>`.
  Install with `omnyo skill install <registry-skill-id> --digest <digest>` to add
  the reviewed tree to Omnyo’s skill library on the coordinator. Omit
  `--digest` to stage and install in one call. The command reports the installed
  digest.
- `omnyo skill install-cli-skills` copies Omnyo's built-in CLI skills into a machine's
  global agent skill roots (`~/.agents/skills` and `~/.claude/skills`) so agents
  outside Omnyo can drive Omnyo. It targets every connected machine unless you pass
  the repeatable `--machine <id-or-name>`, and reports each machine's outcome.
  Settings → Skills has the same action; it confirms first, and asks which
  machines only when more than one is enrolled.
- `omnyo skill cli-skills-status` reports per machine whether the installed copy is
  `installed`, `outdated`, `missing`, or `unknown` (disconnected or unreachable).

## Omnyo guide instructions and skills

Settings → Installed plugins → Omnyo guide controls the Omnyo introduction and the
three bundled skills. All settings default to true. Use
`omnyo plugin config omnyo-guide set <key> true|false` with `introduction`, `skills`
(the master skill switch), `omnyoCli`, `pluginAuthoring`, or `skillCreator`.
Disabling the plugin removes its introduction and skills. Changes apply when
agent configuration is next assembled; independently installed copies remain
available through their own sources.

## Omnyo source runtime preparation

In the Omnyo repository, add `--dryrun` to `pnpm start` or `pnpm start:worktree`
to run Turbo preparation, print resolved paths/ports and exit. The dry run uses
the same dotenv settings and runtime policy as normal startup. It does not start
services, migrate instance data or require ports to be free, but still writes
build outputs and may repair native modules. Install dependencies beforehand.
Preparation writes the checkout's build outputs; use a separate staging checkout
to warm Turbo while a live instance serves its existing files, then prepare the
stable serving checkout before launch. See `docs/debugging-and-qa.md` and
`omnyo guide environments`. These source-maintenance commands are separate from
installed `omnyo` commands and `.omnyo-env-setup.sh`.

## Held first start

Set `OMNYO_SERVER_STARTUP_HOLD` only in the launch environment. Its strict JSON
contains exactly `id`, `ownerId`, `expectedServerHostId` and absolute
`expectedDataDir`, matching the existing source host and data directory. The
server persists a durable `startup` hold before SQLite recovery or background
work. A matching restart is idempotent; later launches can omit the value and
retain the hold. A malformed, conflicting, mismatched or already released
request fails before database initialization. Do not persist this value with
`omnyo-app config` or `omnyo-app env`.

Read runtime ownership with `omnyo server maintenance status`. Use the finite
`omnyo server maintenance prepare` operations in the next section with all five
exact binding flags. Start a move with paired `--startup-hold-id ID` and
`--startup-owner-id OWNER`; failure or cancellation keeps the startup hold.
Only exact-owner `omnyo server maintenance release` resumes ordinary work.
`omnyo server maintenance repair-runtime` is a local offline recovery operation for a stopped, promoted migration in `releasing` phase. Its explicit hold digest and approved runtime digest bind a separate receipt; the historical hold remains unchanged. Stop the recognized service and verify closed ports before running it. Repair does not resume ordinary work.

## Server maintenance and direct access

- `omnyo server maintenance status` reports runtime identity, ownership and framework activity.
- `omnyo server maintenance acquire --id ID --owner-id OWNER --runtime-id RUNTIME --host-id HOST --data-dir PATH` acquires only against the exact idle owned runtime.
- `omnyo server maintenance release --id ID --owner-id OWNER --host-id HOST` releases only the exact durable owner.
- `omnyo server maintenance adopt-identity --request-file PATH --phase preflight|stage|rollback [--json]` invokes the bound verified runtime's stopped-state identity owner. It verifies every installed plugin's selected artifact before fencing or copying the existing profile. It refuses live writers; rollback refuses after first-write admission. It never stops a service, changes its owner or publishes an automatic offer.
- `omnyo server maintenance repair-runtime --id ID --owner-id OWNER --host-id HOST --data-dir PATH --hold-sha256 SHA --runtime-root ROOT --runtime-sha256 SHA [--json]` binds an approved complete package to a stopped, promoted migration in `releasing` phase. It preserves the historical hold and writes a separate protected repair receipt. Stop the recognized service and verify its ports are closed first; the command does not start or release it.
- `omnyo server maintenance prepare <operation>` requires `--id ID --owner-id OWNER --runtime-id RUNTIME --host-id HOST --data-dir PATH` and prints JSON. Maintenance commands accept `--json` for structured errors too. Operations are `quiesce`, `create-manual-target --name NAME`, `configure-direct-access --server-url URL`, `convert-to-direct --worker-id ID`, `enable-server-move`, and `rebind-plugin --plugin-id ID --root-path PATH`.
- `omnyo machine direct-access ID [--json]` proves a configured direct route, commits the same identity, and confirms a fresh primary before old-grant retirement. Conversion refuses busy workers and the authoritative server machine. An already direct protocol 236 worker can confirm its exact pending retirement while busy, without restarting. A pending receipt requires a fresh retry.

Preparation requires a durable `startup` hold and leaves work admission held.
Rebind accepts only the same installed direct-path plugin and preserves its
settings, enabled state, secrets and schedules without starting its factory.
The manual target keeps the existing one-use enrollment credential requirement;
its preparation remains admitted until connection and creation finish. Move,
release and further preparation are refused until that completion. Other enrollment and
ordinary mutations stay frozen. Move start while held
requires both `--startup-hold-id ID --startup-owner-id OWNER`. Move checks
exclude preparation/release; active preparation excludes move start. A failed
or cancelled move preserves the startup hold. Exact-owner release resumes work.

These commands grant no deployment, installation or server-move authority. Remote-client-only desktop updates never acquire a coordinator hold.

## Machine access and isolated data

Machine access `machineServerUrl` is the URL reachable by machines; unset uses
`OMNYO_EXTERNAL_URL`. `defaultMachineAccess` selects an access provider; unset
uses the first registered access provider, or direct when none are registered.
Inspect effective values
with `omnyo settings show --json` and change them with `omnyo settings general`.
`OMNYO_DATA_DIR` selects isolated enrollment state. Local machine lifecycle commands
treat it as an ownership assertion and refuse the default Omnyo installation; see
thread-creation.md and docs/configuration.md for the directory constraints.

The `omnyo` CLI appends every failed invocation to
`<data dir>/logs/cli-errors.jsonl` on the machine that ran it: command path,
error code, and the unknown command or flag, never argument values.
`omnyo diagnostics cli-errors [--since 7d] [--json]` tallies it; `--clear` deletes
it. `OMNYO_CLI_ERROR_LOG=0` turns recording off.

Machine enrollment v2 stores private `serverHeaders` in machine `config.json`.
The launcher transports these through `OMNYO_SERVER_HEADERS` (JSON string map) for
all server requests. Do not print these headers; they can contain access tokens.

## Secret vault

The server seals `auth-secret`, `machine-environment-key`, plugin secret
settings, plugin HTTP tokens and plugin secrets under a vault key for each data
directory. `OMNYO_VAULT_KEY_STORE` picks where that key lives when the server
creates the vault on its first start. `<data dir>/vault/vault.json` records the
choice, and the record decides from then on.

- `keychain` (macOS default) uses the login Keychain. A copied disk, backup or
  data folder cannot be decrypted without the user's login password. Automatic
  login weakens this through `/etc/kcpassword`.
- `dpapi` (Windows default) uses user scope for a signed-in user. An unattended
  boot task (S4U, batch or service logon) gets machine scope. Any process on
  that PC can decrypt a machine-scope key, and a copied whole disk unlocks it
  offline, so it protects only a copied data folder or a folder backup.
- `key-file` (other platforms, tests, `pnpm dev` and QA servers) keeps the key
  beside the ciphertext in `<data dir>/vault/`, so it protects against nothing.

No store protects against processes running as the same user, including agents
and plugins. If the vault cannot be opened, the server stops with an error
naming the data directory, key store and code, and never creates a new secret.
Exports and server moves decrypt sealed files into the archive and leave out
`vault/`.

## Machine environment

Use `--project <id>` on `omnyo machine env list|set|unset` for project overrides;
omit it for global settings. Project overrides follow the project across
machines and worktrees, including the primary host. Empty strings override;
unset restores inheritance. List masks all values and includes inherited global
rows for project scope. Set and unset update a single variable atomically.

Settings → Environment variables edits machine variables and has a scope
selector under its header. Project settings → Advanced settings opens the same editor for that
project. Changes apply
to the next agent turn and new terminals/commands. Project values are passed per
operation and never installed into the daemon's global environment. They override
global values; provider contributions retain precedence. All scopes share an
encrypted database table and the existing machine-environment encryption key.

Repository setup receives freshly resolved machine variables on each dispatch,
including recovery. Values are sent transiently to the setup process and are
not stored in provisioning requests. Existing attached paths skip setup.

Use `omnyo machine env list --json` for variables and built-in gh health.
`omnyo machine env set NAME [--note text] --json` reads the value from
stdin and removes one trailing newline; never pass secrets in argv. Runtime
output is forwarded as-is, so commands and providers can print contributed
values. `omnyo machine env unset NAME --json` removes an override. All values are
encrypted in the database and omitted from settings responses.

These settings apply globally to every connected machine, including the primary
host. The server synchronizes them into the daemon environment on connection and
settings changes, so background commands and new child processes inherit them.
Removing an override restores the original daemon value. User values override
built-ins; agent-provider entries override host values. Environment synchronization
does not restart cached provider runtimes; they retain their launch environment until
recreated. Reopen existing terminals after a change. The server gh login provides
GitHub Git/gh authentication and commit identity to non-primary hosts by default;
the primary host uses its local Git authentication. A user GH_TOKEN replaces it.
See Settings → Machines →
Machine environment, and `omnyo machine env list` for builtInGit readiness.

Plugin host calls start immediately using the current environment while any calls
are active in that plugin worker. Changed or removed machine variables take
effect on the next call after all active calls finish. Continuous overlapping
calls can keep the previous values until the worker becomes idle.

On macOS, right-panel tabs use `panel.previousTab` / `panel.nextTab` with
`Command+Control+ArrowLeft` / `Command+Control+ArrowRight`. They wrap through visible
tabs and each pane's New tab button in displayed order across the active
chat's right-panel groups. Press Enter or Space on New tab to open the picker.
On the selected New tab page, `panel.previousNewTabItem` /
`panel.nextNewTabItem` use `Command+Control+ArrowUp` / `Command+Control+ArrowDown` to
move through search, enabled actions, and recent items in displayed order.
Search results replace actions and recents while searching. Enter activates
the focused item.
`history.back` / `history.forward` (Go back / Go forward) do the same thing
as the sidebar's back and forward arrows, moving through the pages opened in
the current window like browser history: `Mod+[` / `Mod+]` on desktop and
the web. `thread.previous` / `thread.next`
(Command+ArrowUp / Command+ArrowDown on macOS, `Mod+Shift+[` / `Mod+Shift+]`
on other desktops, `Control+Shift+[` / `Control+Shift+]` on other web clients)
follow the visible chat sidebar order instead.
`edit.undo` / `edit.redo` (Undo / Redo) step back and forward through the
chat actions taken in the current window (Shelve, Unshelve, Archive, an
environment's Archive threads, Unarchive, Pin, Unpin, Mark read, Mark unread
and Rename): `Mod+Z` / `Mod+Shift+Z`, plus `Ctrl+Y` for Redo on
Windows/Linux. A toast's Undo button uses the same history. Text fields, the
terminal and the in-app browser keep their own undo, so the commands don't run
while one has focus or a dialog is open.
`rail.jump.1` through `rail.jump.9` switch the left project rail in displayed order:
Inbox first, then visible projects, including Personal. Hidden projects are skipped
unless their selected tile is temporarily shown. Desktop uses `Mod+1…9`; the web
uses `Control+1…9` on macOS and `Ctrl+Shift+1…9` on Windows/Linux.
The `thread.jump.1…9` and `pane.focus.1…8` commands start unassigned and remain
available in Settings → Keyboard, the CLI and SDK.
The initially unassigned `thread.unreadAbove` / `thread.unreadBelow` commands
scroll to the outermost unread chat above or below the sidebar viewport without
opening it or marking it read. Native green arrows run the same actions and
stay fixed at the sidebar edges independently of sidebar highlight plugins.
Chat splits use `pane.focus.left` / `right` / `up` / `down` with
`Command+Control+Shift+ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` on macOS. These move
spatially to the adjacent chat pane, including stacked splits, and stop at the
layout edge. The initially unassigned `pane.focus.previous` / `pane.focus.next`
commands still cycle in reading order. On Windows/Linux, these arrow navigation
commands start unassigned to preserve native Control-arrow editing shortcuts.
Rebind any of these commands in Settings → Keyboard, via
`omnyo settings keyboard set <command> <shortcut|disabled>`, or SDK
`system.updateKeyboardSettings`; read bindings with `system.config`.
Use `omnyo settings keyboard reset <command>` to adopt the current default.
Overrides can specify `platform: "mac"`, `"windows"`, or `"linux"`; omission applies
on all platforms. A platform-specific override takes precedence over a general one,
including when disabled. UI edits and clears apply only to the current platform;
UI resets remove overrides for the current platform so web and desktop each use
their own defaults. Shared overrides become explicit bindings on the other platforms
to preserve their behavior. Explicit overrides remain resettable even when they match
a default shortcut.
CLI `set` and `reset` accept `--platform mac|windows|linux`; scoped operations retain
other platforms. Unscoped `set` updates the general override; unscoped `reset`
clears all scopes for the selected command (or every command if omitted).

Plugin commands use `plugin:<plugin-id>/<command-id>` as their stable binding
ID. For example: `omnyo settings keyboard set plugin:example/open-issue Mod+Shift+I`.
`omnyo settings keyboard reset plugin:example/open-issue` restores the plugin's
default; `set ... disabled` explicitly unbinds it. The SDK supports the same IDs
through `system.updateKeyboardSettings` and `system.config`.
Overrides survive plugin disable/re-enable and reload. Every active plugin
command appears in Keyboard Settings; commands without defaults start unbound.
Conflicting plugin defaults stay unbound and display the conflicting command.
The UI offers Replace binding or Cancel when assigning an occupied shortcut.
`keyboard list` includes all saved overrides and core effective bindings;
plugin defaults and availability are resolved in each app window, where the
plugin frontend runs. CLI/SDK callers should clear conflicting explicit
bindings in the same update; plugin defaults yield to explicit bindings.

### Opt-in server performance diagnostics

Start with `pnpm start --perf-diagnostics`, `pnpm start:worktree --perf-diagnostics`,
or `omnyo-app --perf-diagnostics` to permit detailed performance logs and rolling
CPU profiles when the experiment is on. `OMNYO_PERF_DIAGNOSTICS=1` is the equivalent startup environment
setting (off by default; restart required). Server logs include five-second
CPU/GC/loop/memory summaries and lower slow-operation thresholds. Profiles
are saved every 30 seconds under `$OMNYO_DATA_DIR/logs/performance/`, in ten
rotating slots of at most 12 MiB each. Copy a relevant `.cpuprofile` promptly
and open it in Chrome DevTools' JavaScript profiler. This adds overhead;
remove the setting and restart to disable. No inspector network port is
opened. Profile files contain local paths/function names; inspect before sharing.

Diagnostics require **both** startup permission (`--perf-diagnostics` or
`OMNYO_PERF_DIAGNOSTICS=1`) and the `performanceDiagnostics` experiment. The
experiment defaults to off. Use
`omnyo settings experiment performanceDiagnostics true` to enable it, or `false`
to stop it; SDK clients use the existing experiments update endpoint. The
experiment takes effect live on that server. Without startup permission it
cannot start collection. Turning it off restores normal logging thresholds,
stops the sampler and flushes the in-flight profile; existing files remain.
The launch flag only grants permission and still requires a restart to change.

## Private desktop updates

Private macOS builds read schema1 `private-updates.json` beneath Electron
userData. Missing/disabled/invalid configuration never chooses a fallback feed.
Only a matching channel and non-secret HTTPS directory URL are accepted; no
PATs, headers, URL userinfo/query/hash or GitHub release URLs. Configure access
only during an authorized activation. Settings → Updates uses the desktop
bridge; `omnyo updates app` targets the server separately. Remote-only desktop
updates never stop or hold that server. A staged desktop handoff remains held
until the exact compatible replacement boot releases its owner.
