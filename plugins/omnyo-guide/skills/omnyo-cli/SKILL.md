---
name: omnyo-cli
description: "Inspect or manage Omnyo state with the Omnyo CLI; use for Omnyo commands and configuration."
---

# Omnyo CLI

Use omnyo for Omnyo state and actions. Inspect context when the target project, host,
workspace, or execution selection is not already established.

## Start with context

```sh
omnyo status --json
```

Use JSON when command output controls later work. Use human output for quick
inspection.

Run `omnyo --version` for the CLI version. Use `omnyo --help` or `omnyo help [command]`
for help. Run omnyo guide for the system overview. Run omnyo guide <chapter> for one
area. Use omnyo <group> --help for current flags and defaults, or
`omnyo guide commands <group>` for every command in a group with its options on
one page.

## Errors and JSON

- Read the whole error before you run `--help`. A failed invocation prints the
  nearest command or option, the usage line, the valid options, and, for a
  missing project, thread, machine, or environment, the exact flag to add with
  the current ID filled in.
- With `--json`, a failure prints
  `{"ok": false, "error": {"code", "message", "hint"}}` on stdout and the
  readable message on stderr, and exits non-zero. Parse stdout only; `2>&1`
  mixes the message into the JSON.
- Output shapes differ by command: `omnyo thread list --json` is a bare array,
  `omnyo thread show --json` nests under `.thread`, `omnyo terminal list --json`
  wraps in `.sessions`. `omnyo guide json` lists each shape, and the help of the
  most-parsed commands ends with its JSON shape.
- Pass long or multi-line text from a file: `omnyo thread tell <id>
--message-file <path>`, `omnyo thread spawn --prompt-file <path>`, with `-` for
  stdin. Inside double quotes the shell runs `backticks` and `$(...)` before
  Omnyo sees the text, which silently corrupts Markdown and can execute commands.
- Timeouts take seconds or a duration with a unit (`90s`, `20m`, `4h`).
- Examples here use POSIX shell syntax. On a Windows machine the agent shell
  is usually PowerShell: read an environment variable as `$env:NAME`
  (`"$env:OMNYO_THREAD_ID"`), separate commands with `;` instead of `&&`, and
  continue a line with a backtick instead of a backslash.

A standalone CLI uses the saved `serverUrl` in `OMNYO_DATA_DIR/config.json` or
`~/.omnyo/config.json`; without a saved selection it targets http://127.0.0.1:38886.
`OMNYO_SERVER_URL` overrides that selection. Explicit repository development defaults
also take precedence over saved config. Invalid overrides or saved config fail
visibly. `OMNYO_HOST_DAEMON_PORT` retains its separate override and defaults.

## Read only the relevant reference

- Read references/command-index.md to find the exact core command path. Use
  live help for current flags and defaults.
- Read references/thread-command-index.md for thread commands and subcommands.
- Read references/configuration.md for settings, agent instructions, skills,
  remote clients, server maintenance, and environment setup scripts.
- Read references/thread-creation.md before you spawn or fork threads, create
  projects, select machines, move the server, or create environments.
- Read references/thread-operation.md before you end a turn on a wait, and
  for `omnyo wait`, the Inbox, messages, queues, interactions, panes, terminals,
  inspection, and long-running commands.
- Read references/failure-recovery.md when a thread fails, stops, or needs plan
  or goal recovery.
- Read references/theme-commands.md for palette and favicon commands. Read
  references/theming.md before you create or edit theme CSS.
- Read references/plugins.md for plugin discovery, install, build, update,
  configuration, runtime, and contributed commands.
- Read references/app-settings.md for complete app setting keys and effects.
- Run `omnyo explore` to browse the public Explore catalog of prompts, workflows,
  plugins and guides, `omnyo explore prompt/<slug> --text` for a prompt's exact
  text. It reads omnyohq.com directly, needs no running server, and sends no
  Omnyo thread or automation headers. Use `omnyo explore skills [--query <text>]
[--json]` for public source skills with publisher, license, reviewed revision,
  and source links; browsing does not install or execute them.

- Use `omnyo explore marketplace [--type skill|workflow|connector] [--query <text>]
[--category <category>] [--publisher <publisher>] [--json]` to browse skills,
  workflows and connectors together. Category and publisher values match exactly.
  Results link to source or setup details; the command installs nothing.

## Command habits

- Resolve names and IDs with a list or show command before mutation.
- Pass an explicit project when a command can act across projects.
- Pass an environment or machine selector when the default host is uncertain.
- Spawn onto a plugin-provisioned environment with
  `omnyo thread spawn --environment-provider <id>` (list them with
  `omnyo environment providers`).
  Read the provider's `requires` (`projectCheckout`, `gitCheckout`, `gitRemote`,
  `projectless`): these facts decide where
  the provider is offered. A provider whose `inputs` schema does not accept an
  empty object needs `--environment-inputs <json>` matching that JSON Schema;
  providers that accept `{}` use it when the flag is omitted
  (`omnyo environment providers --json` prints both facts). `--base-branch`
  belongs to `--new-environment worktree` only.
- Enroll an existing machine with `omnyo machine create --provider manual`; run
  the printed command on the target. `--no-wait` returns its host ID.
  Cancel with `omnyo machine remove <host-id>`. Removal revokes access; use the
  original `install-machine.sh --uninstall --host-id <host-id>` on that box.
- Create a standalone machine with `omnyo machine create --provider <id>`; use
  `--inputs <JSON>` for non-secret provider inputs and `--key` for retry identity.
- List plugin-provisioned machine choices with `omnyo machine providers`. Create a
  machine and an explicit environment with
  `omnyo thread spawn --new-machine <provider-id> --environment-provider <id>`; add
  `--machine-inputs <json>` when its schema requires inputs. Machine inputs are
  persisted and non-secret; credentials belong in plugin settings. Composed
  environments choose their own machine: use `--environment-provider modal-sandbox`
  without machine selectors and pass `--machine-inputs <json>` when configuring
  the composition's machine provider.
- Use `omnyo machine enroll` for a private core-prepared bundle. Local lifecycle is
  handled by `install-machine.sh --start|--stop|--uninstall --host-id <id>`;
  see references/thread-creation.md for ownership checks.
- Moving the omnyo server to another machine is experimental (the `serverMove`
  experiment). Never move a server, abandon a move, or unlock an old copy
  without the user's explicit confirmation in this conversation: run
  `omnyo server move --to <machine> --check`, show them the checklist, and run
  the same command without `--check` only after they confirm. A move stops
  all running work. `omnyo server export --out <file>` backs
  up a running server. `omnyo server import`, `unlock`, `allow-connect`, and
  `delete-old-copy` act on this computer's data directory without calling a
  server. An imported server keeps its connect tunnel and Omnyo account off
  until `omnyo server allow-connect`. On the computer a server moved away from,
  `omnyo server install-machine-service` installs the persistent, self-updating
  machine service (macOS and Linux only; needs Node.js 22.19+ on the PATH).
- Use `omnyo machine away <id-or-name>` to stop Omnyo's work on a machine and hold
  its new turns, for example while someone games on it; `omnyo machine available`
  releases them. Marking the machine your own thread runs on stops your thread.
- Use `omnyo machine suspend|resume <id-or-name>` only for providers that expose
  suspend and resume. Resume waits for pending suspension and is a no-op
  when already active. Use `omnyo machine retry-cleanup <id-or-name>` to retry a
  failed provider teardown immediately.
- Use `omnyo machine reconnect <id-or-name>` when a disconnected machine's
  server access or host key is rejected but its Omnyo host ID must remain.
  Run the printed short-lived command on that machine as is; it reuses the
  machine's recorded data directory, refreshes access, and re-enrolls under
  the same host ID. Connected machines are refused, and
  `--json` returns without waiting.
- `omnyo environment providers` lists Project checkout, Worktree, then other
  installed providers by display name. With `--project <id> --machine <id>`
  it also prints that machine's availability (`available`, `setup-required`,
  `unavailable`, or `unknown` until the background probe answers). Read or set `managedBranchPrefix`
  through `omnyo settings show` and `omnyo settings general <key> <value>`.
  `autoUpdateProviderClisOnStartup` defaults to true and updates installed CLIs
  before chats resume after startup or a worker restart, including Omnyo updates.
  Set it to false to disable automatic checks. Explicit CLI Update now still
  pauses chats on the selected machine and resumes after confirmed completion.
- The server keeps a registry of UI preferences (sidebar organization mode,
  section order, collapsed rows, navigation entries, and model picker
  favorites, hidden models, and the favorites switch): `omnyo settings ui list`,
  `get`, `set`, and `reset`. See `references/app-settings.md`.
- Query provider models on the machine that will run the thread.
- Prefer non-interactive commands and machine-readable output for automation.
- Pass `--yes` for a confirmed destructive command in a non-interactive shell.
- Treat plugin commands as normal top-level commands after installation.

- Inspect real status, logs, API results, or diffs instead of assumptions.
- For launcher startup errors and console output, read `logs/server-stdio.log`
  or `logs/host-daemon-stdio.log` under the selected Omnyo data directory. These
  append across restarts; `omnyo-app`, `omnyo-server`, and `omnyo-host-daemon` capture
  service output there instead of forwarding it to their terminal.
- Keep file paths on the machine that owns the selected workspace.

## Common checks

```sh
omnyo project list --json
omnyo machine list --json
omnyo environment providers --json
omnyo provider list --environment "$OMNYO_ENVIRONMENT_ID" --json
omnyo thread show "$OMNYO_THREAD_ID" --json
omnyo thread context --self --json
omnyo environment status "$OMNYO_ENVIRONMENT_ID" --json
omnyo plugin list --json
omnyo skill list --environment "$OMNYO_ENVIRONMENT_ID" --json
```

## Completion

Confirm the command result and any affected thread, environment, plugin, or
remote service. Report the stable ID or URL that the user needs next.

`omnyo environment show <id>` reports core-owned lifecycle, retirement deadline and teardown attempts. Archive/delete of the last live thread starts the provider grace; unarchive cancels pending retirement. Once the grace passes and the workspace is destroyed, sends to the thread fail until `omnyo thread restore-environment <id>` asks the environment provider to restore it and reattaches it to an unarchived thread, without starting a turn; providers decide what restoring means (a worktree returns on the branch it held), some cannot restore, and uncommitted changes in the removed workspace are gone. Teardown errors remain visible and retry automatically. `omnyo environment delete <id>` requests cleanup immediately, including under a never-retire policy; destroyed is recorded after cleanup completes. Removal waits for live or stopping runtimes. Project source deletion remains available during project deletion, including removal of the last source, so providers can finish cleanup.

## Plugin configuration

Use `omnyo plugin config <id>` to inspect the plugin’s configuration and
`omnyo plugin config <id> set <key> <value>` to change it. Read the plugin’s own
skill for its commands, configuration meanings, and operating constraints.
Discover contributed command paths through `omnyo plugin list`, the generated
`plugin-commands` skill, or `omnyo plugin run <id> --help`.

Keep this skill and its references focused on core Omnyo commands. Plugin-specific
behavior belongs in the owning plugin’s `skills/` directory, including built-in
plugins; do not add plugin command manuals here.

## Native mobile builds

For Android mobile builds and distribution, see `apps/mobile/README.md`.
When a thread is asked for a development APK, run `pnpm mobile:apk:dev` from the
source checkout root, wait for success, and link `apps/mobile/build-output/omnyo-dev.apk`.
Copy it into `$OMNYO_THREAD_STORAGE` for a durable per-thread artifact. The app is
named **Omnyo dev**, has orange icons, and installs separately as `app.getbb.mobile.dev`.
Append `-- x86_64` for an Intel emulator; the default is ARM64. It runs without
Metro or production credentials. The command sets `OMNYO_MOBILE_VARIANT=dev`;
direct Expo commands default to `production` and reject other variant values.
`GOOGLE_SERVICES_JSON` points to the optional Firebase Android config file;
local builds fall back to `apps/mobile/google-services.json`. EAS uses a file
environment variable. See `omnyo guide customization` for push controls.

## Built-in browser control

`omnyo browser profile-renderer [--duration 2s] [--json]` captures bounded JavaScript CPU samples from the selected app window, using `--host`, `--instance` and `--generation` without a thread. Duration is 200ms..5s. The result contains sanitized app asset coordinates and sample counts; it preserves focus and throttling and refuses an occupied debugger. Older desktop clients report unsupported; the command does not reload or install anything.

Use `omnyo browser instances --host <host-id> --json` to discover a desktop. Commands `tabs`, `create`, `acquire`, `connection`, `release`, `reveal`, `capture`, `close`, and `watch` take `--host`, `--instance`, `--generation`, and `--thread`; `--thread` defaults to `OMNYO_THREAD_ID`, and omitting `--instance`/`--generation` selects the only connected desktop window or fails listing the candidates. `omnyo browser create --url <http-url> --reveal` shows a served page in the thread's side panel. See `omnyo guide browser` and `omnyo browser --help` for flags. All tabs, including agent-created ones, share the Omnyo browser profile and its signed-in cookies. Revealing tabs or acquiring control opens the side panel and selects the tab only in the already focused thread, without switching threads or activating the desktop window. Connection credentials are written with `connection --output <new-file>` and work only on the browser host; keep them out of chat and public port shares. `import-sources` and `import-cookies --from <source> --profile <dir>` combine known-browser entries (including Helium and Dia) with schema-detected Chromium/Firefox profiles matched to registered web browsers and copy a selected profile into Omnyo; use the returned source ID, including opaque `storage-…` IDs, rather than assuming a fixed browser list, and on macOS prefer its `recommended` default-browser profile; they take the same desktop-window flags without `--thread`; Firefox, Safari, and Linux Chromium sources must be quit first, while macOS Chromium browsers can stay open. `omnyo browser cookie-sync enable --from <source> --profile <dir>` keeps Omnyo signed in from that profile every 15 minutes and removes synced cookies the source dropped; `status`, `run`, and `disable` (keeps imported cookies) use the same flags. Cookie data stays on the desktop host; results carry only counts and failure reasons.

`omnyo machine show <id-or-name> --json` includes provider-owned inventory and
estimates in `providerDetails` when available. Provider inventory failures are
reported; this is not billing/invoice data. Suspension requires idle live threads
and no open terminals; empty machines can use an opted-in provider idle policy.

The same `machine show --json` / SDK `hosts.get` response includes `directAccess`
for owner-authorized inspection: coordinator admission and actual worker probe
ownership, with instance/session linkage and SHA-256 owner fingerprints.
An available worker with `probe: null` is absent; an unavailable worker is
unobserved. Inspection never clears a hold. Machine credentials retain the host
response with direct-access inspection marked unavailable.

`omnyo thread context` reads recorded context usage without sending a model request. A breakdown is optional; absent usage is returned as `null`. When the provider reports the session's cumulative cost, `usage.cost` is `{ amount, currency }`. Its `autoCompaction` field reports the automatic compaction before the prompt cache expires (`scheduled`, `skipped`, `disabled`, `done`, `failed` or `stopped`, with `at`, `reason` and `cacheReadShare`); `omnyo thread auto-compaction <id> --on|--off` opts one chat in or out.

`omnyo thread commands [id] [--self] [--json]` lists the slash commands the thread's agent has advertised for its current session (ACP agents report these live; the list is empty until the agent sends one). `omnyo thread options [id] [--self] [--json]` lists the session options the agent reports, such as a mode, with each option's current value and allowed values. `--set <option=value>` (repeatable) chooses a value that is applied on the thread's next turn; `--clear <option>` drops a choice that has not been applied yet. Use `true` or `false` for an on/off option. To choose before the first message, pass `--option <option=value>` to `omnyo thread spawn`; `omnyo provider models <provider>` lists the options a provider's models declare.

`omnyo machine reconcile <id-or-name> [--json]` asks core to enforce its recorded
suspended state through the provider and waits for completion. It leaves active
machines and in-progress lifecycle operations alone. Use `machine suspend` to
request a new pause. Core does not schedule reconciliation polling.

Provider management lives in Settings → Providers. Use `omnyo provider list --all`
for the global catalog, `omnyo provider disable ID` to hide one provider and prevent
new turns, and `omnyo provider enable ID` to restore it (enabling its plugin if
needed). These preserve the CLI and thread history. Individual opt-outs survive
plugin off/on. Install provider plugins in Settings → Plugins; configure custom
ACP agents in the ACP providers plugin settings.

## Web-only updates

Use `omnyo updates web status --json` to inspect support and compatibility.
`omnyo updates web apply --directory PATH --json` uploads a prepared app build with
its `web-build.json`, verifies all bytes and atomically activates it without a
server restart. `omnyo updates web rollback --json` restores the previous interface.
While a generation is active, both commands need `--replace-active ID` with its exact
id from status; with none active the flag is optional and takes `packaged`. Name a
generation only when you activated it or were explicitly told to replace it.
Pages change on owner reload. An incompatible build needs the normal full
release; never patch packaged runtime files or force reloads. Private producers
use `pnpm private:web --prepare`.

## Usage privacy

`omnyo settings usage status --json` shows separate weekly-count and client analytics choices, effective restrictions and erasure status. `count on|off` changes the installation-wide count. `analytics on|off` explicitly changes this CLI client's consent; only interactive use contributes. `preview --json` shows safe synthetic fields without collecting an event. `erase` withdraws and asks the configured first-party collector to erase this client's subjects; retry if the result is pending. Keep local proofs until erasure completes. `OMNYO_TELEMETRY=false` disables both purposes before startup. See `docs/usage-privacy.md` for scope, regional notice and retention limits.
