---
kind: instruction
title: Omnyo Guide — Customization
summary: Command reference for customizing the Omnyo app color palette, typography, keyboard shortcuts, and mobile push notifications.
intent: Explain the CLI theme surface, server-backed app customization, and push-notification device registration.
editingNotes: Keep flags accurate against the CLI implementation. Theme details live in the omnyo-cli skill's references/theming.md.
---
Customization commands

Theming — the app-wide palette and typography

`omnyo theme` controls a set of CSS-variable overrides for the app palette and
typography, persisted server-side and applied live to every open window.
Light/dark mode is a separate per-client setting the theme layers on top of.
Custom themes live on
disk, one folder per theme, at <omnyo-data-dir>/theme/<name>/theme.css (the packaged
app uses ~/.omnyo/theme/…). The folder name is the theme id.

  omnyo theme list                  Built-in and custom themes; shows the active one
  omnyo theme dir                   Print the custom-theme directory (where to author)
  omnyo theme set <id> [--favicon-color <color>]
                                 Activate a theme, preserving the favicon color
                                 unless the flag supplies the complete selection
  omnyo theme show [id] [--css]     Print the active palette, or resolve <id> without
                                 activating it; --css dumps the CSS
  omnyo theme reset                 Back to the default theme; preserve favicon color
  omnyo theme favicon set <color>   Set favicon color; preserve the active theme
  omnyo theme favicon reset         Reset favicon color; preserve the active theme

To author a custom theme, run `omnyo theme dir`, write <that-dir>/<name>/theme.css,
then `omnyo theme set <name>`. Optional `pierre-dark.json` / `pierre-light.json`
(or a `theme.json` `codeTheme` field) ship the matching code colors. Built-in
palettes use the matching Shiki pair. The full design-token reference is in
the omnyo-cli skill (references/theming.md).

Theme CSS can override typography as well as colors. `--font-terminal` controls
the integrated terminal's font family independently of `--font-mono`; set it in
the theme's `:root, .light` block and end the stack with a generic fallback.

Favicon colors are `default`, `red`, `orange`, `yellow`, `green`, `teal`,
`blue`, `purple`, and `pink`. Theme and favicon-only commands carry the other
appearance value forward explicitly.

Hovering a palette in Settings → Appearance previews it live in that window
without saving; `omnyo theme show <id>` is the CLI counterpart.

Add --json to any theme command for machine-readable output.

Packaged launcher settings

`omnyo-app config` and `omnyo-app env` reload runtime settings in a running server,
but the CLI identifies server and launcher settings that are startup-only,
including binding/ports, data and the dev-app port, telemetry, error reporting
(`OMNYO_SENTRY_DSN`), inherited skill
roots, and `OMNYO_FF_*` flags. `OMNYO_LOG_LEVEL` is also startup-only. Use
`omnyo-app config`, not `omnyo-app env`, to change `OMNYO_APP_URL` live. After a
startup-only change, run `omnyo-app stop && omnyo-app start` or restart the desktop
app. Until then, changing or unsetting `OMNYO_SERVER_BIND_HOST` does not close a
previous `0.0.0.0` listener.

`OMNYO_SERVER_STARTUP_HOLD` is launch-only strict JSON with `id`, `ownerId`,
`expectedServerHostId` and absolute `expectedDataDir`. It persists a startup
hold before recovery or background work. Do not save it with `omnyo-app config`
or `omnyo-app env`. Use `omnyo guide machines` for exact-owner preparation, move and
release commands.

With `--server-bind-host 0.0.0.0`, the startup listener and `app` rows show
`http://0.0.0.0:<port>`. Health checks and the colocated daemon still connect
through loopback; this does not narrow the IPv4 wildcard listener. Containers
must also publish the port to the host.

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

Thread titles, commit messages, and voice transcripts come from AI services
that plugins register, chosen per task with `omnyo settings ai-services` (see
Server-backed General settings below). The older inference and transcription
keys were removed: Omnyo ignores them in `~/.omnyo/config.json` with a warning,
and `omnyo-app config set` refuses them.

Server-backed General settings

New-chat approval defaults live in Settings → Providers. Set the global mode
with `omnyo settings general defaultPermissionMode accept-edits`. Set per-model
overrides with `omnyo settings general modelPermissionModes
'{"codex":{"gpt-5":"auto"}}'`. The map replaces all overrides; `{}` restores
global inheritance. Modes are `accept-edits`, `auto`, and `full`, subject to
provider support. Existing chats retain their recorded mode. Explicit choices,
managed-parent policy, and saved project choices precede these defaults.
The SDK uses `sdk.system.updateGeneralSettings` with the same fields.

Settings → General includes app-wide preferences stored server-side so every
window and restart sees the same value. Keep Awake is instead owned by its
builtin plugin: use its autosaving page under Settings → Installed plugins or run
`omnyo keep-awake enable` or `omnyo keep-awake disable`. Choose every host with `omnyo
keep-awake hosts all`, or name individual host ids after `omnyo keep-awake hosts`.
On macOS it prevents system idle sleep while Omnyo is running; closing the lid or
choosing Sleep still sleeps the Mac.

Concurrency limit is also owned by its builtin plugin. Its autosaving page
under Settings → Installed plugins leaves the overall limit unlimited by default and
uses an automatic per-host limit of one thread per available processor. Use
`omnyo concurrency-limit global [unlimited|<limit>]` and `omnyo
concurrency-limit host <host-id> [auto|<limit>]`; 0 pauses new work.

The sidebar thread list is owned by the Thread list builtin plugin. Its
layout preferences (active/archived filter, organization mode, sort, section order, hidden and
collapsed groups) live in the plugin and sync to every window:
`omnyo thread-list prefs list [--json]`, `prefs get <key>`,
`prefs set <key> <value>`, and `prefs reset <key>`. `set` takes JSON; a bare
word is a string. On first load the plugin copies non-default `sidebar.*`
values from `omnyo settings ui` once. `showProviderIcons` defaults to `true`;
Organize → Rows → Provider icons toggles the icon before each title, and
`omnyo thread-list prefs set showProviderIcons false` turns it off from the CLI.
`groupByReadStatus` defaults to `false`; Organize → Groups → By read status or
`omnyo thread-list prefs set groupByReadStatus true` lists unread threads above
read ones, keeping the selected sort within each group.
The `threadLifecycles` preference defaults
to `["active"]`; `omnyo thread-list prefs set threadLifecycles '["archived"]'`
shows archived threads, and `'["active","archived"]'` shows both.

A vertical rail of destinations sits on the left edge of the sidebar on every
screen size. Home is at the top and returns to the last thread; the visible
destinations (Plugins, Skills, and plugin panels) follow; More holds hidden
destinations and Customize rail; Settings is at the bottom. Customize rail
makes the destination icons wiggle: drag them (or press Alt+Up/Down) to reorder,
and switch destinations on or off in the popover beside them. New thread sits in
the sidebar header and cannot be hidden. The list beside the rail swaps between the thread list,
Plugins, Skills, and Settings, and collapsing the sidebar hides that list and
leaves the rail. Rail order and visibility are `omnyo settings ui` keys
(`sidebar.pluginPanelOrder`, `sidebar.visiblePluginPanels`). In the macOS
desktop app, wide windows add a title bar holding the window controls, Back
and Forward, and the sidebar toggle; it shares the rail's background, and the
sidebar and page sit in a card below it. On narrow windows and phones the rail
sits inside the drawer: Home, Plugins, Skills, and Settings swap the list
beside it and leave the drawer open, and a plugin page closes it.

Settings → Keyboard also includes `showKeyboardHints`, which defaults to true.
Turn it off to hide the delayed shortcut badges shown while holding Command or
Control on macOS, or Control on Windows/Linux. Shortcut commands continue to
work.

Settings → General includes `showDiagnosticEvents`, which defaults to false
in all builds. Turn it on to show provider environment resolution and unhandled
provider events. Warnings, errors, and model fallback stay visible. Existing
unhandled-event preferences are preserved. Set it with
`omnyo settings general showDiagnosticEvents <true|false>`.

Settings → General → Show Git status controls the Git control in the thread
header: branch, changed files, pull-request status and actions, and Commit.
The bundled Git plugin draws it; disabling the plugin also hides it.
`showGitChanges` defaults to true; use
`omnyo settings general showGitChanges false` to hide them, or true to restore them.
The server saves this preference across reloads and shares it across connected
clients. Thread relationships and workspace warnings remain visible. SDK callers can update
`showGitChanges` through `sdk.system.updateGeneralSettings` with the current settings.

Settings → General → Show messages from before a context clear controls whether a
cleared thread still shows its earlier messages above the `Context cleared`
boundary. `keepHistoryAfterContextClear` defaults to false; use
`omnyo settings general keepHistoryAfterContextClear true` to keep them in the
timeline, outline, and message lookups. The next prompt still starts a fresh
provider conversation.

Settings → General also includes `steerActiveThreadOnEnter`, which defaults to
true for a new install. An earlier install with saved settings or work keeps
false. Outside an open typeahead menu, enabling it makes Enter steer a running
thread and Command+Enter queue a follow-up; when disabled, those actions are
reversed. Shift+Enter inserts a newline. On coarse-pointer touch devices, the
software-keyboard Return path inserts a newline. iPadOS WebKit preserves these
Enter shortcuts for a connected Magic Keyboard.

Settings → General includes `confirmThreadArchive`, which defaults to true.
Set `omnyo settings general confirmThreadArchive false` to archive parent and
child threads without the confirmation popup. The toast still offers Undo.
The setting applies to all connected app clients; CLI and SDK archive calls
remain non-interactive.

Settings → General also includes `streamerMode`, which defaults to false. Turn
it on to hide every `customModels` entry from `~/.omnyo/config.json` in all model
lists (pickers, `omnyo provider models`, and the SDK) during a screen share. The
entries stay in the config file.

Settings → Providers → Fast mode has a switch for each provider that supports
tiers. `providerAllowFastServiceTier` stores provider-ID boolean
overrides. For Codex only, set the fallback off and enable Codex:

```sh
omnyo settings general allowFastServiceTier false
omnyo settings general providerAllowFastServiceTier '{"codex":true}'
```

The JSON map replaces all overrides; include any entries you want to retain.
The SDK uses `api.sdk.system.updateGeneralSettings` with the same field.
Providers without an override inherit `allowFastServiceTier` (default true),
which preserves existing settings. Disallowed providers use the default tier
for every new turn, including explicit selections, queued messages and automations.
Their models show no ⚡ in the composer. Completed turns keep their recorded tier.

Settings → General includes `managedBranchPrefix`, which defaults to
`omnyo/`. Omnyo puts it in front of every branch name it creates for a worktree, so
the default gives `omnyo/fix-login-flow-thr_ab12cd34ef`. Set `sawyer/wt-` to get
`sawyer/wt-fix-login-flow-thr_ab12cd34ef`, or clear it for no prefix. Omnyo rejects
a prefix that cannot start a valid git branch name. The new prefix applies to
branches Omnyo creates after the change.

  omnyo settings show
  omnyo settings ai-services
  omnyo settings ai-services set <thread-title|commit-message|voice> <automatic|off|service-id> [--plugin <plugin-id>]
  omnyo settings ai-services test <thread-title|commit-message>
  omnyo settings general <key> <value>
  omnyo settings replay-onboarding
  omnyo settings completed-turns [provider-id] [collapse|flat|default]
  omnyo settings experiment <key> <value>
  omnyo settings usage [--machine <id-or-name>] [--refresh]
  omnyo settings version [--force]
  omnyo settings reload

Use `--refresh` to fetch fresh provider usage; ordinary reads may reuse results
for 10 seconds. The SDK equivalent is `api.sdk.system.usageLimits({ refresh: true })`.

`omnyo settings ai-services` shows which AI service writes thread titles (and so
branch names), commit messages, and voice transcripts, plus every service a
plugin registers and whether it is ready. `set` picks `automatic` (every compatible
service by plugin id and service id in lexicographic order, including
third-party plugins), `off`, or one service id; a picked
service is never swapped for another. A service is identified by its plugin
and its id, so two plugins may use the same id; pass `--plugin <plugin-id>`
when they do. `test` runs a sample title or commit message through the current
choice. Voice plugins such as Dictation by Paraspeech keep their own settings.
Each plugin chooses its own model.

`omnyo settings general autoUpdateProviderClisOnStartup false` disables automatic
updates of installed provider CLIs before chats resume on startup or a worker
restart, including after an Omnyo update. It defaults to true. Update now still
pauses chats, updates the CLI and resumes chats after confirmed completion.

`omnyo settings general` accepts any key from `generalSettings` in
`omnyo settings show`. Boolean preferences take `true`, `false`, `on`, or `off`,
and `null` clears a preference that can be unset.

`omnyo settings replay-onboarding` clears `onboardingCompletedAt`, so the first-run
setup guide (connect an agent, add projects, import recent Codex and Claude Code chats,
pick plugins, set up devices) shows
again in every open client. Settings → General → Setup guide has the same
button.

`omnyo settings completed-turns` lists how each provider shows a finished turn:
`collapse` folds the turn's work into one activity row, such as "Worked 3m · 2
commands", and keeps the final answer visible, and `flat` keeps every step
visible. Each provider has a default (Claude Code is `flat`, the other first-party providers `collapse`).
`omnyo settings completed-turns <provider-id> <collapse|flat>` overrides it for
that provider, and `default` removes the override. Settings → Providers has
the same per-provider switch.

Message editing is available for eligible, accepted
root user messages in Codex, Claude Code, and Pi threads, including failed or
incomplete turns. Opening the editor is
client-local; submitting stops and settles a running thread, then replaces the
selected turn and all later conversation history while retaining workspace side
effects. Grouped multi-message requests are not yet editable.

Omnyo releases restorable provider sessions after 10 idle minutes. The daemon
checks for these sessions every minute. Active turns, commands, agents,
workflows, and monitors keep their sessions loaded.

The default-off `serverMove` experiment enables Move server here in Settings →
Machines and the server-backed `omnyo server move` and `omnyo server export`
commands. Enable it with `omnyo settings experiment serverMove true`.

The default-on `compactExpiredCache` general setting offers to compact an idle
thread whose prompt cache has expired once its context holds at least 100k
tokens; see `omnyo guide thread-messaging` for `--compact-first`. Turn it off in
Settings → General or with `omnyo settings general compactExpiredCache false`.

The default-on `autoCompactBeforeCacheExpiry` experiment compacts an idle
Claude Code chat once, 50 to 55 minutes after its last request, while its
one-hour prompt cache is still warm. It applies to visible root chats the owner
started and last messaged, whose work is open, external or needs-you and whose
context holds at least 200k tokens. The compaction runs silently: no unread
mark, Inbox receipt or push, and readiness is unchanged. Turn it off with
`omnyo settings experiment autoCompactBeforeCacheExpiry false`. Opt one chat out
with `omnyo thread auto-compaction <id> --off` or Keep full history on the
composer chip; `omnyo thread context` reports the outcome.

Long timelines and large expanded timeline details mount only nearby rows.

Thread timeline pages select complete conversation groups using
`OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET` (default 1500) as a selection budget.
Oversized groups paginate their contents with stable summary identities.
Grouping can load more than the budget to preserve lifecycle and delegation
context; it is not a hard CPU or memory cap. Older activity loads on scroll.
A walk keeps its initial history snapshot. Edits invalidate it, and a new live
snapshot can require loading older pages again.

Server-backed keyboard shortcuts

Settings → Keyboard records per-command shortcut overrides. They are persisted
server-side, applied live to every connected window, and survive restarts.
Reset removes an override and returns to Omnyo's current default; Clear explicitly
disables a command. `Mod` means Command on macOS and Control on Windows/Linux.
Bindings for non-native actions apply in browser and desktop clients. Command
contexts and native-only availability remain server-owned, and desktop menu
accelerators for New Thread, New Window, New Tab, Close, and Settings use the
same resolved bindings. The complete default table is in docs/configuration.md.

  omnyo settings keyboard list
  omnyo settings keyboard hints <true|false>
  omnyo settings keyboard set <command> <shortcut|disabled> [--platform mac|windows|linux]
  omnyo settings keyboard reset [command] [--platform mac|windows|linux]

On macOS, right-panel tabs use `panel.previousTab` / `panel.nextTab` with
`Command+Control+ArrowLeft` / `Command+Control+ArrowRight`. They wrap through visible
tabs and each pane's New tab button in displayed order across the active
chat's right-panel groups. Press Enter or Space on New tab to open the picker.
On the selected New tab page, `panel.previousNewTabItem` /
`panel.nextNewTabItem` use `Command+Control+ArrowUp` / `Command+Control+ArrowDown` to
move through search, enabled actions, and recent items in displayed order.
Search results replace actions and recents while searching. Enter activates
the focused item.
The initially unassigned `panel.fullScreen.toggle` command runs the right
panel's Full Screen / Exit Full Screen control while the panel is open. In a
split right panel it maximizes the focused group.
`history.back` / `history.forward` (Go back / Go forward) do the same thing
as the sidebar's back and forward arrows, moving through the pages opened in
the current window like browser history: `Mod+[` / `Mod+]` on desktop and
the web. `thread.previous` / `thread.next`
(Command+ArrowUp / Command+ArrowDown on macOS, `Mod+Shift+[` / `Mod+Shift+]`
on other desktops, `Control+Shift+[` / `Control+Shift+]` on other web clients)
follow the visible chat sidebar order instead.
`edit.undo` / `edit.redo` (Undo / Redo) step back and forward through one
history of the actions taken in the current window: chat actions (Shelve,
Unshelve, Archive, an environment's Archive threads, Unarchive, Pin, Unpin,
Mark read, Mark unread and Rename) and plugin actions recorded with
`experimental_useActionHistory`, such as Canvas moves and edits. The shortcuts
are `Mod+Z` / `Mod+Shift+Z`, plus `Cmd+Y` on macOS and `Ctrl+Y` elsewhere for
Redo. A toast's Undo button uses the same history. Text you type stays in its
field's own undo: while a field has focus, the shortcuts undo the typing until
you take another app action. The terminal, the in-app browser and open dialogs
keep their own undo.
`rail.jump.1` through `rail.jump.9` switch the left project rail in displayed order:
Inbox first, then visible projects, including Personal. Hidden projects are skipped
unless their selected tile is temporarily shown. Desktop uses `Mod+1…9`; the web
uses `Control+1…9` on macOS and `Ctrl+Shift+1…9` on Windows/Linux.
The `thread.jump.1…9` and `pane.focus.1…8` commands start unassigned and remain
available in Settings → Keyboard, the CLI and SDK.
The initially unassigned `thread.unreadAbove` / `thread.unreadBelow` commands
scroll to the outermost unread chat above or below the sidebar viewport without
opening it or marking it read. The native green arrows run the same actions;
they remain fixed at the sidebar edges and disappear when no unread chats lie
beyond that edge. They work independently of sidebar highlight plugins.
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

Push notifications

For a standalone development APK from a source checkout, run
`pnpm mobile:apk:dev`. It writes `apps/mobile/build-output/omnyo-dev.apk`, named
**Omnyo dev** with orange icons and separate package `app.getbb.mobile.dev`.
Append `-- x86_64` for an Intel emulator. The command sets
`OMNYO_MOBILE_VARIANT=dev`; direct Expo commands default to `production`.
The dev variant skips production Firebase and HTTPS app-link registration.
See `apps/mobile/README.md` for prerequisites and per-thread artifact delivery.

Android source builds accept `GOOGLE_SERVICES_JSON` (path to Firebase Android
configuration), with `apps/mobile/google-services.json` as a local fallback.
It is optional for building the app, required for Android push delivery.
See `apps/mobile/README.md` for EAS file variables, signing, and Play uploads.

The built-in Push notifications plugin sends mobile updates through Expo and
system notifications to web and desktop clients. Web delivery needs an open tab
and browser permission, requested in the plugin settings. Desktop delivery needs
the app running; Mac windows can be closed. Closing the last window still quits
the app on Windows and Linux.

  omnyo push-notifications list
  omnyo push-notifications add --token <expo-push-token>
      --platform <ios|android> --label <device-name>
  omnyo push-notifications remove <id>
  omnyo push-notifications status
  omnyo push-notifications test <web|desktop>
  omnyo push-notifications thread <thread> [--level inherit|all|input-only|muted]
  omnyo plugin config push-notifications set <mobileEnabled|mobileOnlyWhenAway|webEnabled|desktopEnabled> <true|false>
  omnyo plugin config push-notifications set defaultLevel <all|input-only|muted>
  omnyo plugin config push-notifications set childLevel <inherit|all|input-only|muted>

`add` is an upsert by token: a known token refreshes its label and last-seen
time and keeps its id. Expo tokens that are no longer registered are removed
automatically after a failed delivery. Use `omnyo plugin disable
push-notifications` to stop delivery. Change the relay URL with `omnyo plugin
config push-notifications set expoPushUrl <url>`. Add `--json` to `list` or
`status` for machine-readable output. The list returns token suffixes only.
The three channel switches default to true and apply immediately across this
server. `test` queues a notice for the selected client type with permission;
OS notification settings still control whether a banner appears.
`thread` prints a thread's resolved notification level and its source; with
`--level` it sets the thread's own level. A thread uses its own level, else
`childLevel` if it has a parent (default `input-only`; `inherit` follows
`defaultLevel`), else `defaultLevel` (default `all`). A thread's level also
limits its child threads: every ancestor's own level caps the result. `all` notifies on finished turns too, `input-only` keeps
questions, approvals, and errors only, and `muted` sends nothing.

Host files and voice transcription

  omnyo file read|write|list|paths|mkdir|move|remove ...
  omnyo voice prepare [--json]
  omnyo voice transcribe <audio-file> [--prompt <context>]
  omnyo voice diagnostic <report.json> [--json]

Voice transcription uses the Voice input service chosen with
`omnyo settings ai-services set voice <automatic|off|service-id>`. Omnyo accepts
recordings up to 25 MB, and each service may set a lower limit; Codex takes up
to 20 MB. These limits apply to the app, SDK, and CLI. If transcription fails
in the app, the error toast offers a download of the original recording until
dismissed.

`omnyo voice prepare` asks the selected voice service to get ready, for example
by loading a local model, so the next dictation starts quickly. It returns at
once; the app does the same when you start recording, and Omnyo also does it
when the Mac running the server connects. Services with nothing to prepare
ignore it.

Voice failures automatically send content-free diagnostic codes and capture state
to this private coordinator's rotating server log as `Voice input diagnostic`.
Recording IDs join attempts and server failures; successful retries add a recovery
report. Reports contain the failure time and loaded web bundle identity, never
audio, transcripts, prompts, microphone labels, or raw error messages. Up to twenty
unsent reports stay on this client for at most twenty-four hours and retry when
connectivity returns or the app resumes. `omnyo voice diagnostic` submits the same
strict report format through `sdk.system.experimental_recordVoiceDiagnostic`.

`omnyo file` supports `--host` for remote machines and `--root` on mutating
commands to confine access beneath an absolute directory. `omnyo file list` and
`omnyo file paths` include dot-prefixed entries; pass `--no-hidden` to skip them.
Both skip a default set of dependency and cache directories such as
`node_modules`, `.venv`, `.pnpm-store`, and root-relative `.claude/worktrees`;
`--exclude <names...>` replaces that set. Entries match basenames at any depth
or exact root-relative paths using `/` separators. Use
`--json` for metadata and machine-readable results.

`omnyo file list PATH --icons` uses bounded project-icon discovery instead of a
recursive file listing, matching `sdk.files.list({ path: PATH, discovery: "icons" })`.
It queries matching tracked filenames in Git repositories and searches visible
directories breadth-first outside repositories. Hidden paths are excluded.
The result reports `truncated` when a directory, depth, entry or result limit
is reached. Use this mode for sidebar icons rather than fuzzy file queries.

`omnyo file remove --recursive` and `sdk.files.remove({ recursive: true, ... })`
stop processes whose working directories are inside the directory before
deleting it, including processes in nested checkouts. This uses the same
SIGTERM grace period and SIGKILL fallback as worktree removal on macOS and
Linux; Windows does not enumerate process working directories.

Server-backed sidebar preferences

Sidebar layout lives on the server in a keyed, revisioned registry so every
window, device, and the CLI share it: organization mode, chronological sort,
section orders, collapsed rows and sections, navigation entry order and
visibility, hidden thread-list groups, and the navigation and thread-list
provider pickers. The same registry stores which thread Info panel sections
are collapsed (`infoPanel.collapsedSections`). The sidebar waits for them alongside the project list, and
an upgrade uploads the old browser-stored layout once.

  omnyo settings ui list [--json]
  omnyo settings ui get <key> [--json]
  omnyo settings ui set <key> <value> [--json]
  omnyo settings ui reset <key> [--json]

The sidebar thread list defaults to `__automatic__`: the first installed thread list
plugin other than the bundled Thread list plugin (`thread-list/thread-list`), or the
bundled plugin when there is none. Installing a thread list plugin therefore switches
to it. Legacy `__builtin__` selections resolve to the bundled plugin; other plugin
selections are preserved.
Use `omnyo settings ui reset sidebar.threadListProvider` to restore Automatic, or
`omnyo settings ui set sidebar.threadListProvider <plugin-id>/<slot-id>` to select
another plugin. The SDK exposes the same setting through `uiPreferences`.

`omnyo settings ui list` prints every key with its value, revision, and a short
description. `set` takes plain strings for enum and provider keys and JSON for
lists, objects, numbers, and `null`; it reads the current revision, writes with
it, and retries once on a conflict. `reset` writes the default. The SDK offers
`sdk.system.uiPreferences.list()`, `.set()`, and `.reset()`.

New installations default to Custom (`chronological`) for `sidebar.organizationMode`.
Migrated installations with existing projects, threads, or UI preferences fall back
to By project (`project`). Explicit server choices take precedence over legacy
browser choices, which take precedence over this installation fallback. Reset
saves the installation fallback as an explicit choice.

The built-in sidebar's Filter selects Active and Archived, defaulting to Active.
The selection is browser-local, not a server-backed preference or SDK/CLI setting.
Active includes threads with saved messages; there is no separate
Drafts section or filter. Archived threads use their preserved placement and a
restore action. Archived pages load only while selected.
Plugin sidebar replacements own their filters.

The palette's Filter uses Active and Archived independently of the
sidebar, defaulting to Active. Its selection is browser-local, not configurable
through SDK/CLI. Active includes threads with saved messages; Search threads retains
the existing title and conversation search behavior. Archived fetches bounded recent rows only when
selected.

Every thread-list header's actions menu offers New project, New section,
Organize, Sort by, and Filter. Organize selects By project,
By machine, or Custom and retains Groups → By environment.
The separate `sidebar.threadGrouping.environment` preference
decides whether sibling threads sharing one worktree collapse into a single row.
It defaults to `auto`, which groups them
everywhere except Custom: `omnyo settings ui set sidebar.threadGrouping.environment
false` keeps every thread on its own row, and `true` groups them in every mode.
Sort by selects a field, and selecting it again reverses its arrow/direction.
`sidebar.sortDirection` accepts `ascending`, `descending`, or `default`.
The default preserves each field's original order (newest first for dates,
A–Z for titles). For example: `omnyo settings ui set sidebar.sortDirection ascending`.

Thread-list visibility

Threads, a project, custom section, or machine's menu offers Hide from list;
its menu inside More offers Add to list. Customize list manages visibility and
order for the current organization. Hiding preserves the group's threads, order,
and collapse state. Pinned threads remain in Pinned; More carries hidden activity.

The Thread list plugin's `hiddenGroups` preference defaults to `[]`. Its keys
are `threads`, `project:<projectId>`, `section:<sectionId>`, and
`machine:<hostId>` (`machine:no-machine` for the unassigned group). Each
organization uses its own keys, while `threads` applies to every organization.
Pinned cannot be hidden. Duplicate keys are deduplicated, and unavailable IDs
remain saved without producing rows. New groups default visible.

  omnyo thread-list prefs get hiddenGroups
  omnyo thread-list prefs set hiddenGroups '["threads","project:proj_example","section:sec_example"]'
  omnyo thread-list prefs reset hiddenGroups

`set` replaces the entire list across organizations; include existing keys you
want to keep hidden. `reset` shows all groups. The plugin's `setPreference` and
`resetPreference` RPCs expose the same operations to its app client.

Sidebar footer actions

Settings → Appearance → Sidebar footer supports drag ordering and visibility.
Right-click an action and choose Hide to move it into the More menu. Hidden
shortcuts remain actionable; hiding an open disclosure closes it. The More menu
appears only when hidden actions are available and links back to customization.
`sidebar.footerOrder` and `sidebar.hiddenFooterItems` are string lists. Keys are
`builtin:mobile`, `builtin:report-bug`, or `plugin:<encoded pluginId>/<encoded registrationId>`.
Preferences survive plugin reloads and temporarily unavailable plugins; new items
are visible by default. On the desktop app footer the settings gear holds this
menu, and built-in actions stay there until added with Customize footer, which
records a `pinned:<key>` entry in `sidebar.hiddenFooterItems`. Example:

  omnyo settings ui set sidebar.hiddenFooterItems '["plugin:omnyo--provider-usage/usage"]'
  omnyo settings ui reset sidebar.hiddenFooterItems

Model picker favorites and hidden models

The same registry stores the model picker's favorites and hidden models. The
picker's star adds or removes the current provider, model, reasoning, and
service-tier selection; Edit hides models and stars or removes favorites.
Settings → Providers → Favorite models shows favorites as the picker groups
them: one row per model in provider order, every level a star that adds or
removes it, drag to reorder a model within its provider, and Add favorite for
the picker's choice. It also turns Show favorites in the composer on or off.
Settings → Providers → Hidden models shows hidden models again.

- `modelPicker.favorites` — up to 24 `{ providerId, model, reasoningLevel,
  serviceTier }` objects in order. An omitted `serviceTier` is stored as
  `"default"`, duplicates keep the first entry, and unknown fields are rejected.
- `modelPicker.hiddenModels` — an object of provider id to hidden model ids.
  Hidden models fold under that provider's "N more" row; search still finds
  them, and provider defaults and saved selections do not change.
- `modelPicker.footerFavorites` — `true` (default) shows favorites as the
  desktop composer's one-click model switcher; `false` keeps only the model
  button. A number saved by an earlier version reads as `true`.

  omnyo settings ui set modelPicker.favorites '[{"providerId":"codex","model":"gpt-6.1-sol","reasoningLevel":"xhigh","serviceTier":"fast"}]'
  omnyo settings ui set modelPicker.hiddenModels '{"codex":["gpt-5.6-sol"]}'
  omnyo settings ui set modelPicker.footerFavorites false
  omnyo settings ui get modelPicker.favorites
  omnyo settings ui reset modelPicker.hiddenModels

SDK: `sdk.system.uiPreferences.set({ key: "modelPicker.favorites", value,
expectedRevision })`, using the revision from `sdk.system.uiPreferences.list()`.

Client-local UI preferences

Open microphone preferences by right-clicking the composer microphone, pressing
Shift+F10 while it is focused, or clicking the Microphone control in Settings →
Voice Input. A warning opens preferences when the microphone is clicked. Desktop uses an anchored popover; mobile uses a drawer. Opening
preferences starts a local microphone preview with the recording waveform and
a list of inputs. Closing preferences releases the preview. The recording controls
contain only cancel, stop, and send; microphone preferences are available while idle.

Recording tries the preferred device, then the system default, then other
available inputs for missing or unreadable devices. Permission denials do not
trigger fallback. A disconnect during recording switches the input into the
same recorder, preserving audio captured before the disconnect. Reconnecting
the preferred microphone makes it available for the next recording; it does not
interrupt the current fallback recording.

A missing preferred microphone alone does not block recording or show a warning.
Capture failures, interrupted input, or no available inputs after access was
granted show a decorative warning badge on the idle microphone. During capture,
five seconds of near-silent audio produces a warning in the open preview or an
accessible status in the recording row; the recording row has no microphone menu. Silence warnings clear when audio returns and never
stop recording or switch microphones automatically. While idle, a warning opens
preferences on click. Audio preview runs only while microphone preferences are
open; it is not saved or transcribed.

Some Settings values live only in the current browser/client. Sidebar width
and open state stay local because they depend on the window size, and each tab
or desktop window keeps its own: collapsing or resizing the sidebar in one tab
leaves the others alone, and a newly opened tab starts from the most recent
choice made anywhere in that browser. The Voice Input
microphone picker stores the selected browser MediaDevices device id in
localStorage as `omnyo.voiceInput.audioInputDeviceId`; it does not have a `omnyo`
command and does not change the server-side transcription model. When the preferred
microphone is disconnected, recording tries the system default and then other available inputs. The saved preference is used again when it
reconnects. Select System default to follow system microphone changes.

Coordinator usage has separate installation-wide weekly-count and per-client product analytics choices. Settings → General shows both effective states. `omnyo settings usage status --json`, `count on|off`, `analytics on|off`, `preview --json` and `erase` use the same owner. An explicit product grant creates a random client capability; other clients and automation have no grant. The legacy `telemetryEnabled=false` switch and `OMNYO_TELEMETRY=false` veto both purposes; legacy true never grants analytics.

`OMNYO_USAGE_COLLECTOR_URL` explicitly selects a first-party origin; there is no built-in usage destination. `OMNYO_USAGE_COUNT_REGION=US` enables a count default only after the installation notice is acknowledged. Unknown and other regions ask first. The weekly report has an empty body and no identifier, and the coordinator attempts it at most once per newer UTC week after an accepted human action. Product reports use day precision, a scoped random subject, fixed event/property enums and bounded cumulative counts. Withdrawal cancels pending sends; explicit erasure uses the saved client proof. Raw product records expire after 30 days. See `docs/usage-privacy.md` for exact fields, meaningful limits and the difference between local implementation and deployed privacy evidence.

Production coordinator servers and host daemons send error reports, separate
from usage telemetry, to Alex's Omnyo project in Sentry after the reporting choice is known:
process-ending uncaught exceptions, and unhandled server request errors. Reports
carry the runtime version, service, platform, architecture and fixed technical
error categories. A final allowlist preserves owned source locations and bounded
diagnostic context, discarding arbitrary messages, private paths, user and IP
fields, request data, breadcrumbs and environment variables.
`OMNYO_SENTRY_DSN` replaces the project DSN, and an empty value in the
environment that starts the coordinator or daemon disables error reporting.
Restart with `omnyo-app stop && omnyo-app start` after changing it.

The web app sends crash reports to the same project while the server exposes a
DSN. Reports identify the loaded web artifact and preserve only validated technical
context and owned source locations. Turn off web, coordinator and host daemon
reports in Settings → General → Privacy & diagnostics → Crash reports, with
`omnyo settings general crashReportsEnabled false`, or through SDK
`system.updateGeneralSettings` with `crashReportsEnabled`. The server-wide
preference persists across restarts. The coordinator keeps remote reporting off
until its persisted choice is available. Host daemons keep it off until their
current authenticated connection receives fresh policy, and turn it off when
they disconnect or move to another coordinator. Startup failures before that
choice is known remain local. Older daemons must update before connecting.
Turning reporting off retires queued voice diagnostics without removing local
recordings or disabling transcription, Retry or Download.

Report a bug in the sidebar footer, `omnyo bug report "what went wrong"
[--email ADDRESS]`, or SDK `system.experimental_reportBug({ message, email? })`
sends a bug report to the same Sentry project as user feedback, linked to the
running release. It sends only what you write, the optional email and, from the
app, the last web error it reported; never chats, logs or screenshots. It needs
Crash reports on and a server with a Sentry DSN, and says so when either is
missing.


Pair a phone through Settings → Mobile (`/settings/mobile`) → **Add mobile device**.

Storage & retention is enabled by default. If disabled, enable it
with `omnyo plugin enable omnyo--storage-retention`.
Its sidebar panel and `omnyo storage` commands own retention policies and machine
cleanup. Open **Worktrees & Branches** there for saved Git status, diffs, and
reviewed cleanup. The CLI has `omnyo storage worktrees status`,
`omnyo storage worktrees rescan`, and `omnyo storage worktrees clean SCAN_ID --yes`. Thread retention settings in the panel save immediately. Enable **Delete thread storage on archive** with
`omnyo storage retention --delete-storage-on-archive true --save --yes` (default:
false). An hourly check starts cleanup at most once every 24 hours for future
archives at least 3 hours old, once stopped and online, keeping history
and uploaded attachments and skipping pinned threads. Pending cleanup survives
reloads. Younger archives and failures wait for a later daily run; unarchiving cancels it.
Separately, `omnyo storage retention --delete-dev-data-on-checkout-removal true --save --yes`
(default: false) scans online persistent machines hourly and removes `~/.omnyo-dev`
folders with missing checkouts after successful scans, including manual scans
and existing data. It rechecks absence, stops servers in removed checkouts,
keeps unidentified sources, and retries failures on later scans.
Use `omnyo storage clear-archived-files --machine HOST_ID --yes` to clear
all stored files from archived, stopped, unpinned threads on that machine.
`omnyo storage usage --machine HOST_ID` also reports worktree counts by project
and, after a scan, a separate `~/.omnyo-dev` breakdown when that folder exists,
including recovered source paths, checkout existence, and links to known threads.
`omnyo storage remove-dev-instances --machine HOST_ID --yes` removes development
instances whose checkout no longer exists, stopping servers still running from it;
add `--instance NAME` to remove one entry of any kind, stopping its dev server
first if it is running.
Managed cleanup is separate from thread retention. The native `ManagedScratch`
tool allocates fresh empty scratch with a stable request key and an explicit
`disposable-when-owner-ends` or `keep-until-released` disposition. Existing paths
cannot be adopted. The panel and CLI cannot create native owner grants.
Restore and changed data revoke the old permission. A fresh native release or
a genuinely new authoritative owner end is required before cleanup can resume.
An idle declared consumer keeps its hold until it releases natively or ends.
Pinned and shelved chats remain protected. After a reload, an unprovable grant
needs a fresh native release. Changed or newly recovered quarantine receives a
new seven-day window; unchanged scans preserve the date.
`omnyo storage managed list` reads status; `inspect --machine HOST_ID --id ALLOCATION_ID`
returns the current revision and snapshot digest. `review`, `restore`, and `purge`
use those exact fields with `--revision`, `--snapshot-digest`, and `--yes`.
`purge-preview --items JSON_ITEMS` and `purge-batch --items JSON_ITEMS --preview-digest PREVIEW_DIGEST --yes`
bind a batch to 1 to 100 exact allocation references. These confirmations use
ordinary account authority and do not attest human presence.

`omnyo storage managed-policy` shows policy. It defaults to review, automatic
expiry off, and a 10 GiB quarantine budget. `--mode review|owner-approved`,
`--automatic-expiry true|false`, and `--budget-bytes BYTES` preview changes.
Repeat the same fields with `--expected-revision POLICY_REVISION --preview-digest PREVIEW_DIGEST --save --yes`
to save. Permanent removal has a fixed seven-day quarantine minimum, including
explicit purge with expiry off. Every off-to-on expiry transition starts a fresh
seven-day minimum after the later of quarantine and enablement. Restore never
overwrites the original path. A full budget holds new cleanup. Windows supports
allocation and owner decisions, with a visible hold for unavailable directory-entry
power-loss durability. Physical cleanup remains held there because complete
process inspection is unsupported.
Quarantine and removal counts are logical bytes, not measured SSD space reclaimed.
Hourly managed reconciliation never wakes a model or reopens an owner chat.
See the plugin's storage-retention skill for commands and limitations.

Housekeeping is owned by Storage & retention. `omnyo storage housekeeping status`
reports durable runs and stage holds; `preview --machine HOST_ID` inspects work,
and `run --machine HOST_ID --yes` starts background maintenance. Known process-private
temporary outputs have native ownership and closeout. An optional pinned local
Mac policy requires explicit adapter preview and adoption; new installations
have no external roots. Existing deletion settings and ManagedScratch review
and expiry remain unchanged. The owning storage-retention skill documents the
typed RPC, CLI registration inputs, budgets and recovery behavior.

ManagedScratch allocation also declares a role, finite byte budget, free-space
reserve and immutable restore-input references. A native budget extension checks
space and revokes prior removal approval. Release records success, failure or
cancellation and the keeper paths and removal conditions. Unknown legacy
declarations and exceeded budgets keep files protected; admission is not an OS
quota. Housekeeping adapter preview accepts `--docker-kasten-policy PATH` for the
separate approved Kasten cache profile. Exact protected owner proposals for
unregistered engines, Cua placement and inventory findings appear in the same
panel and CLI status. No proposal authorizes guest-disk or user-data removal.

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

Without either setting, the server records no CPU profile. Every event-loop
stall of at least 500 ms still logs "Event loop stalled" with the work in
flight and the longest synchronous task in that window. Omnyo does not start
the profiler on its own after a stall: starting it pauses the server while V8
records every compiled function, and on a long-running coordinator that pause
reached 16 seconds, longer than the stalls it was meant to explain. Turn on the
diagnostics experiment above to profile.

Storage cleanup can run in the background with `omnyo storage cleanup --machine HOST_ID --kind orphans|development|worktrees --yes`. Inspect `maintenance` with `omnyo storage usage`; failures release the machine lock and can be retried. Archived storage cleanup waits through the archive undo grace and rechecks eligibility before each batch.

## Default machine for new chats

`defaultThreadMachineId` selects an existing persistent machine for new chats
across clients. Set it with `omnyo settings general defaultThreadMachineId HOST_ID`,
through the SDK's general settings, or Settings → Machines → Default machine for
new chats. `null` restores Automatic. Explicit per-chat machines, reused
environments and inherited child environments take precedence. The configured
default overrides remembered browser choices. An unavailable default reports an
error; it does not silently move work to another machine.
If the project has no checkout on that machine, the composer keeps the machine
and Project checkout selected and requires project setup before sending.

## Usage privacy

`omnyo settings usage status --json` shows separate weekly-count and client analytics choices, effective restrictions and erasure status. `count on|off` changes the installation-wide count. `analytics on|off` explicitly changes this CLI client's consent; only interactive use contributes. `preview --json` shows safe synthetic fields without collecting an event. `erase` withdraws and asks the configured first-party collector to erase this client's subjects; retry if the result is pending. Keep local proofs until erasure completes. `OMNYO_TELEMETRY=false` disables both purposes before startup. See `docs/usage-privacy.md` for scope, regional notice and retention limits.
