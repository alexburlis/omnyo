# Omnyo app settings reference

Server-backed preferences in Settings. They are persisted on the server, so
every window and client sees the same value.

## Setting values

- `omnyo settings general <key> <value>` accepts any key listed under
  `generalSettings` in `omnyo settings show`. Boolean preferences take `true`,
  `false`, `on`, or `off`; `null` clears a preference that can be unset.
- Unknown keys and values of the wrong shape are rejected; the error names the
  keys Omnyo knows.

## Setup guide

- A new Omnyo install opens a first-run setup guide: connect an agent, add
  projects, import recent Codex and Claude Code chats, pick plugins, and set up
  devices. Every step can be skipped. The chats step appears only while the Chat
  import plugin is enabled.
- `onboardingCompletedAt` is the ISO timestamp of when the guide was finished
  or skipped; `null` means the guide is showing.
- `omnyo settings replay-onboarding` clears it. Settings → General → Setup guide
  has the same button.
- `omnyo project discover [--machine <id-or-name>]` lists the git repositories the
  guide offers to import; add one with `omnyo project create --name <name> --root <path>`.

## Sidebar preferences

The sidebar thread list defaults to `__automatic__`: the first installed thread list
plugin other than the bundled Thread list plugin (`thread-list/thread-list`), or the
bundled plugin when there is none. Installing a thread list plugin therefore switches
to it. Legacy `__builtin__` selections resolve to the bundled plugin; other plugin
selections are preserved.
Use `omnyo settings ui reset sidebar.threadListProvider` to restore Automatic, or
`omnyo settings ui set sidebar.threadListProvider <plugin-id>/<slot-id>` to select
another plugin. The SDK exposes the same setting through `uiPreferences`.

`sidebar.pluginPanelOrder` and `sidebar.visiblePluginPanels` order and show or
hide the navigation rail's destinations (see Navigation rail below).

- The server keeps a keyed, revisioned registry of sidebar layout preferences
  (`sidebar.organizationMode`, `sidebar.threadGrouping.environment`,
  `sidebar.chronologicalSort`, the section
  orders, the collapsed-id lists, `sidebar.hiddenGroups`,
  `sidebar.pluginPanelOrder`, `sidebar.visiblePluginPanels`,
  `sidebar.threadListProvider`).
- The same registry stores `infoPanel.collapsedSections`, the thread Info panel
  sections collapsed from their headings (`commits`, `uncommittedChanges`,
  `childThreads`, `forks`, `threadStorage`). Read or change it with
  `omnyo settings ui get` and `omnyo settings ui set`.
- The built-in sidebar's Filter selects Active and Archived, defaulting to Active,
  including threads with saved messages. This selection is browser-local, not
  a server-backed preference or SDK/CLI setting. Selected archived rows
  retain their hierarchy placement and offer a restore action. Archived pages load only while selected;
  plugin sidebar replacements keep ownership of their rendering.
- The palette's Filter selects Active and Archived independently of the
  sidebar, defaulting to Active. This selection is browser-local, not configurable
  through SDK/CLI. Active includes threads with saved messages; Search threads
  retains existing title and conversation matching. Archived recents load only while selected and are
  bounded at the server.
- `sidebar.organizationMode` defaults to Custom (`chronological`) on new installs.
  Migrated installs with existing projects, threads, or UI preferences fall back to
  By project (`project`). Saved server choices win over legacy browser choices,
  which win over the installation fallback. Reset saves that fallback explicitly.
- `sidebar.threadGrouping.environment` decides whether sibling threads sharing
  one worktree environment collapse into a single worktree row inside their
  section: `true` groups them and `false` keeps every thread on its own row, in
  every organization mode. The default `auto` groups them in By project and By
  machine and leaves them flat in Custom. Set it through Organize → Groups →
  By environment, settings, or the CLI. Each `sidebar.threadGrouping.*` key
  toggles one grouping dimension independently.
- `omnyo settings ui list [--json]` prints every key with its value, revision,
  and description; `omnyo settings ui get <key> [--json]` prints one.
- `omnyo settings ui set <key> <value> [--json]` takes a plain string for enum
  and provider keys and JSON for lists, objects, numbers, or `null`; it reads
  the current revision, writes with it, and retries once on a conflict.
- `omnyo settings ui reset <key> [--json]` writes the default and advances the
  revision.

### Thread-list visibility

- The bundled Thread list plugin owns its layout preferences, including hidden
  groups. Use `omnyo thread-list prefs list [--json]` to inspect them and
  `omnyo thread-list prefs get/set/reset <key>` to change them.
- Its installed `thread-list` skill documents accepted keys and values. Keep
  plugin-specific settings out of `omnyo settings ui`; those legacy values are
  read only during one-time migration.

## Model picker favorites and hidden models

The same registry stores the composer model picker's favorites and hidden
models. Settings → Providers → Favorite models and Hidden models edit them too.

- `modelPicker.favorites` holds up to 24
  `{ providerId, model, reasoningLevel, serviceTier }` objects in order. An
  omitted `serviceTier` is stored as `"default"`, duplicates keep the first
  entry, and unknown fields are rejected. The picker shows unavailable
  favorites dimmed with a reason and never swaps in another model.
- `modelPicker.hiddenModels` maps a provider id to the model ids folded under
  that provider's "N more" row. Search still finds them; hiding never changes
  provider defaults or saved selections.
- `modelPicker.footerFavorites` is `true` (default) to show favorites as the
  desktop composer's one-click model switcher, or `false` to keep only the model
  button. A number saved by an earlier version reads as `true`.

```bash
omnyo settings ui get modelPicker.favorites
omnyo settings ui set modelPicker.favorites '[{"providerId":"codex","model":"gpt-6.1-sol","reasoningLevel":"xhigh","serviceTier":"fast"}]'
omnyo settings ui set modelPicker.hiddenModels '{"codex":["gpt-5.6-sol"]}'
omnyo settings ui set modelPicker.footerFavorites false
omnyo settings ui reset modelPicker.hiddenModels
```

SDK callers use `sdk.system.uiPreferences.set({ key: "modelPicker.favorites",
value, expectedRevision })` with the revision from
`sdk.system.uiPreferences.list()`.

## Git controls

- Settings → General → Show Git status defaults to on.
- `omnyo settings general showGitChanges false` hides the Git control in the
  thread header: branch, changed files, pull-request status and actions, and
  Commit. The bundled Git plugin draws it; disabling the plugin also hides it.
- Set it to `true` to restore them across every thread and connected client.
  The server saves the choice across reloads.
- Thread relationships and workspace warnings remain visible.
- SDK callers use `sdk.system.updateGeneralSettings` with the current settings
  and `showGitChanges`. Older clients that omit it preserve the saved choice.

## Cleared context history

- Settings → General → Show messages from before a context clear defaults to off.
- `omnyo settings general keepHistoryAfterContextClear true` keeps messages from
  before the latest `Context cleared` boundary in the timeline, conversation
  outline, and `omnyo thread log --message` lookups. The next prompt still starts a
  fresh provider conversation, and the context meter still resets.
- SDK callers use `sdk.system.updateGeneralSettings` with the current settings
  and `keepHistoryAfterContextClear`. Older clients that omit it preserve the
  saved choice.

## Compact before resuming expired sessions

- Settings → General → Offer to compact before resuming expired sessions
  defaults to on.
- When an idle thread holds at least 100k tokens and its prompt cache has
  expired, the composer offers to compact before the next message. It works
  with providers that support manual compaction.
- `omnyo settings general compactExpiredCache false` turns the offer off.
- SDK callers use `sdk.system.updateGeneralSettings` with the current settings
  and `compactExpiredCache`. Older clients that omit it preserve the saved
  choice.
- No offer appears while the thread's latest request is a compaction that is
  running or completed; a failed or stopped compaction keeps the offer.

## Compact before the prompt cache expires

- The `autoCompactBeforeCacheExpiry` experiment defaults to true. Turn it off
  with `omnyo settings experiment autoCompactBeforeCacheExpiry false`.
- When it is on, Omnyo compacts an idle Claude Code chat once, 50 to 55 minutes
  after its last request, while the one-hour prompt cache is still warm.
- It applies only to visible root chats the owner started and last messaged,
  with work labelled open, external or needs-you, a context of at least 200k
  tokens, and an account that is not in overage or on credits.
- The compaction is a silent maintenance turn: no unread mark, Inbox receipt or
  push, and the chat keeps its readiness, Tidy decision and composer
  suggestion.
- `omnyo thread auto-compaction <id> --off` opts one chat out; `--on` opts it
  back in. The composer chip's Keep full history does the same, and SDK
  callers use `threads.experimental_setAutoCompaction({ threadId, enabled })`.
- `omnyo thread context <id> --json` reports `autoCompaction` with `state`
  (`scheduled`, `skipped`, `disabled`, `done`, `failed` or `stopped`), `at`,
  `reason` and, when done, `cacheReadShare`.

## Keyboard shortcuts

- `showKeyboardHints` defaults to true. Set it with
  `omnyo settings keyboard hints <true|false|on|off>` to control whether
  delayed shortcut badges appear while holding Command or Control. It does not
  disable the shortcuts themselves.
- Settings → Keyboard records sparse per-command chord overrides. `Mod` means
  Command on macOS and Control on Windows/Linux.
- Reset removes the override and follows Omnyo's current default. Clear stores an
  explicit disabled value.
- Bindings for non-native actions apply in browser and desktop clients. Command
  contexts and native-only availability remain server-owned. Reusing a chord
  can be intentional when contexts do not overlap; the UI identifies reuse.
- New Thread, New Window, New Tab, Close, and Settings in the desktop menu use
  the same resolved shortcuts as renderer commands.
- The complete default table is in `docs/configuration.md` in the Omnyo source
  repository.

## Diagnostic events

- `showDiagnosticEvents` defaults to false in all builds. Set it with
  `omnyo settings general showDiagnosticEvents <true|false|on|off>`.
- Enables provider environment resolution and unhandled provider events in the
  timeline. Warnings, errors, and model fallback stay visible regardless.
- Existing unhandled-provider-events preferences carry over to this setting.

## Active-thread Enter behavior

- `steerActiveThreadOnEnter` defaults to true for a new install. An earlier
  install with saved settings or work keeps false. Set it with
  `omnyo settings general steerActiveThreadOnEnter <true|false|on|off>`.
- Outside an open composer typeahead menu, disabling it makes Enter queue a
  follow-up and Command+Enter steer the active turn. When enabled, those
  actions are reversed.
- Shift+Enter inserts a newline. On coarse-pointer touch devices, the
  software-keyboard Return path stays a newline; iPadOS WebKit preserves the
  Enter shortcuts for a connected Magic Keyboard.

## Archive confirmation

- `confirmThreadArchive` defaults to true. Set it with
  `omnyo settings general confirmThreadArchive <true|false|on|off>`.
- Turn it off to archive a parent and child threads without the confirmation
  popup. Undo remains available in the archive toast. This server-wide setting
  applies to all connected app clients. CLI and SDK archive calls remain
  non-interactive.

## Streamer mode

- `streamerMode` defaults to false. Set it with
  `omnyo settings general streamerMode <true|false|on|off>`.
- When enabled, every `customModels` entry from `~/.omnyo/config.json` is hidden
  in all model lists: the pickers, `omnyo provider models`, and
  `sdk.providers.models`. Use it during a screen share so a private or
  early-access model id does not appear.
- The entries stay in `config.json`. A thread request that names a hidden model
  explicitly still runs with it, and default model resolution for a new thread
  keeps the full list.
- A composer whose stored selection is a hidden model falls back to the
  provider default, and the next send records that default. Select the custom
  model again after you turn streamer mode off.

## Fast service tier

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

## New branch prefix

- `managedBranchPrefix` defaults to `omnyo/`. Set it with
  `omnyo settings general managedBranchPrefix <prefix>`.
- Omnyo puts the prefix in front of every branch name it creates for a managed
  worktree or a new checkout branch, so the default gives
  `omnyo/fix-login-flow-thr_ab12cd34ef`.
- A prefix does not need a trailing slash. `sawyer/wt-` gives
  `sawyer/wt-fix-login-flow-thr_ab12cd34ef`, and an empty prefix gives
  `fix-login-flow-thr_ab12cd34ef`.
- Omnyo rejects a prefix that cannot start a valid git branch name, such as one
  with a space or a leading `-`. The maximum length is 64 characters.
- The new prefix applies to branches Omnyo creates after the change. It does not
  rename an existing branch or worktree.

## Provider order and default

- `providerOrder` defaults to `[]`. Set it to a JSON array of provider IDs.
- `defaultProviderId` defaults to `null`. Set a provider ID or use `null` to
  clear it.

## Approval defaults for new chats

Settings → Providers includes a global approval default and per-model overrides.
`defaultPermissionMode` defaults to `auto`. `modelPermissionModes` maps a provider
ID to model IDs and their approval modes. Removing a model entry restores the
global default. Existing chats keep their recorded approval mode. Explicit chat
choices, a managed parent's policy, and saved project choices take precedence.

```sh
omnyo settings general defaultPermissionMode accept-edits
omnyo settings general modelPermissionModes '{"codex":{"gpt-5":"auto"}}'
```

The model map replaces all overrides, so include entries you want to retain.
The SDK uses `sdk.system.updateGeneralSettings` with the same fields. Valid modes
are `accept-edits` for workspace access with user review, `auto` for workspace
access with automatic review, and `full` for full access without review. Providers
may support only some modes. Unsupported choices fail rather than expand access.

## Finished turns

- When a turn finishes, Omnyo can collapse its work into one activity row, such
  as `Worked 3m · 2 commands`, and leave the final answer visible
  (`collapse`), or keep every step visible (`flat`). Each provider declares a default: Claude Code is `flat`; every
  other first-party provider is `collapse`.
- `omnyo settings completed-turns [--json]` lists every provider with its current
  display and whether it comes from your setting or the provider default.
- `omnyo settings completed-turns <provider-id> <collapse|flat|default>` sets the
  display for one provider; `default` removes your setting so the provider
  default applies again. Settings → Providers has the same switch per
  provider.
- The overrides are stored in `providerCompletedTurnDisplay`, a map of provider
  ID to `collapse` or `flat`. The setting applies to every thread of that
  provider, including finished turns in existing threads, the conversation
  outline, and `omnyo thread log`.

## Message edits

- Eligible accepted root user messages can be edited without enabling an
  experiment. Use `omnyo thread edit-message` or the message editor in the app.

## Provider session release

- Omnyo releases restorable provider sessions after 10 idle minutes and checks
  for them every minute.
- Active turns, commands, agents, workflows, and monitors keep sessions loaded.

## Mobile app

- Downloads are available in Settings → Mobile without opting in.
- Pair your phone under Settings → Mobile → **Add mobile device**.

## Navigation rail

- A vertical rail of destinations sits on the left edge of the sidebar on
  every screen size. Home is at the top and returns to the last thread; the
  visible destinations (Plugins, Skills, and plugin panels) follow; More holds
  hidden destinations and Customize rail; Settings is at the bottom.
- New thread sits in the sidebar header and cannot be hidden. The list beside
  the rail swaps between the thread list, Plugins, Skills, and Settings.
- Collapsing the sidebar hides the list beside the rail and leaves the rail in
  place.
- `sidebar.pluginPanelOrder` and `sidebar.visiblePluginPanels` order and show
  or hide rail destinations.
- In the macOS desktop app, wide windows add a title bar that holds the window
  controls, Back and Forward, and the sidebar toggle. It shares the rail's
  background, and the sidebar and page sit in a card below it.
- On narrow windows and phones the rail sits inside the drawer. Home, Plugins,
  Skills, and Settings swap the list beside it and leave the drawer open; a
  plugin page closes it.

## Timeline windowing

- Long timelines keep stable row wrappers while mounting only rows near the
  active main or nested detail scrollport.
- iPhone and iPad browsers, including the iOS app, keep every loaded row
  mounted instead. Safari there cannot correct the scroll position during a
  touch scroll's momentum, so rows measured above the viewport would move
  the text being read.

## Server move

- The `serverMove` experiment defaults to false.
- Enable it with `omnyo settings experiment serverMove true`.
- It shows Move server here in Settings → Machines and lets the server run
  `omnyo server move`, `omnyo server export`, and old server copy deletion.

Machine access: `omnyo settings general machineServerUrl https://omnyo.example.com`
sets the server URL reachable by machines. Set `null` to use OMNYO_EXTERNAL_URL.
`omnyo settings general defaultMachineAccess direct` selects direct access;
`connect` selects Omnyo Cloud; `null` selects the first registered access provider,
or direct when none is registered. An unpaired provider remains selected and
reports setup required. `omnyo settings show --json` includes serverAccess with the
effective direct URL, its source and provider availability. Availability is refreshed
on each read, with failed or timed-out checks reported as unavailable. It does
not acquire a machine grant. These grants carry runtime
requests, including account-pool traffic, after enrolment.

Automatic machine GitHub credentials are enabled by default. Use
`omnyo settings general machineGitCredentialsEnabled false` to stop forwarding the
server gh credentials to machines; `true` enables them again. In Machines →
Advanced settings, the automatic GH_TOKEN switch controls the same setting.
This does not log the server out or suppress an explicit custom GH_TOKEN.
Changes apply to new turns, setup commands and terminals.

Sidebar footer actions use `sidebar.footerOrder` and `sidebar.hiddenFooterItems`.
Both are string lists shared across clients. Keys are `builtin:mobile`,
`builtin:report-bug`, or `plugin:<encoded pluginId>/<encoded registrationId>`.
The footer shows as many icons as fit the sidebar's width. More is always
available and holds hidden actions plus actions that don't fit; apart from
Customize's minus, width overflow never changes saved visibility. More →
Customize footer replaces the footer row with Footer and More menu zones: minus
removes an icon and keeps current overflow hidden so its slot stays empty, plus
adds a More item while the footer has room, and drag reorders within a zone. More → Hide footer
hides every action, and Show footer shows them again.
Right-click an action for Hide from footer or Customize footer.
On the desktop app footer the settings gear holds the More menu. Built-in
actions stay in the gear menu until Customize footer adds them, which records
a `pinned:<key>` entry in `sidebar.hiddenFooterItems`.
Settings → Appearance → Sidebar footer edits the same preferences. CLI example:
`omnyo settings ui set sidebar.hiddenFooterItems '["plugin:omnyo--provider-usage/usage"]'`.
Use `omnyo settings ui reset sidebar.hiddenFooterItems` to restore the default footer.

Disable anonymous usage telemetry with `omnyo settings general telemetryEnabled false`
or Settings → General → Privacy & diagnostics → Share anonymous usage data. This server-wide preference
applies immediately and persists across restarts. `OMNYO_TELEMETRY=false` overrides it.

Turn off web app, coordinator and machine (host daemon) crash reports with `omnyo settings general crashReportsEnabled false`
or Settings → General → Privacy & diagnostics → Crash reports. This server-wide
preference persists across restarts. The coordinator keeps remote reporting off
until it reads that choice. A host daemon keeps reporting off until the current
authenticated connection receives fresh policy; disconnecting or moving to a
new coordinator turns it off again. Startup failures before the choice is known
remain local. Older daemons must update before connecting. Turning reporting off
also retires queued voice diagnostics without removing local recordings or
disabling transcription, Retry or Download.

Send a bug report with `omnyo bug report "what went wrong" [--email ADDRESS]` or
the footer's Report a bug. Both need Crash reports on and a server with a Sentry
DSN; otherwise the command fails with `bug_reports_unavailable`.

Pair a phone through Settings → Mobile (`/settings/mobile`) → **Add mobile device**.

Right-clicking the composer microphone, pressing Shift+F10, or clicking the
Microphone control in Settings → Voice Input opens client-local voice preferences: a desktop popover or mobile drawer. Opening it
starts a local waveform preview; select an input directly from the list. Closing
the picker stops the preview. The recording row has no microphone menu.
Missing or unreadable inputs fall back automatically; a missing preference alone
is informational. Sustained silence warns without switching devices or stopping
capture. Device selection remains browser-local; server voice-service settings
and file transcription commands are unchanged.

## Default machine for new chats

`defaultThreadMachineId` selects an existing persistent machine for new chats
across clients. Set it with `omnyo settings general defaultThreadMachineId HOST_ID`,
through the SDK's general settings, or Settings → Machines → Default machine for
new chats. `null` restores Automatic. Explicit per-chat machines, reused
environments and inherited child environments take precedence. The configured
default overrides remembered browser choices. An unavailable default reports an
error; it does not silently move work to another machine.
