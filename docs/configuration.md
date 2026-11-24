# Configuration

The Omnyo migration owner can install a versioned `stateMigration` binding in
`config.json`. It contains an absolute journal path, the exact source and
destination profile paths, and source, destination and artifact digests. The
journal stays outside both profile trees. This field is installer-owned and
must not be copied to another profile or edited to bypass admission.

The launcher, CLI, server and daemon durably open write admission before
startup writes. Database startup independently requires an already-open
binding. A missing, conflicting, malformed or rolled-back journal refuses
startup. Opening admission makes automatic rollback to old state unsafe, even
when startup loses its acknowledgement. Repair the current state through its
migration owner. Previously shipped strict configuration readers refuse this
new field before starting against the destination profile.

A coordinator removes its own binding at startup once the journal shows final
admission and the source profile is absent or empty. A profile that still holds
a populated source keeps the binding, and workers never remove theirs.

`autoUpdateProviderClisOnStartup` defaults to `true`. Settings → Updates controls
whether Omnyo checks and updates installed provider CLIs before resuming chats after
startup, a worker restart, or an Omnyo update. Missing CLIs are not installed.
Set it with `omnyo settings general autoUpdateProviderClisOnStartup false` or
`system.updateGeneralSettings`. Update now always pauses chats on the selected
machine, updates the CLI, then resumes them once the worker confirms completion.
Uncertain update outcomes keep chats paused until the same operation is reconciled.

Launcher status output is plain when stdout is redirected, including in CI.
Set `FORCE_COLOR=1` to request color or `NO_COLOR=1` to disable it; `NO_COLOR`
takes precedence. In-place progress updates require a stdout TTY.

The packaged `omnyo-app` flow stores persistent package settings under
`~/.omnyo/config.json`, provider environment values under `~/.omnyo/env.json`, and
client SSH target mappings under `~/.omnyo/client.json`.

Use `omnyo-app config` for non-secret Omnyo settings:

```bash
omnyo-app config set OMNYO_APP_URL https://<machine>.<tailnet>.ts.net
omnyo-app config list
omnyo-app config unset OMNYO_APP_URL
omnyo-app config refresh
```

Omnyo accepts request hosts that are `localhost`, IP addresses (including LAN and
Tailscale IPs), or the hostname in `OMNYO_APP_URL`. For a custom DNS name or reverse
proxy, set `omnyo-app config set OMNYO_APP_URL https://omnyo.example.com` before
connecting, including from the CLI or SDK. A matching `Host` and `Origin`, or
`X-Forwarded-Host`, cannot authorize an unconfigured DNS name. A proxy can
preserve the configured host or forward to localhost. Omnyo connect rewrites
requests to the local server address and needs no additional configuration.
`OMNYO_SERVER_BIND_HOST=0.0.0.0` remains supported for direct remote access.

To reach the same server under more DNS names, set `OMNYO_APP_ALIAS_URLS` to a
comma-separated list of https origins, for example
`omnyo-app config set OMNYO_APP_ALIAS_URLS https://app.example.com,https://omnyo.example.org`.
Each entry must be an absolute `https://` origin without a path, query,
credentials or wildcard. Aliases are accepted only as request hosts and browser
origins. `OMNYO_APP_URL` stays the canonical URL for generated links, and a server
move does not rewrite aliases. The config command applies the change live.

Use `omnyo-app env` for provider credentials and provider-specific environment:

```bash
omnyo-app env set OPENAI_API_KEY <key>
omnyo-app env list
omnyo-app env unset OPENAI_API_KEY
```

## Repository worktree hooks

Commit `.omnyo-env-setup.sh` when a managed worktree needs repository setup.
Commit `.omnyo-env-teardown.sh` when Omnyo must release external resources before it
removes that worktree. See [Worktrees, setup scripts, and teardown
scripts](worktrees.md) for the lifecycle, environment, timeout, and failure
contracts.

## Linux machine installer

The machine installer normally installs a persistent systemd user service. If
the current user's bus is unavailable, it retries using the runtime path from
`loginctl`. On a systemd host it then fails before enrolling if the bus still
cannot be reached. In containers and on machines without systemd as init, it
runs a detached daemon instead. Set
`OMNYO_INSTALL_SKIP_SERVICE=1` on the installer command only when running without
a service is intentional. No service starts the daemon after a reboot. The
temporary daemon used for a first join is not supervised; a previously joined
daemon started by the installer is supervised while its launcher runs.

`omnyo-app config list` shows non-secret values. `omnyo-app env list` redacts every
value and only shows whether a key is set.

The Add machine installer may also store a `machineCredential` and its
`connectMachineId` beside `serverUrl` in `config.json`. The credential is a
secret managed by Omnyo connect: do not copy, edit, or commit it. Both fields are
intentionally omitted from `omnyo-app config list`. At runtime omnyo-app passes
`machineCredential` to the standalone host daemon through `OMNYO_SERVER_HEADERS`,
and the daemon and its bundled `omnyo` CLI send it to the server as the
`x-omnyo-connect-machine` header; `connectMachineId` is only stored. These are
installer-managed transport details, not user configuration knobs; re-add the
machine instead of setting them by hand.

Use `omnyo-app client ssh-target` to let a local helper open files from a remote
Omnyo server in local editors. The SSH target is the value that works after
`ssh`, such as `devbox`, `user@devbox`, or a `Host` entry from `~/.ssh/config`:

```bash
omnyo-app client ssh-target set https://omnyo.example.test devbox --host-id host_abc
omnyo-app client ssh-target list
omnyo-app client ssh-target remove https://omnyo.example.test --host-id host_abc
```

Use `--host-id` when the server has more than one machine; copy the ID from
`omnyo machine list`. Omit it to preserve the single-machine auto-selection for
`set`, or to remove every mapping for that server with `remove`.

## Agent memory limit on Windows

On Windows machines the host daemon places every agent provider process, and
everything those processes start, in one Omnyo host job. The job runs below normal
priority and caps the committed memory of all agent work together at half of
physical memory. Allocations beyond the cap fail inside the job, so a runaway
build fails instead of paging the whole machine. The daemon stays outside the
job. If the daemon exits, Windows ends the job's processes.

Change the cap per machine with the startup-only `OMNYO_AGENT_MEMORY_LIMIT_MIB`
key, then restart that machine's daemon. Pass the daemon's `--data-dir` when it
does not use the default data directory:

```bash
omnyo-app env set OMNYO_AGENT_MEMORY_LIMIT_MIB 24576
omnyo-app env set OMNYO_AGENT_MEMORY_LIMIT_MIB off
```

The value is a whole number of MiB, at least 256, or `off`. An invalid value
stops agent providers from starting on that machine and logs the reason. Other
platforms ignore the key.

## Precedence

Configuration is resolved in this order:

1. Explicit launcher flags, such as `--data-dir`, `--server-port`, or
   `--server-bind-host`.
2. Persistent `omnyo-app config`, `omnyo-app env`, and client values.
3. Ambient shell environment.
4. Built-in defaults.

For the packaged app, prefer `omnyo-app config`, `omnyo-app env`, and launcher flags
over shell variables. The environment remains the internal and deployment
substrate, and source-development commands still load `.env` files.

For source development, `pnpm dev` automatically injects
`OMNYO_DEV_CONNECT_BASE_URL=http://omnyo.localhost:<worktree-cloud-port>`;
`pnpm dev --staging` injects `https://stg.omnyo.link` instead. The Omnyo
account plugin accepts only those origins, only when `NODE_ENV=development`,
and uses the value as the sign-in default; the Connect plugin
uses it for its dashboard link while signed out. Explicit
`omnyo account login --base-url ...`, `omnyo connect --server ...`, or
`--base-url ...` targets take precedence but accept only `https://omnyo.link`
and `https://stg.omnyo.link` (plus `http://omnyo.localhost:<port>` when
`NODE_ENV=development`), and packaged/production Omnyo keeps the
`https://omnyo.link` default. This value is launcher-managed, not an
`omnyo-app config` setting.

After `omnyo-app config` writes `~/.omnyo/config.json` or `omnyo-app env` writes
`~/.omnyo/env.json`, it asks the running local server to reload. If Omnyo is not
running, the new values apply on the next start. If you edit either file by
hand, run `omnyo-app config refresh` to apply the files to a running server.

The live reload applies the `OMNYO_APP_URL` config key and provider env values. If
`OMNYO_APP_URL` is stored with `omnyo-app env` instead, it is startup-only; use
`omnyo-app config` when you need a live change.

`OMNYO_LOG_LEVEL` is the startup-only `omnyo-app config` key. The complete current
set of startup-only server or launcher env entries is:

- `OMNYO_APP_SURFACE`, `OMNYO_APP_URL`, `OMNYO_DATA_DIR`, `OMNYO_DEV_APP_PORT`, and
  `OMNYO_EXTERNAL_URL`
- `OMNYO_HOST_DAEMON_PORT` and `OMNYO_INHERITED_SKILLS_ROOTS`
- `OMNYO_LOG_LEVEL`, `OMNYO_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD`,
  `OMNYO_PERF_DIAGNOSTICS`, `OMNYO_USAGE_COLLECTOR_URL`, `OMNYO_USAGE_COUNT_REGION`,
  `OMNYO_SENTRY_DSN`, and `OMNYO_TELEMETRY`
- `OMNYO_SERVER_BIND_HOST`, `OMNYO_SERVER_PORT`, and all `OMNYO_FF_*` feature flags

Setting or unsetting one still runs the reload for any other pending changes,
but the running processes keep their current values. Apply it with a full
launcher restart (`omnyo-app stop && omnyo-app start`) or by restarting the desktop
app. In particular, changing or unsetting `OMNYO_SERVER_BIND_HOST` does not close
an existing `0.0.0.0` listener until that restart.

`omnyo-app config refresh` also notes any startup-only keys currently present in
`config.json` or `env.json`; those values apply on the next full restart.

When targeting a non-default running instance, pass the same `--data-dir` and
`--server-port` to `omnyo-app config` or `omnyo-app env` commands so they write the
right file and refresh the right server.

## Stopping A Running Omnyo

A running `omnyo-app start` writes `<dataDir>/app-runtime.json` and removes the
file when it exits. The file records the launcher process id, the server URL,
the version, the start time, and how Omnyo was started. Do not edit it.
An unreadable or malformed record refuses ownership rather than allowing replacement.

Two things read that file:

- `omnyo-app stop` stops the Omnyo instance that owns the data directory. Pass the same
  `--data-dir` you started with when it is not the default `~/.omnyo/`.
- The macOS desktop app asks before it uses an Omnyo instance it did not start, and offers to
  stop that copy for you.

Both confirm that the recorded process really is an Omnyo launcher before they
signal it, so a stale file left by a crash cannot stop an unrelated process.

## In-App Updates

In-app updates are on when you start Omnyo with the installed `omnyo-app start`
or with `pnpm start` from a source checkout. Omnyo runs under a small
update shim, so Settings → Updates and `omnyo updates app apply` can update Omnyo
without a terminal. Pass `--no-in-app-updates` to turn them off: Omnyo then starts
without the shim and Settings → Updates points release installs to the
verified private release installer. `--in-app-updates`, which earlier releases needed, is still
accepted and changes nothing. Source checkouts show their
Git revision, or a labeled build version when unavailable, and are never compared
with npm releases. Without the update shim, no freshness indicator is shown.
Failed checks report “Latest unknown”; release checks can be retried in the UI,
with `sdk.system.version({ force: true })`, or by rerunning `omnyo updates`.
`GET /api/v1/system/version` and `sdk.system.version()` expose nullable
`installKind` (`desktop`, `npm`, or `source`) and `currentCommit` fields.

- **npm installs** restart into a verified runtime staged in
  `<dataDir>/app-versions/<version>/` while Omnyo keeps running. Public npm
  registry updates are unavailable; private coordinators receive runtimes as
  described below. The shim runs whichever is newer, that staged runtime or the
  copy you launched. Unreadable update state or an unusable newer runtime stops startup
  with an error; Omnyo never silently selects an older copy. Update diagnostics do
  not affect runtime selection. Pass `--bundled` for an explicit recovery with
  the launched copy; unreadable state stays untouched and updates are disabled
  for that run. Restart requests cannot select a version older than one already
  launched by the same shim. Omnyo keeps the running and previous versions, and
  the version the running shim itself started from, and deletes older ones; it
  deletes nothing when no running shim identifies its start version.
- **Source checkouts** update only from a clean `main` that fast-forwards to
  `origin/main`. Omnyo stops, fast-forwards, runs `pnpm install --frozen-lockfile`,
  rebuilds, and restarts. Other branches, local commits, and uncommitted tracked
  changes block the update with an explanation.

Omnyo does not roll back an update. If the new version fails to start, Omnyo exits
with its error and the next start runs the new version again, as it would after
a manual upgrade. Install a newer release with the verified private release installer, or fix the
cause; an older release may not open a database the new version migrated. A source
checkout whose rebuild fails stays on the new commit; fix the build and run
`pnpm start` again. Download, install, and fast-forward failures happen before
Omnyo stops, so the current version keeps running.

The outcome is recorded in `<dataDir>/omnyo-app-update.json` once Omnyo starts
cleanly, and shown in Settings → Updates, `omnyo updates app`, and the API until
dismissed. Do not edit that file. If Omnyo is stopped during the restart, an npm
install starts the new version next time, while a source checkout stays on its
current commit and reports the update as failed. Only one launcher manages
updates for a data directory:
a second `omnyo-app start` on the same data directory runs with in-app updates off,
and `omnyo-app stop` stops the managing launcher. If threads start while an update
downloads and you did not agree to interrupt threads, Omnyo cancels the restart and
asks you to update again.

A server the desktop app starts updates with the desktop app instead. When the
desktop app connects to a server it did not start, Settings → Updates lists
**Server** (updated in-app on that server's machine) and **Desktop** (this
app's own relaunch update) separately. `pnpm dev`, `omnyo-server`, and a standalone
`omnyo-host-daemon` do not offer in-app updates. Updating restarts Omnyo,
which interrupts running threads; the app and CLI ask first.

`OMNYO_APP_UPDATE_MODE`, `OMNYO_APP_INSTALL_KIND`, `OMNYO_APP_SOURCE_ORIGIN`, and
`OMNYO_APP_SOURCE_COMMIT` are internal markers the launcher passes to its server
child; do not set them yourself.

### Private coordinator updates

A packaged coordinator runs under the update shim only when
`<dataDir>/private-server-update/` exists; the shim always runs in private
mode, whatever the release version form (`X.Y.Z` or `X.Y.Z+private.N`). Its producer stages a verified
runtime in `<dataDir>/app-versions/<version>/node_modules/omnyo-app` and then
writes `<dataDir>/private-server-update/approved.json` (`schema`, `version`,
`protocolVersion`, `sourceCommit`, `runtimeSha256`, `stagedAt`). Settings →
Updates and `omnyo updates app` offer that runtime when its numeric version is
newer; an unreadable manifest is shown as blocked rather than ignored.

Schema 2 manifests declare `activation: "idle-only"`. These updates wait for all
work indefinitely, expose no force action, and reject `omnyo updates app apply --yes`.
The publisher refuses this manifest on controllers without schema 2 support.
The installed 0.46.238 controller receives no automatic identity-migration offer.
Its existing maintenance owner acquires an idle hold before an independent control
context gracefully changes the same OS service owner.

`omnyo server maintenance adopt-identity --request-file PATH --phase preflight|stage|rollback`
runs the selected verified runtime's stopped-state controller. The versioned request
binds the original maintenance hold, host, source and destination profiles, external
job, runtime archive and complete installed-plugin artifact selection. Preflight
reads the actual installed inventory and artifact bytes. Stage refuses live writers,
fences the old profile, and preserves plugin state before admitting any new writer.
Rollback is available only before first-write admission. This command does not stop
the service, change its owner or publish an automatic update offer.

Updating waits until every chat is idle; new messages keep starting turns while
it waits. If chats are still running 10 minutes after the update was applied,
Omnyo stops them, restarts and resumes them, as **Update now** does. The waiting
status reports that time as `activity.stopsRunningChatsAt`. New turns pause only
for the short restart handoff and send after it. The bottom-bar update button,
**Restart now** and `omnyo updates app apply --yes` stop every running chat on
every machine immediately, save their continuations, and restart without waiting
for worker activity. The launcher stops the coordinator and its local worker,
including open browser sessions, terminals, and plugin work. It sends SIGKILL
if either process does not stop within five seconds. Each paused chat resumes
after the restart once its machine is ready. A connected automatic-update worker
running an older runtime holds only its own new work until its replacement
session connects. Ready machines do not wait for other workers. Ordinary idle
updates still require worker admission. If a
chat cannot be paused, the update is cancelled and eligible chats resume.
**Cancel** or `omnyo updates app cancel` stops a waiting update. Before restarting, the launcher checks the staged runtime's
`dist/runtime-identity.json` digest; a mismatch keeps the current version
running and records the failure.

## Private desktop updates

Private macOS builds read `private-updates.json` beneath Electron userData. A
missing file disables updates. An explicit schema1 enable flag, matching channel
and non-secret HTTPS base URL are required; URL userinfo/query/hash, headers and
GitHub feeds are refused. No feed is configured by local preparation. The
installed signed bootstrap, exact bundle/runtime inventory and native acceptance
must pass before a guarded update. Desktop-owned coordinator updates require an
idle durable maintenance hold; remote-only clients never hold their remote
coordinator. See [private desktop updates](private-desktop-updates.md) for the
configuration, packaging and recovery contract.

## Held first start

Set `OMNYO_SERVER_STARTUP_HOLD` in the launch environment to start a coordinator
with work admission held before database recovery or plugin startup. Its value
is strict JSON with exactly `id`, `ownerId`, `expectedServerHostId` and
`expectedDataDir`. The data directory must be absolute and match `OMNYO_DATA_DIR`;
the host ID must match that directory's existing server identity. For example:

```bash
OMNYO_SERVER_STARTUP_HOLD='{"id":"migration-prep","ownerId":"migration-owner","expectedServerHostId":"host-source","expectedDataDir":"/absolute/owned-data"}' omnyo-app --data-dir /absolute/owned-data
```

This value is launch-only. Do not save it with `omnyo-app config` or `omnyo-app env`.
A matching request is restart-idempotent. Later launches can omit the value;
the durable `startup` hold remains active. Malformed, conflicting, mismatched or
already released ownership fails before database initialization.

Use `omnyo server maintenance status` to read the running runtime ID, hold and
activity. `omnyo server maintenance prepare <operation>` requires the exact
`--id`, `--owner-id`, `--runtime-id`, `--host-id` and `--data-dir` on each call.
It permits only these operations:

| Operation                 | Additional flags                  | Effect                                                                                                                                  |
| ------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `quiesce`                 | None                              | Stop running threads through the normal stop path.                                                                                      |
| `create-manual-target`    | `--name NAME`                     | Prepare one hold-owned manual target with a stable retry identity.                                                                      |
| `configure-direct-access` | `--server-url URL`                | Set canonical `machineServerUrl` and direct default access.                                                                             |
| `convert-to-direct`       | `--worker-id ID`                  | Convert the named existing worker using the normal idle and compatibility checks.                                                       |
| `enable-server-move`      | None                              | Enable only the `serverMove` experiment.                                                                                                |
| `rebind-plugin`           | `--plugin-id ID --root-path PATH` | Rebind the same installed direct-path plugin without starting its factory; preserve its settings, enabled state, secrets and schedules. |

Preparation prints JSON and leaves admission held. The manual target's existing
enrollment command remains available through `hosts.experimental_getEnrollmentCommand({id})`; its
one-use enrollment credential is still required. Preparation retains admission
until that target connects and its creation finishes; move, release and further
preparation are refused until that completion. Other enrollment and ordinary mutations
remain frozen. SDK callers use
`server.maintenance.prepare({id, ownerId, expectedRuntimeId,
expectedServerHostId, expectedDataDir, operation})` with the same finite operation
types.

Start a real move with both `--startup-hold-id ID` and `--startup-owner-id OWNER`
on `omnyo server move`; SDK callers pass `startupOwnership: {id, ownerId}` to
`server.startMove`. The hold stays durable during the move. Move checks exclude
preparation and release; admitted preparation excludes move start. Failed or
cancelled moves return to the same held state. Only an exact-owner
`omnyo server maintenance release --id ID --owner-id OWNER --host-id HOST` resumes
normal work.

## Common Keys

| Key                               | Command                                               | When to set             | Used for                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMNYO_APP_URL`                   | `omnyo-app config`                                    | Optional for remote use | Human-facing app URL used for generated links and allowed browser origins. Leave empty for local-only use.                                                                                                                                  |
| `OMNYO_APP_ALIAS_URLS`            | `omnyo-app config`                                    | Optional extra hosts    | Comma-separated absolute https origins accepted as additional request hosts and browser origins beside `OMNYO_APP_URL`. No paths, credentials or wildcards. Generated links still use `OMNYO_APP_URL`.                                      |
| `OMNYO_SERVER_URL`                | `omnyo-app config`                                    | Remote CLI/host use     | Server URL for standalone `omnyo` CLI and `host-daemon` commands on the current machine. The CLI uses the saved `serverUrl` from its data directory when unset, or `http://127.0.0.1:38886` when no selection exists.                       |
| `OMNYO_SERVER_BIND_HOST`          | `omnyo-app env`, environment, or `--server-bind-host` | Startup-only            | Server listener host. Defaults to `127.0.0.1`; accepts only `127.0.0.1` or `0.0.0.0`. A full launcher or desktop app restart is required; until then, a previous `0.0.0.0` listener remains exposed. This is not an `omnyo-app config` key. |
| `OMNYO_SERVER_PORT`               | `omnyo-app env`, environment, or `--server-port`      | Startup-only            | HTTP listener port. Defaults to `38886`. A full launcher or desktop app restart is required after a persistent set or unset.                                                                                                                |
| `OMNYO_SERVER_STARTUP_HOLD`       | Launch environment only                               | Held first start        | Strict JSON with `id`, `ownerId`, `expectedServerHostId` and absolute `expectedDataDir`. Creates a durable startup hold before database recovery. See Held first start above.                                                               |
| `OMNYO_HOST_DAEMON_PORT`          | `omnyo-app env`, environment, or `--host-daemon-port` | Startup-only            | Local host-daemon API port. Defaults to `38887`. A full launcher or desktop app restart is required after a persistent set or unset.                                                                                                        |
| `OMNYO_LOG_LEVEL`                 | `omnyo-app config`                                    | Startup-only debugging  | Log level: `trace`, `debug`, `info`, `warn`, `error`, or `fatal`. A full launcher or desktop app restart is required.                                                                                                                       |
| `OMNYO_ACCOUNT_POOL_PARENT_URL`   | Set automatically by a parent Omnyo server            | Nested Omnyo servers    | Account Pooler hub of the Omnyo server whose thread launched this one. When present the Account Pooler defaults to proxying to that parent; `omnyo pool parent isolate` opts out. Not an `omnyo-app config` key.                            |
| `OMNYO_ACCOUNT_POOL_PARENT_TOKEN` | Set automatically by a parent Omnyo server            | Nested Omnyo servers    | Machine token this nested server presents to the parent Account Pooler hub. Paired with `OMNYO_ACCOUNT_POOL_PARENT_URL`; both must be well formed or proxying stays off. Not an `omnyo-app config` key.                                     |

The `omnyo` CLI records each failed invocation on the machine that ran it, in
`<data dir>/logs/cli-errors.jsonl`: the time, CLI version, command path, error
code, exit code, current thread ID, and the unknown command or flag. It never
records argument values or error text. The file rotates to `cli-errors.jsonl.1`
at 2 MB. `omnyo diagnostics cli-errors [--since 7d] [--json]` tallies it and
`--clear` deletes it. Set `OMNYO_CLI_ERROR_LOG=0` in the environment that runs `omnyo`
to turn recording off.

## AI services

Thread titles (and the branch names built from them), commit messages, and
voice transcripts come from AI services that plugins register. Omnyo hosts no
AI service: each one uses your own model login or runs locally. Settings → AI
services covers titles and commit messages; voice plugins such as Dictation by
Paraspeech keep their own settings. The CLI covers every task:

```bash
omnyo settings ai-services
omnyo settings ai-services set commit-message my-openrouter
omnyo settings ai-services set voice off
omnyo settings ai-services test thread-title
```

Each task is `automatic` (the default), `off`, or a service id. A service is
identified by its plugin and its id, so two plugins may register the same id;
pass `--plugin <plugin-id>` to `set` when they do. Automatic tries
all registered services in lexicographic order of plugin id and service id,
including third-party plugins. Only services supporting the task participate;
unavailable services and failed requests fall through to the next. Omnyo hosts
no AI service of its own: every request goes through a provider you have signed
in to. Codex (`codex`, the `provider-codex` plugin) uses the Codex CLI login on
the primary machine. A service you pick is used alone; if it fails, titles fall back to the start of the prompt and
commits to `omnyo: automated commit`. Each plugin picks its own model.

`BB_INFERENCE`, `BB_INFERENCE_FALLBACK`, and `BB_TRANSCRIPTION` were removed.
Omnyo ignores them in `~/.omnyo/config.json` with a warning, and `omnyo-app config set`
refuses them.

With a ChatGPT subscription login, Codex voice transcription posts to a
`chatgpt.com` endpoint that sits behind Cloudflare bot protection. On some
networks Cloudflare challenges that request and transcription fails. If that
happens often, run `codex login --with-api-key` on the primary machine, or pick
another voice service.

Omnyo accepts voice recordings up to 25 MB. A service may set a lower limit;
Codex transcribes recordings up to 20 MB.

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

The microphone preference is client-local. It stores the
selected browser `MediaDevices` device id in localStorage as
`omnyo.voiceInput.audioInputDeviceId`. Recording prefers that microphone and falls
back to the system default and other available inputs when it is disconnected,
then uses the saved preference again when it reconnects. Select System default to follow system
microphone changes; it does not change which service
transcribes.

The built-in Push notifications plugin uses `expoPushUrl` for its relay URL.
The default is `https://exp.host/--/api/v2/push/send`. Change it with
`omnyo plugin config push-notifications set expoPushUrl <url>`. The plugin reads
the value when it sends a message. Independent `mobileEnabled`, `webEnabled`,
and `desktopEnabled` booleans default to true. Change each with
`omnyo plugin config push-notifications set webEnabled false` (or the other
channel key). `mobileOnlyWhenAway` (default true) holds mobile push while an
Omnyo desktop app reports its computer in use; the phone gets chats still unread
once that computer locks, sleeps, stops reporting or sits idle for 2 minutes.
Held pushes survive a server restart; the server then waits up to 90 seconds
for a desktop report before sending them. Web and desktop clients receive
system notifications while an Omnyo tab or window remains open. A focused
window shows a card instead for chats that need you or failed, and stays quiet
for the chat on screen; browsers require HTTPS or localhost and per-device
notification permission. Settings → Push notifications offers permission and
test controls. `omnyo push-notifications test <web|desktop>` broadcasts a test to
connected, permitted clients; it does not confirm OS display. A thread uses
its own level; otherwise a child thread uses `childLevel` (`inherit` for the
same as `defaultLevel`, `all`, `input-only` or `muted`, default `input-only`)
and a top-level thread uses `defaultLevel` (`all`, `input-only` or `muted`,
default `all`). A thread's level also limits its child threads: the result is
capped by every ancestor's own level, so muting a parent mutes its whole
subtree, and a parent set to `all` never makes workers louder than their own
level or `childLevel`.
`input-only` keeps questions, approvals and errors but skips finished turns.
Change the defaults with `omnyo plugin config push-notifications set defaultLevel
muted` (or `childLevel`). Set one thread with
`omnyo push-notifications thread <thread> --level <inherit|all|input-only|muted>`.

The builtin Keep Awake plugin has one autosaving configuration page with an
enable switch and an all-or-selected host picker. On selected macOS hosts it
runs `/usr/bin/caffeinate -i -w <worker-pid>` while enabled, preventing system
idle sleep while Omnyo is running. It only blocks idle sleep: closing a laptop lid
or choosing Sleep manually still sleeps the Mac. Configure it from an agent or
terminal with:

```sh
omnyo keep-awake status [--json]
omnyo keep-awake enable [--json]
omnyo keep-awake disable [--json]
omnyo keep-awake hosts all
omnyo keep-awake hosts <host-id>...
```

The builtin Concurrency limit plugin has an autosaving page under Plugins →
Installed plugins. Its overall limit is unlimited by default. Each host defaults to
Auto: one thread per available processor. A blank host field restores
Auto, and 0 pauses new work for that scope. Configure it from an agent or
terminal with:

```sh
omnyo concurrency-limit status [--json]
omnyo concurrency-limit global [unlimited|<limit>] [--json]
omnyo concurrency-limit host <host-id> [auto|<limit>] [--json]
```

The "Show diagnostic events" toggle in Settings → General → Privacy & diagnostics shows provider
environment resolution and raw provider events that Omnyo does not yet understand.
It defaults to off in all builds. Warnings, errors, and model fallback remain
visible. An existing unhandled-provider-events preference is preserved.
Set it with `omnyo settings general showDiagnosticEvents <true|false>` or
`api.sdk.system.updateGeneralSettings` using the `showDiagnosticEvents` field.
For older SDK callers, the general-settings API still accepts and returns
`showUnhandledProviderEvents` as a deprecated alias. Both names control the same
setting. When a read-modify-write payload contains conflicting values, the
value changed from the saved setting wins. Hidden diagnostics do not count
toward timeline event or byte limits.

The prompt box uses plain-text editing. Markdown delimiters remain visible while
editing.

The "Default thread followup behavior" picker in Settings → General changes the
active-thread composer shortcuts when no typeahead suggestion is active. A
queued message waits and then runs when the agent stops. A steer message goes
to the agent during the current run. The picker defaults to "Steer" for a new
install: Enter steers and Command+Enter queues. "Queue" swaps them: Enter
queues and Command+Enter steers. Ctrl+Enter is the same modifier shortcut on
Windows and Linux. An earlier install with saved settings or work
keeps "Queue" because a one-time migration stamps the old default onto it. Set
it with
`omnyo settings general steerActiveThreadOnEnter <true|false>`, where `true` is
"Steer".

The "Show Git status" switch in Settings → General defaults to on.
Turn it off to hide the Git control in the thread header: the branch, the
changed files, the pull request status and actions, and Commit. The bundled Git
plugin draws that control; disabling the plugin also hides it.
Thread relationships and workspace warnings remain visible. This server-wide preference persists
across reloads and applies to every connected app client. Set it with
`omnyo settings general showGitChanges false` or read the current config and call
`sdk.system.updateGeneralSettings({ ...config.generalSettings, showGitChanges: false })`.
Older clients that omit the field preserve the saved value.

The "Show messages from before a context clear" switch in Settings → General defaults
to off. When off, a thread's timeline, conversation outline, and message lookup
start at its latest `Context cleared` boundary. Turn it on to keep earlier
messages above the boundary; they load on scroll like other older activity and
appear in the outline and `omnyo thread log --message` lookups. Clearing still starts a
fresh provider conversation and resets the context meter either way. Set it
with `omnyo settings general keepHistoryAfterContextClear true` or
`api.sdk.system.updateGeneralSettings` using `keepHistoryAfterContextClear`.
Older clients that omit the field preserve the saved value.

New-chat approval defaults live in Settings → Providers. `defaultPermissionMode`
defaults to `auto`. `modelPermissionModes` maps provider IDs to model IDs and
approval modes. Both fields are server-backed General settings:

```sh
omnyo settings general defaultPermissionMode accept-edits
omnyo settings general modelPermissionModes '{"codex":{"gpt-5":"auto"}}'
```

The model map replaces all overrides. Removing an entry restores global
inheritance. Existing chats retain their recorded mode. Explicit choices,
managed-parent policy, and saved project choices take precedence. Valid modes
are `accept-edits`, `auto`, and `full`, subject to provider support. Unsupported
choices fail without expanding access. The SDK uses
`sdk.system.updateGeneralSettings` with the same fields.

The "Thread archive confirmation" switch in Settings → General defaults to on.
Turn it off to archive a thread and its child threads immediately without a
confirmation popup. The archive toast still offers Undo. This server-wide
preference applies to all connected app clients. Set it with
`omnyo settings general confirmThreadArchive false` or
`api.sdk.system.updateGeneralSettings` using `confirmThreadArchive`.
CLI and SDK archive operations remain non-interactive.

A new install opens a first-run setup guide (connect an agent, add projects,
import recent Codex and Claude Code chats, pick plugins, set up devices).
`onboardingCompletedAt` in general settings records when it was finished or
skipped; `omnyo settings replay-onboarding`, or
Settings → General → Setup guide, clears it so the guide shows again.
The projects step lists what `omnyo project discover` and
`api.sdk.hosts.experimental_discoverRepos({ hostId })` return.

The "Streamer mode" toggle in Settings → General hides every `customModels`
entry from `~/.omnyo/config.json` in all model lists: the web and mobile pickers,
`omnyo provider models`, and `sdk.providers.models`. Turn it on before a screen
share so a private or early-access model id does not appear. It defaults to
off. The entries stay in `config.json`, and a thread that names a hidden model
explicitly still runs with it. Default model resolution for a new thread also
keeps the full list, so a provider whose only models are custom still starts.
A composer keeps its stored model selection when that model is absent from the
visible catalog. It sends the selected model explicitly and does not substitute
the provider default. Set it with
`omnyo settings general streamerMode <true|false>`.

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

The "New branch prefix" field in Settings → General sets the text Omnyo
puts in front of every branch name it creates for a managed worktree or a new
checkout branch. It defaults to `omnyo/`, which produces
`omnyo/fix-login-flow-thr_ab12cd34ef`. Change it to `sawyer/` to group your branches
under your own namespace, or clear the field to create
`fix-login-flow-thr_ab12cd34ef` with no prefix. Omnyo rejects a prefix that cannot
start a valid git branch name, such as one with a space or a leading `-`, and
the prefix is at most 64 characters. The prefix applies to branches Omnyo creates
after you change it; it does not rename an existing branch or worktree. Set it
with `omnyo settings general managedBranchPrefix <prefix>`.

## Storage & retention

The bundled **Storage & retention** plugin is enabled by default. If disabled,
enable it with `omnyo plugin enable omnyo--storage-retention`, then open its sidebar panel. Both thread policies
default to Never. The plugin stores its policy and latest run in its own storage;
there are no general app settings for retention. Preview with
`omnyo storage retention --archive-after 30 --delete-after 90`; add `--save --yes`
to save. Use `never` to turn either policy off. Days range from 1 to 3650.

The plugin also offers **Delete thread storage on archive**, off by default.
Thread retention settings save immediately in the panel.
Set it with `omnyo storage retention --delete-storage-on-archive true --save --yes`
(or `false` to disable). It clears storage for future manual and automatic
archives, including cascaded children, preserving conversations and uploaded
attachments and skipping pinned threads. An hourly check starts automatic cleanup
at most once every 24 hours, for queued threads archived at least 3 hours earlier.
Pending cleanup persists across reloads. Younger archives, unavailable machines,
and failures wait for a later daily run. Bulk archived-file cleanup respects the
core 30-second archive undo grace and rechecks eligibility before each batch.
Unarchiving cancels pending cleanup. Existing archives are not cleared by enabling
this setting; use the explicit archived-file cleanup action for those.

### Housekeeping

Storage & retention owns background housekeeping and per-stage recovery. The
panel's Housekeeping section and `omnyo storage housekeeping status` expose
current runs, completed work, holds and missing measurements. `preview --machine HOST_ID`
inspects work; `run --machine HOST_ID --yes` starts the same runner used by
scheduled maintenance. A preview does not enable an external cleanup policy.

Fresh installations have no external policy roots. A local Mac policy requires
an explicit `adapter-preview` and exact `adapter-adopt` confirmation. Source,
runtime and policy hashes bind the registration. Drift holds execution until a
new administrative preview is adopted. Existing deletion preferences, disabled
history classes and recovery journals remain authoritative. See the owning
[Storage & retention skill](../plugins/storage-retention/skills/storage-retention/SKILL.md)
for registration inputs and recovery commands.

Adapter preview accepts `--docker-kasten-policy PATH` for the separately approved
Kasten Docker cache profile. Its exact file/hash binding and stage remain
separate from the primary policy. Runtime discovery contacts no engine and shows
protected proposals for unregistered engines, Cua placement and unresolved owner
inventory. Proposals contain exact paths and preservation requirements and grant
no deletion, policy adoption or guest-disk cleanup.

Known worker-private temporary files have process-generation ownership and
normal-exit closeout. Input EOF does not finish a provider that is still
draining. Recovery never enrolls an arbitrary existing folder or treats an
unknown process identity as stopped. Thread-owned scratch keeps its separate
review and expiry policy below.

### Managed cleanup policy

Managed cleanup has a separate plugin policy and never changes thread retention.
The panel previews changes before confirmation. `omnyo storage managed-policy`
returns the policy and allocation status. Its configurable fields are:

| Field                   | CLI flag                                    | Default                |
| ----------------------- | ------------------------------------------- | ---------------------- |
| `mode`                  | `--mode` with `review` or `owner-approved`  | `review`               |
| `automaticExpiry`       | `--automatic-expiry` with `true` or `false` | `false`                |
| `quarantineBudgetBytes` | `--budget-bytes BYTES`                      | 10737418240, or 10 GiB |

Supplying policy fields without `--save` returns a preview. Repeat the same fields
with `--expected-revision POLICY_REVISION --preview-digest PREVIEW_DIGEST --save --yes`
to save that preview. The server owns `revision` and `expiryEnabledAt`. Review is
an administrative action under ordinary account authority, not proof of human
presence. Neither review nor a policy change creates a missing native owner grant.

Only `ManagedScratch` can allocate a fresh empty payload through native chat
context, with an explicit `disposable-when-owner-ends` or `keep-until-released`
disposition. Existing paths cannot be adopted. `owner-approved` mode uses those
native grants automatically after current safety checks. A full quarantine budget
holds further cleanup instead of evicting files. Hourly, startup, and reconnect
reconciliation run without model wakeups.

New native allocations also require `storage.role`, a finite positive
`storage.budgetBytes`, `storage.minimumFreeBytes`, and `storage.restoreInputs`.
Each restore input has an immutable reference and SHA-256. Admission checks the
actual filesystem before the allocation request is written. Budget overruns
hold cleanup without evicting files; native `budget-extend` checks an explicit
increase before more production. Legacy missing declarations stay protected.
Native release records the producer outcome and exact keeper paths and removal
conditions in `closeout`. Keepers must already be outside disposable scratch.
These declarations do not create removal permission or enforce an OS quota.

Permanent removal has a fixed seven-day quarantine floor. Explicit per-item or
previewed batch purge is available after that floor even with automatic expiry
off. Every off-to-on expiry transition starts a new seven-day minimum after the
later of quarantine and enablement. Restore never overwrites an existing original
path. Windows supports allocation and owner decisions, with a visible hold for
unavailable directory-entry power-loss durability. Physical cleanup remains held
there because complete native process inspection is unsupported.
Restore and changed data revoke the old cleanup permission. They require a fresh
native release or a genuinely new authoritative owner end before cleanup resumes.
An idle declared consumer retains its hold until it releases natively or ends.
Pinned and shelved chats remain protected. Reloaded grants need a matching proven
owner end or a fresh native release. Changed quarantined data and uncertain move
recovery start a new seven-day window; unchanged scans preserve the date.
Byte counts are logical sizes, not measured physical
space reclaimed; quarantine itself does not free disk space.

See the [Storage & retention skill](../plugins/storage-retention/skills/storage-retention/SKILL.md#managed-scratch)
for exact review, restore, purge, and native owner requests.

### Other storage cleanup

**Delete development data when its checkout is removed** is a separate,
off-by-default setting: `omnyo storage retention --delete-dev-data-on-checkout-removal true --save --yes`
(use `false` to disable). It scans online persistent machines on plugin startup, machine reconnect, and hourly, and
cleans missing-checkout `~/.omnyo-dev` folders after successful hourly or manual
scans, including existing data. The machine rechecks absence before deletion,
stops servers working inside removed checkouts, and keeps existing or unresolved
sources. Offline/busy machines and failed cleanup retry on later scans. Thread
retention preview counts do not include development folders. A removal event re-measures only that machine's `~/.omnyo-dev`, waiting for any running cleanup there to finish. Startup and
periodic scans recover missed events by checking the filesystem; no removal
history is stored in the core database.

The hourly plugin schedule processes up to 50 trees per action across all projects.
Archive eligibility uses each affected member's updatedAt; deletion requires every
lifecycle member to have been archived past the cutoff. Pinned members exempt the
group. Cross-plugin protection is deferred: pin automation targets to keep them.
Archiving may remove worktrees including uncommitted changes; deletion removes
history and thread storage. Disabling the plugin stops retention
without losing the saved policy. The plugin uses existing SDK thread listing and
archive/delete APIs, accepting changes between inspection and mutation.

Storage reads use cached reports and never trigger disk scans. Start a background
scan with `omnyo storage usage --machine HOST_ID --rescan`, or omit `--machine` to
scan every online machine; rerun usage to see its status and results. Bulk cleanup runs one job at a time per machine; scans run alongside cleanup, and a finished scan leaves out anything cleared while it ran. The existing
bounded idle orphan sweep remains independent of the plugin.
`omnyo storage remove-orphans --machine HOST_ID --yes` uses the last scan;
`omnyo storage clear-large-files [--machine HOST_ID] --yes` deletes files of 10 MB
or more from archived threads' storage, keeping smaller files and skipping
pinned and running threads. The page starts this cleanup in the background,
reports its running/completed/failed status, and survives navigation or reconnects.
`omnyo storage usage` also exposes that status as `largeFileCleanup`. The CLI waits
for deletion to finish;
`omnyo storage clear-archived-files --machine HOST_ID --yes` removes archived threads’
whole storage folders, including small files, skipping pinned and running threads;
`omnyo storage remove-dev-instances --machine HOST_ID --yes` removes `~/.omnyo-dev`
instances whose source checkout no longer exists, first stopping servers still
running from that checkout; add `--instance NAME` to remove one entry of any
kind, stopping its dev server first if it is running;
`omnyo storage retry-worktree-cleanup --machine HOST_ID` retries environment cleanup;
`omnyo storage clear-thread --thread THREAD_ID --yes` empties stopped-thread storage.
The plugin owns the disk scanner, cached reports, classification, and host-worker
file operations. Reports are snapshots; changes outside the plugin appear after
a rescan. These actions are available through its typed plugin RPC. See the
[plugin skill](../plugins/storage-retention/skills/storage-retention/SKILL.md).

Settings → Providers lists every registered agent provider in picker order.
Move a provider up or down to change the order and choose the default for new
threads. Both are persisted preferences: `providerOrder` is the list of ids
that lead the picker (ids not listed follow in plugin install order, and an id
that names no registered provider is ignored) and `defaultProviderId` is the
provider new threads use when neither the caller nor the project chose one
(`null` means the first available provider in picker order). Set them with
`omnyo settings general providerOrder '["claude-code","codex"]'` and
`omnyo settings general defaultProviderId claude-code` (or `null`).

The "Collapse finished turns" switches in Settings → Providers choose, per
provider, how a finished turn appears in the thread timeline. Collapsed, the
turn's work folds into one activity row, such as "Worked 3m · 2 commands",
and the final answer stays visible. Flat, every step of the finished turn
stays visible, as it was while the turn ran. Each provider declares its default (`completedTurnDisplay` on
its registration): Claude Code defaults to flat, and every other first-party
provider defaults to collapsed. Your choice is stored in
`providerCompletedTurnDisplay`, a map of provider id to `collapse` or `flat`;
a provider without an entry uses its default. The display applies to existing
threads as well as new ones, and to the conversation outline and
`omnyo thread log`. Set it with
`omnyo settings completed-turns <provider-id> <collapse|flat|default>`, where
`default` removes your entry, and list every provider's current display with
`omnyo settings completed-turns`.

Each provider's own options live on its plugin: Codex memory and native
subagents under the Codex provider plugin, and Claude Code memory, native
subagents, and the Workflow tool under the Claude Code provider plugin.

Claude Code's **Allow model fallback** provider setting (`allowModelFallback`)
defaults to `false`. Omnyo keeps the selected model when it is unavailable or cannot
continue. Enable automatic switching with
`omnyo plugin config provider-claude-code set allowModelFallback true`, or turn on
**Allow model fallback** in Settings → Providers → Claude Code. The setting
applies before the next turn and preserves conversation context. A reported
fallback does not change the model selected for later user turns.

Claude Code's **Disable 1M context** provider setting (`disable1MContext`)
defaults to `false`. Enable it with
`omnyo plugin config provider-claude-code set disable1MContext true`.
Omnyo sets `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` when enabled and `0` when off.
Changes restart the thread's Claude process before its next turn, preserving
conversation context.

Claude Code starts without its Claude in Chrome browser tools when Omnyo runs it,
even when the interactive `claude` CLI has Chrome enabled by default. Turn the
tools on for Omnyo threads with
`omnyo plugin config provider-claude-code set chromeEnabled true`. Omnyo then starts
Claude Code with `--chrome`. The host needs the Claude in Chrome extension and a
claude.ai login; API-key sessions keep Chrome off. A change restarts the thread's
Claude process before its next turn and keeps the conversation.

In Accept Edits and Approve for me modes, Omnyo runs Claude Code's Bash commands in
Claude Code's sandbox. Turn it off with
`omnyo plugin config provider-claude-code set sandboxEnabled false`. Bash commands
then go through Claude Code's normal approvals and your own Claude Code
permission and sandbox settings. A change restarts the thread's Claude process
before its next turn and keeps the conversation.

Claude Code's **Approvals in Full Access** provider setting
(`fullAccessApprovalsEnabled`) defaults to `false`, so Full Access approves
every request Claude Code sends and unattended threads never wait. Turn it on
with `omnyo plugin config provider-claude-code set fullAccessApprovalsEnabled true`
to show Claude Code's own prompts in Full Access: `permissions.ask` rules,
PreToolUse hooks that answer `ask`, and its built-in safety checks. The setting
applies from the thread's next turn without restarting Claude. When Omnyo runs
as root, Full Access always approves, because Claude Code refuses
`bypassPermissions` there.

Outside an open typeahead menu, Shift+Enter inserts a newline. On
coarse-pointer touch devices, the software-keyboard Return path inserts a
newline and the submit button sends.
iPadOS WebKit additionally preserves the Enter and Command+Enter shortcuts
above for a connected Magic Keyboard.

## Themes

`omnyo theme` controls CSS-variable overrides for the app palette and typography.
Custom themes live at `<omnyo-data-dir>/theme/<name>/theme.css`; use `omnyo theme dir`
to find the directory and `omnyo theme show [id] --css` to inspect resolved CSS.

The typography tokens are mode-independent and belong in the `:root, .light`
block:

- `--font-sans` controls app UI and body text.
- `--font-mono` controls code blocks, diffs, file paths, and previews.
- `--font-serif` controls serif prose.
- `--font-terminal` controls the integrated terminal's font family.

Always end font stacks with a generic fallback such as `sans-serif` or
`monospace`. The complete theme token reference is in the omnyo-cli skill's
`references/theming.md`.

## Keyboard Shortcuts

`Mod+Shift+P` opens the quick palette: type to filter, then run a command with
Enter. It lists only commands that apply on the current surface, shows each
one's shortcut, and offers recently run commands first. The numbered
accelerator families and the relative cycle commands stay rebindable but
unlisted. Plugins can add their own rows, listed under "Plugins".

Settings → Keyboard edits app command shortcuts. Overrides are stored in the
server database, applied live to every connected window, and kept across
restarts. Resetting a shortcut removes its override so future Omnyo releases can
continue to update the default. Clearing a shortcut explicitly disables that
command. Command context and native-only availability remain server-owned and
are not editable. Actions supported by both clients use the same resolved
bindings in the browser and desktop app; browsers may still reserve some chords
before Omnyo receives them.

`Mod` means Command on macOS and Control on Windows/Linux. `rail.jump.1…9`
switch the left project rail in displayed order: Inbox first, then visible
projects, including Personal. Hidden projects are skipped unless the selected
hidden project's tile is temporarily shown. Reordering the rail changes the
numbered destinations immediately. Desktop uses `Mod+1…9`; web uses
`Control+1…9` on macOS and `Ctrl+Shift+1…9` on Windows/Linux, leaving native
browser tab switching untouched. Hold Command or Control to see shortcut hints.
The `thread.jump.1…9` and `pane.focus.1…8` commands start unassigned and remain
rebindable. Previous and next chat use Command+ArrowUp / Command+ArrowDown on
macOS, `Mod+Shift+[/]` on other desktops and `Control+Shift+[/]` on other web
clients. They follow the current chat sidebar order and wrap at either end.

`history.back` / `history.forward` (Go back / Go forward) do the same thing
as the sidebar's back and forward arrows: they move through the pages opened
in the current window, like browser history. They use `Mod+[` / `Mod+]` on
desktop and the web; in the browser, Omnyo handles the key instead of the
browser's own Back while it has somewhere to go. At either end the desktop app
does nothing, while the web app leaves the key to the browser's own Back or
Forward. The commands appear in the command palette only when there is
somewhere to go, and they don't run while the in-app browser has focus.
Hovering an arrow shows its current shortcut.

`edit.undo` / `edit.redo` (Undo / Redo) step back and forward through the
chat actions you took in the current window: Shelve, Unshelve, Archive
(including an environment's Archive threads), Unarchive, Pin, Unpin, Mark
read, Mark unread and Rename. They use `Mod+Z` / `Mod+Shift+Z`; `Ctrl+Y` also
redoes on Windows/Linux. Repeated presses walk further back or forward, and
each step shows a short confirmation. A toast's Undo button uses the same
history, so Redo can repeat an action undone there. Text fields, the terminal
and the in-app browser keep their own undo: the commands don't run while one of
them has focus or a dialog is open, and with nothing to undo or redo the key
passes through. The history lasts until the window reloads. Delete can't be
undone.

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

The "Show keyboard hints when holding CMD / Control" preference defaults
to on. Set it with
`omnyo settings keyboard hints <true|false>`. Turning it off hides the
delayed shortcut badges without disabling any shortcuts.

| Area      | Command                                   | Default                           | Availability             |
| --------- | ----------------------------------------- | --------------------------------- | ------------------------ |
| Palette   | Quick palette                             | `Mod+Shift+P`                     | All clients              |
| Threads   | New thread                                | `Mod+N` / `Mod+Shift+O`           | Desktop / web            |
| Threads   | Search threads                            | `Mod+K`                           | All clients              |
| Threads   | Rename focused thread                     | Unassigned                        | Thread view              |
| Threads   | Archive focused thread                    | Unassigned                        | Thread view              |
| Threads   | Shelve focused thread                     | `Mod+Shift+F`                     | Thread view              |
| Threads   | Copy focused thread link                  | `Mod+Shift+C`                     | Thread view              |
| Threads   | Group selected chats                      | `Mod+G`                           | While chats are selected |
| Threads   | Previous / next thread                    | Surface defaults above            | Desktop / web            |
| Threads   | Open visible thread 1–9                   | Platform defaults above           | Web / desktop            |
| Layout    | Previous / next chat pane                 | Unassigned                        | While split              |
| Layout    | Focus chat pane 1–8                       | Platform defaults above           | Split (web / desktop)    |
| Layout    | Maximize / restore chat pane              | `Mod+Shift+E`                     | While split              |
| Layout    | Close focused chat pane                   | `Mod+Shift+X`                     | While split              |
| Window    | New window                                | `Mod+Shift+N`                     | Desktop                  |
| Window    | Go back / go forward                      | Surface defaults above            | Desktop / web            |
| Window    | Settings                                  | `Mod+,`                           | All clients              |
| Window    | Open data directory                       | Unassigned                        | Desktop                  |
| Layout    | Toggle sidebar                            | `Mod+\`                           | All clients              |
| Panel     | New tab / close tab / toggle              | `Mod+T` / `Mod+W` / `Mod+Shift+J` | All clients              |
| Workspace | Quick open file / toggle diff             | `Mod+P` / `Mod+D`                 | All clients              |
| Workspace | Open terminal                             | `Mod+Shift+Enter` / `Mod+Shift+T` | Web / desktop            |
| Workspace | Open in preferred app                     | `Mod+O`                           | All clients              |
| Composer  | Focus composer                            | Unassigned                        | All clients              |
| Composer  | Toggle composer terminal                  | `Mod+J`                           | Chat view                |
| Composer  | Toggle model picker                       | `Mod+Shift+M`                     | All clients              |
| Composer  | Cycle model forward / backward            | `Alt+M` / `Alt+Shift+M`           | All clients              |
| Composer  | Cycle provider forward / backward         | `Alt+P` / `Alt+Shift+P`           | All clients              |
| Composer  | Cycle reasoning effort forward / backward | `Alt+T` / `Alt+Shift+T`           | All clients              |
| Browser   | Focus location / reload / find in page    | `Mod+L` / `Mod+R` / `Mod+F`       | Desktop embedded browser |
| Questions | Choose visible answer 1–9                 | `1` … `9`                         | While a question is open |

Cycle commands wrap in both directions. Reasoning cycles only through the
current model's supported efforts in canonical low-to-high rank order, not the
provider response order. The cycle shortcuts act only from the active composer
or an open picker; unrelated editable controls retain their Option-composed
character input. A configured app shortcut takes precedence in editable
controls; when no matching command handles a chord, the control retains its
native behavior.

A chat message that starts with `!` runs as a shell command instead of being
sent: Enter runs it in the chat's composer terminal, which opens in place of
the message box in the chat's workspace. The send button reads Run; its menu
and `Mod+Enter` send the text to the chat unchanged. `composer.terminal.toggle`
(`Mod+J`) switches the composer between the message box and that terminal,
starting a shell when none is running. Each chat has one composer terminal:
hiding it keeps the shell running, and the next `!` command reuses it. Press
Ctrl+C twice at an empty prompt with nothing running to close it. Closing a
terminal that still runs a command, here or in the terminal panel, asks first.
The terminal is an ordinary chat terminal, so `omnyo terminal` lists and drives
it too; `omnyo terminal foreground` shows what it is running.

The desktop application menu uses the same resolved bindings for New Thread,
New Window, New Tab, Close, and Settings. There is no separate menu shortcut
configuration.

`OMNYO_SERVER_URL` does not change where full `omnyo-app` startup binds locally.
It is for commands that need to target an already-running server, such as the
bundled `omnyo` CLI or a standalone host daemon. The CLI resolves its target in this
order: explicit `OMNYO_SERVER_URL`, repository development defaults when a checkout
is supplied, then saved `serverUrl` in `config.json` under `OMNYO_DATA_DIR` or
`~/.omnyo`. Only an absent file or field defaults to `http://127.0.0.1:38886`.
An empty or invalid override, unreadable file, malformed config or invalid saved
URL fails visibly. The CLI never rewrites the saved selection during resolution.
`OMNYO_HOST_DAEMON_PORT` keeps its existing defaults and override behavior.

## Client SSH Targets

`~/.omnyo/client.json` is local to the machine showing the UI. The CLI resolves the
remote server's host ID and stores a mapping from that server/work-host to an SSH
target known to the local machine. The remote server does not read this file.

Example:

```json
{
  "servers": {
    "https://omnyo.example.test": {
      "hosts": {
        "host_abc": {
          "sshAuthority": "devbox"
        }
      }
    }
  }
}
```

When a remote Omnyo page asks the local helper to open a work-host path, the helper
uses this mapping to launch remote-capable editors and terminals over SSH.
Browsers or devices without a helper can still use Omnyo; local editor actions are
simply unavailable.

## Provider availability

Settings → Providers lists disabled providers under Disabled, below the enabled
providers. Only enabled providers can be reordered. An enabled row’s three-dot
menu makes it the default or disables it. A disabled row’s Enable button
restores the provider and, if needed, its supplying plugin. A provider whose
plugin did not load shows Plugin didn't load, which opens that plugin's page.
Disabling an individual provider leaves its plugin, sibling providers, installed
CLI, and existing threads intact. In-flight turns can finish; new turns and
sessions are rejected until the provider is enabled again. Queued messages and
automations are subject to the same server-side check.

```bash
omnyo provider list --all
omnyo provider disable acp-opencode
omnyo provider enable claude-code
```

`omnyo provider list` and thread pickers omit disabled providers. `list --all`
shows the global management catalog, including providers whose plugins are off;
it cannot be combined with machine or environment selectors. Enabling a shared
plugin preserves individual provider opt-outs. Disabling the selected default
clears that choice, allowing the next enabled provider in saved order to be used.
A project whose last-used provider is disabled also falls back to that order;
explicitly requesting a disabled provider is still rejected.

The core `disabledProviderIds` value lists disabled providers by ID. It is stored
apart from Settings → General, so only the provider enable/disable route, CLI and
SDK change it; a general-settings save, even from a stale client, cannot. Enable
removes the ID, so the provider returns to its automatic discovery behavior:
agents such as `acp-opencode` again appear only where their CLI is installed.
Uninstalling a plugin forgets the disabled state of its providers.

The SDK exposes `sdk.providers.catalog()` and
`sdk.providers.setEnabled({ providerId: "acp-opencode", enabled: false })`.
Install provider plugins in Settings → Plugins. Configure custom ACP agents in
the ACP providers plugin settings.

## Model picker

The model picker (`Mod+Shift+M`, or the model button in the composer) opens on
a compact grid of your favorites: one row per favorite model with its favorite
levels in columns that line up, then All models. With no favorites it opens on
All models. Click a level to choose the provider, model, and level in one step;
the picker closes and, on desktop, the caret returns to the composer. Click a
row's name to apply its favorite level closest to the current one. All models,
or typing anything, opens the full grid of every provider's models with the
search box focused; Escape returns to favorites. In the full grid every row
shows all of its model's levels, favorite levels are brighter and carry a small
star in their corner that never moves the level, and a level the model lacks is
an empty slot. Clicking a model name there keeps the current
level when the model offers it, or the closest supported level otherwise. On
phones, only the selected row and the row under the keyboard cursor show their
levels. Agent options and Handoff to new thread stay below the list.

Speed is a mode, not part of a model choice. ⚡ beside the model button turns
fast mode on or off and is filled while it is on. When the model also offers
Ultrafast, the same button steps Fast, Ultrafast, then off; a double bolt marks
Ultrafast. The picker itself has no speed controls. Choosing another model,
level, or favorite keeps the current speed when that model offers it, and
otherwise returns to the default speed.

Favorites are saved provider, model, and reasoning combinations. On desktop,
right-click a level for Add to favorites or Remove from favorites; right-click
a model name to do the same for the level a click on it would apply. In the
favorites grid, right-click removes a favorite. A current
choice that is not a favorite appears in the favorites grid as a dashed
placeholder in the row and column it would take, with a star in a reserved
slot. The star adds it in place without moving anything, and pressing it again
removes it. With `modelPicker.footerFavorites` on, the desktop composer shows
favorites as one switcher in place of the model button. The current model shows
its provider icon and name, then one segment per favorite level. Every other
favorite model is one chip with its icon and name; clicking it switches to that
model at its favorite level closest to the current level. ⚡ and ⌄ end the
switcher. The pressed segment is the current selection. A pick only moves the
pressed segment, so segments never reorder. A current selection that is not a
favorite is pressed with a dashed outline in its model's group, followed by a
star that adds it. With no favorites, the switcher shows every level of the
current model. Chips that do not fit are left out whole, never cut, and ⌄ shows
how many favorites it holds, such as `+2`. The current model always stays; if
it alone does not fit, the composer shows the model button. The switcher grows
back when space returns. Clicking the current model's name opens a list of
model names only; Left and Right in that list do not change the level.

A favorite that cannot run here is dimmed with the reason, for
example when the machine lacks its model or level, its tier is off, its provider
is disabled, or an agent option conflicts. Omnyo never substitutes a nearby model
for it. A favorite saved with a tier, from Settings or by an earlier version,
shows ⚡ and applies that tier; every other favorite keeps the current speed.

Edit, beside the All models search, turns each row's eye into a hide or show
toggle and shows every row's levels as favorite stars. Edit never changes the selection; Done or
Escape leaves it. A provider's hidden models fold into its "N more" row, which
expands in place. Search still finds them, a selected hidden model stays in the
list, and `Alt+M` skips them. Hiding changes only the list: provider defaults
and saved selections stay the same.

Search matches model names, model ids, and provider names across providers and
orders providers by best match. End
the query with a reasoning level, such as `sol xh` or `opus ultra`, to land on
that level; models without it drop out. A prefix that matches several levels,
such as `u`, stays part of the model query. The first match is highlighted, so
`Mod+Shift+M`, `sol xh`, Enter switches in one motion.

The picker opens with the cursor on the favorite that matches the current
selection, or otherwise on the first row. Up and Down move through the rows and
All models; Right or Enter on All models opens it. On the selected row with an empty search, Left and
Right step its reasoning level live, as they do on the focused model button; on
another row they move the level that Enter applies. Enter applies and closes.
Escape, an outside click, or `Mod+Shift+M` closes without a change. `Alt+M`,
`Alt+P`, and `Alt+T` still cycle models, providers, and reasoning. Favorites
have no number shortcuts.

In an existing chat, other providers' groups and favorite rows show a New chat
label, and their favorites appear in the switcher after this provider's, marked
with a new-chat icon. Choosing one starts a handoff to a new thread; the Handoff
to new thread header's close button cancels it.

Every desktop composer shows the switcher except these, which keep the model
button:

- Sent and queued message editors, side chats, and provider-locked composers
  show only their provider's group and favorites.
- Execution-locked composers disable the model button.
- The plugin `experimental_ProviderModelPicker` component shows the picker
  without the switcher.
- Phones always show the model button, with ⚡ on the same row.
- `modelPicker.footerFavorites` set to `false` keeps the model button
  everywhere.

In the composer's bottom rail, the model control takes at most 60% of the row;
the rest keeps Send visible and folds extra controls under ….

Settings → Providers → Favorite models shows favorites the way the picker
groups them: one row per model, grouped by provider in provider order, with
every level the model offers as a star. Click a level to add or remove that
favorite, drag a model to reorder it within its provider, or remove a whole row
with ×. Provider groups follow the provider order at the top of the page. Add
favorite saves the model and level chosen in the picker beside it. The same
card turns Show favorites in the composer on or off. Settings → Providers →
Hidden models shows hidden models again.

These are UI preferences in the registry described under
[Sidebar preferences](#sidebar-preferences). `modelPicker.favorites` keeps up to
24 entries in order and drops duplicates, keeping the first; an omitted
`serviceTier` is stored as `"default"`, and an unknown field is rejected.
`modelPicker.hiddenModels` maps a provider id to its hidden model ids and drops
empty lists. `modelPicker.footerFavorites` is `true` or `false`; a number saved
by an earlier version reads as `true`.

```sh
omnyo settings ui get modelPicker.favorites
omnyo settings ui set modelPicker.favorites '[{"providerId":"claude-code","model":"claude-opus-5-5","reasoningLevel":"ultracode"},{"providerId":"codex","model":"gpt-6.1-sol","reasoningLevel":"xhigh","serviceTier":"fast"}]'
omnyo settings ui set modelPicker.hiddenModels '{"codex":["gpt-5.6-sol","gpt-5.6-luna"]}'
omnyo settings ui set modelPicker.footerFavorites false
omnyo settings ui reset modelPicker.hiddenModels
```

SDK callers write the same values with the revision they read:

```ts
const { preferences } = await sdk.system.uiPreferences.list();

await sdk.system.uiPreferences.set({
  key: "modelPicker.favorites",
  value: [
    {
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
    },
  ],
  expectedRevision: preferences["modelPicker.favorites"].revision,
});
```

## Custom ACP Agents

Known ACP agents appear when their CLI is installed on the host. Omnyo exposes
`acp-opencode` when `opencode` is on PATH and can be launched as `opencode acp`,
`acp-omp` when `omp` (oh-my-pi) is on PATH, `acp-grok` when Grok Build's `grok`
CLI is on PATH and can be launched as `grok agent stdio`, and
`acp-hermes-agent` when Hermes' `hermes` CLI is on PATH. `acp-cursor` is always
listed.

The rebuilt ACP adapter ships as a second built-in plugin, "ACP providers (new
adapter)", which is off by default. Turn it on in Settings → Plugins or with
`omnyo plugin enable omnyo--provider-acp-next`. It registers the same provider ids,
so existing threads keep working, and only one of the two ACP plugins runs at
a time: turning the new one on turns "ACP providers" off, turning it off
turns "ACP providers" back on, and the `customAgents` list follows the switch
in both directions. The new adapter adds agent options in the model picker
(the agent's mode stays in the composer footer), live slash commands in the
composer, agent questions as question cards, sign-in
guidance, and the official ACP registry: its settings page lists the
registry's agents with an Add button, and `omnyo acp registry`, `omnyo acp add
<agent-id>` and `omnyo acp remove <agent-id>` do the same from the CLI. Adding
one writes a `customAgents` entry that runs the registry's `npx` or `uvx`
package on the thread's host, so the host needs Node.js or uv. Agents the
registry ships only as a downloadable binary are listed but must be installed
by hand and added as a custom agent.

Add your own agent through the ACP providers plugin's `customAgents` setting,
which holds a JSON array. In the app it is the multi-line editor on the
plugin's settings page (Settings → Plugins → ACP providers); from the CLI:

```bash
omnyo plugin config provider-acp set customAgents '[
  {"id": "amp", "displayName": "Amp", "command": "amp", "args": ["acp"]}
]'
```

Each entry needs `id` (lowercase letters, digits and dashes), `displayName`,
and `command`. Omnyo derives the provider id `acp-<id>`; it never changes once a
thread has used it. An id Omnyo always lists (`cursor`) is reserved; an id Omnyo
lists only where the agent is installed (`opencode`, `omp`, `grok`,
`hermes-agent`) is not, so an entry with that id REPLACES the shipped agent.
A replacing entry keeps the shipped agent's `nativeSkillRoots` unless it sets
its own, and Omnyo still lists the roots that agent's host config names (its
config directory, compat trees, configured paths, plugins) either way.
Optional fields: `args`, `env`, `cwd`, `modelCli` (CLI model listing and
selection), `reasoningCli` (launch-time reasoning flags), `nativeReasoning`
(ACP `session/set_config_option` reasoning), `nativeSkillRoots` (native skills
in the composer, as `{"user": [...], "project": [...]}` relative paths; an
entry is a path or `{"path": ..., "recursive": true, "ancestors": true}` for
an agent that nests skills or reads them from every ancestor directory),
`permissionCli` (permission-mode launch flags), `supportsManualCompaction`
(only if the agent accepts an explicit compaction request — Omnyo hides
`/compact` otherwise), and `dialect` (the vendor side channels Omnyo reads for
the agent: `cursor`, `opencode`, `omp`, or `grok`).

The change applies immediately: the plugin re-registers its providers when the
setting changes, with no restart and no `config refresh`.

A configured agent's command is local code execution and only works with a
co-located daemon.

Omnyo launches OpenCode sessions with `OPENCODE_CLIENT=acp` and
`OPENCODE_ENABLE_QUESTION_TOOL=false`, overriding inherited and custom launch
values. Native questions have no ACP interaction handler in Omnyo; agents use the
ask-user-question plugin’s `AskUserQuestion` tool instead. This also applies to
custom agents with `dialect: "opencode"` and does not change OpenCode config files.

## OpenCode Go Usage

OpenCode Go subscription usage uses the credentials configured on the selected
machine. Sign in to Go in OpenCode there, then select that machine in Provider
usage or run `omnyo settings usage --machine <id-or-name> --json`. Omnyo reads
`OPENCODE_API_KEY` first, then the active official Console account and organization
from `$XDG_DATA_HOME/opencode/opencode.db`, then `OPENCODE_AUTH_CONTENT` or
`$XDG_DATA_HOME/opencode/auth.json` (default data directory `~/.local/share/opencode`).
Console account storage is read only; OpenCode owns refreshing expired sessions.
The `opencode-go` API key takes precedence over the shared `opencode` key.
Custom ACP launch `env` overrides apply to credential lookup; a custom wrapper
must declare `dialect: "opencode"` and `providerUsage: true`. The endpoint requires
an active Go subscription and reports its five-hour, weekly, and monthly quota
windows, not other providers' usage or Zen pay-as-you-go spending.

## Custom Models

Register extra picker models by editing top-level `customModels` in
`~/.omnyo/config.json`. Use this for a model the provider accepts but does not
list, such as a non-public preview id. This list has no set/unset CLI surface:
edit the JSON, then run `omnyo-app config refresh` or restart Omnyo. `omnyo-app config list` prints the entries.

```json
{
  "customModels": [
    { "providerId": "claude-code", "model": "claude-example-preview" },
    {
      "providerId": "acp-my-agent",
      "model": "my-proxy/my-model",
      "displayName": "My Proxy Model"
    }
  ]
}
```

`providerId` accepts a built-in provider id (`codex`, `claude-code`, `pi`,
`acp-cursor`) or any `acp-*` provider id: an installed-only plugin provider
such as `acp-opencode`, or a custom ACP agent's derived `acp-<id>`. `displayName` is
optional; Omnyo derives the label from the model id when it is omitted. Omnyo skips
an invalid entry with a warning and keeps the rest of the config.

Each entry appears in `omnyo provider models <providerId>` and in the model
picker after the provider's own catalog. The provider catalog wins on a model
id collision. The "Streamer mode" General setting
(`omnyo settings general streamerMode true`) hides every entry from these lists
until you turn it off again.

A `customModels` entry only makes the id selectable; the provider must still
accept it. Built-in providers such as `claude-code` and `codex` accept
unlisted ids. An ACP agent receives the id over the protocol at session start
and can reject it. OpenCode rejects a model that is not in its own catalog,
so do not pin OpenCode models here: add the model to the OpenCode config and
Omnyo discovers it automatically.

An OpenCode "agent" (build, plan, or a custom primary agent) is a session
mode, not a model, so it does not belong in `customModels`. Omnyo does not select
OpenCode agents; set the default agent in the OpenCode config instead.

## Agent Instructions

Omnyo can inject user-level and workspace-level agent instructions into every
provider-backed thread's system prompt, alongside the skills convention.

For user-level defaults across projects, create `AGENTS.md` in the Omnyo data dir:

```
<dataDir>/AGENTS.md
```

For repo-specific guidance, create `.omnyo/AGENTS.md` at the workspace root:

```
<workspace>/.omnyo/AGENTS.md
```

The file contents are appended alongside enabled plugin instructions when a
provider session starts, so the guidance applies regardless of which provider
runs. When both files exist, `<dataDir>/AGENTS.md` is appended first and
`<workspace>/.omnyo/AGENTS.md` second. An empty or whitespace-only file is treated
as absent.

No agent loads `.omnyo/AGENTS.md` natively. Provider-native instruction files
remain separate. Codex reads a repo-root `AGENTS.md`. Claude Code 2.1.277 and
later also reads `AGENTS.md` when no project or ancestor `CLAUDE.md` or
`CLAUDE.local.md` takes precedence. Older Claude Code versions and sessions
without its built-in `AGENTS.md` support still require `CLAUDE.md`. Omnyo reads
the files above itself and injects them, so use them for guidance you want every
Omnyo thread to receive regardless of provider.

Before reading workspace instructions at thread start or resume, the host explicitly prepares workspace identity. It imports a legacy `.bb` tree once into `.omnyo` only while its workspace writers are idle. The import preserves the whole tree and its permissions. Two existing roots, a changed migration owner, or malformed registry provenance fail visibly without overwriting either source. Ordinary discovery and reads never perform this import.

## Skills

User-level Omnyo skills live under `<dataDir>/skills/<name>/SKILL.md`; for the
packaged app this is usually `~/.omnyo/skills`. Project skills live under
`<workspace>/.omnyo/skills/<name>/SKILL.md` and override same-named user or plugin
skills. Running plugins contribute another tier: `skills/<name>/SKILL.md`
files in an installed plugin (relocatable via the manifest's `omnyo.skills` field)
are imported while the plugin is loaded, subject to its agent configuration.
Project and user skills override plugin skills by name. Omnyo guide owns the
four bundled core skills and can disable them together or individually.

The repository-owned verification skill carries the reserved frontmatter field
`omnyo-source-skill-v1: example/bb-private/core-verification`. Daemons also
accept `example/omnyo/core-verification`, and the skill file switches to that
marker once the Mac and 3090 daemons report the release that reads it. Its exact
`verify-omnyo/SKILL.md` project entry keeps the existing managed skill ID when
moved from the finite legacy entry. Names and paths remain canonical; this is
not an execution alias or a general-purpose ID override. Unmarked same-named
skills and provider-native skills retain their ordinary identities. Remove the
reserved field when creating an independently owned skill at another path.
Invalid owned markers or two different files claiming this identity refuse
listing; neither source is changed. Existing chat text and history stay intact.

Omnyo indexes each provider's native skill roots for that provider's `/` command
menu. Each provider plugin declares where its agent keeps skills and slash
commands, and resolves on the host what only that machine and workspace know
(a moved config directory, installed vendor plugins, config-file entries); Omnyo
itself knows no agent's layout. The Skills page and `omnyo skill list` show
native skills for every provider whose plugin declares or resolves roots. The
table lists what the shipped plugins declare and resolve.

| Provider     | User roots                                                                                               | Project roots                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Codex        | `~/.agents/skills`, `$CODEX_HOME/skills`                                                                 | `.agents/skills` from the repository root to the current directory, plus `.codex/skills`                     |
| Claude Code  | `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`, plus enabled plugin skills                            | `.claude/skills` from the repository root to the current directory, plus enabled plugin skills               |
| Pi           | `~/.pi/agent/skills`, `~/.agents/skills`                                                                 | `.pi/skills` and `.agents/skills` from the repository root to the current directory                          |
| Cursor       | `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`                            | The same four roots in the workspace                                                                         |
| OpenCode     | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`                                      | `.opencode/skills`, `.claude/skills`, and `.agents/skills` from the repository root to the current directory |
| omp          | The active `~/.omp/.../agent` roots and supported Pi, Agents, Claude, Codex, and OpenCode roots          | `.omp/skills` and the supported compatibility roots from the repository root to the current directory        |
| Grok Build   | `$GROK_HOME/skills` or `~/.grok/skills`, plus `~/.agents/skills`, `~/.claude/skills`, `~/.cursor/skills` | The same four roots from the repository root to the current directory                                        |
| Hermes Agent | `$HERMES_HOME/skills` or `~/.hermes/skills`                                                              | None                                                                                                         |

OpenCode also uses `$OPENCODE_CONFIG_DIR/skills` when that variable exists.
Pi and omp use `$PI_CODING_AGENT_DIR` when that variable exists. omp also uses
`$OMP_PROFILE` or `$PI_PROFILE` to select its active profile root. Cursor and
Hermes can organize skills in category directories. Omnyo scans those roots
recursively. Pi settings and packages can add skill paths. omp reads
`skills.customDirectories` from its YAML configuration. Hermes reads
`skills.external_dirs` from `config.yaml`.

Grok reads recursive paths from `[skills].paths` in `config.toml`. It also reads
enabled Grok and Claude-compatible plugin skills. Its Cursor and Claude
compatibility roots follow the related config and environment switches.

A skill file that more than one registered provider reads, such as one under
`~/.agents/skills` or `~/.claude/skills`, is listed once with no provider
(`provider: null`) and shown as Shared on the Skills page and in `omnyo skill
list`, instead of being attributed to whichever provider was scanned first.

## Multi-machine

Settings → Machines offers Manual machine setup (the built-in `manual` provider)
alongside installed cloud, SSH and Tailscale providers. Manual machine setup prints
a private enrollment command and waits for the daemon. The one-line command
downloads `/install.sh` with a short-lived enrollment header. The server embeds
the pending bootstrap in its uncached response; cancelled, expired, or consumed
enrollments are rejected. `omnyo machine create
--provider manual` follows the same lifecycle; `--no-wait` returns the creating
host ID. Manual machines never suspend or retire automatically. Removal
revokes access; run the original installer with `--uninstall --host-id <id>` on
that machine to uninstall its daemon. The local host remains provider-less.

Settings → Machines can also rename and remove machines; project settings can add a path or clone source on
each machine; and thread creation can target any enrolled machine with a usable
source. The CLI equivalents are `omnyo machine list`, `omnyo project create
--machine <id-or-name> ...`, `omnyo project source add --machine <id-or-name>
...`, and `omnyo thread spawn --machine <id-or-name> ...`.

Multi-machine execution is independent of browser access. Tailscale and Omnyo
connect let another browser reach the Omnyo server; multi-machine support lets
that server dispatch work to host daemons on other machines. The Settings → Machines
installer can use a paired Omnyo connect account to route the daemon and its CLI
back to the server. Machine credentials remain locally managed as described at
the top of this document.

Each machine has a permission ceiling (`maxPermissionMode`, default `full`).
The server resolves every thread on that machine down to the ceiling, so a
paired sandbox machine can keep Full Access while a personal machine stays at
Approve for me or Accept Edits. A provider that supports no mode under the
ceiling is refused on that machine. Only an owner session sets it, on the machine
page (Settings → Machines → the machine, which also carries that machine's
projects, provider CLIs, update state, and rename/remove); it is deliberately
absent from the SDK and the `omnyo` CLI,
and machine credentials are rejected at both the Omnyo connect gate and the
server. The boundary it defends is machine-to-machine: a process already
running on the server machine has the data directory and the server itself, so
it is trusted as the owner here exactly as it is for renaming or removing a
machine. The current value is readable through the host API and
`omnyo machine list --json`.

Machine installation and daemon protocol repair use the owning server as the
distribution source: `/install/version` reports the server package/protocol and
`/install/omnyo-app.tgz` serves its exact host-only package with a SHA-256 digest
and strong ETag. That package contains the daemon, its workers and native
dependencies, and the bundled `omnyo` CLI; it omits the server and web app. The
installer verifies the digest and skips the download and npm install when its
recorded installed digest receives `304 Not Modified`. When the package route is
missing, the installer stops; it never installs from the npm registry. Any other
`/install/` path, including the retired `/install/bb-app.tgz`, returns a 410 JSON
error instead of the web app. When the server cannot prepare
the package, the route returns a generic reason and a diagnostic ID, and the
installer prints them; the full exception is logged with that ID as "Host
package download failed". It
installs the package under the machine's Omnyo data directory rather than npm's
system-wide prefix, so enrollment needs neither `sudo` nor a global npm configuration.
Installed services enable `--auto-update`; remove that flag from the launchd
plist or systemd user unit and reload the service to opt out. Updates only move
to a newer server protocol, retry failures with a persisted exponential backoff
from 5 seconds to 5 minutes, and never downgrade a daemon. Settings → Machines
and `omnyo machine retry-update <id-or-name>` can bypass the current backoff after
a transient failure.

## Sidebar preferences

Sidebar and Info panel layout preferences, and the model picker's favorites and
hidden models, are stored on the server in a keyed registry so every window,
device, and the CLI read the same value. Each key has a typed
schema, a default, and a revision that increments on every write. Writes name
the revision they expect and receive `409 ui_preference_conflict` when another
client wrote first, so a stale window cannot silently clobber a newer value.

| Key                                  | Value                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `sidebar.organizationMode`           | `project`, `chronological`, or `machine`                                                                         |
| `sidebar.threadGrouping.environment` | `auto`, `true`, or `false`                                                                                       |
| `sidebar.chronologicalSort`          | `updated`, `created`, `alpha`, or `none`                                                                         |
| `sidebar.sectionOrder`               | Section id list for **By project**                                                                               |
| `sidebar.manualSectionOrder`         | Section id list for **Manually**                                                                                 |
| `sidebar.machineSectionOrder`        | Section id list for **By machine**                                                                               |
| `sidebar.hiddenGroups`               | Legacy project, custom section, and machine ids migrated once into the Thread list plugin                        |
| `sidebar.footerOrder`                | Footer action order                                                                                              |
| `sidebar.hiddenFooterItems`          | Footer actions moved into More, plus `pinned:<key>` built-in actions added to the footer                         |
| `sidebar.pluginPanelOrder`           | Rail destination order                                                                                           |
| `sidebar.visiblePluginPanels`        | Rail destinations shown, or `null` for every destination                                                         |
| `sidebar.threadListProvider`         | Plugin key or `__automatic__` (default)                                                                          |
| `infoPanel.collapsedSections`        | Collapsed thread Info panel sections (`commits`, `uncommittedChanges`, `childThreads`, `forks`, `threadStorage`) |
| `modelPicker.favorites`              | Ordered favorite provider, model, reasoning, and tier objects ([Model picker](#model-picker))                    |
| `modelPicker.hiddenModels`           | Object of provider id to hidden model id lists                                                                   |
| `modelPicker.footerFavorites`        | Show favorites as the composer's model switcher, `true` (default) or `false`                                     |

The sidebar thread list defaults to `__automatic__`: the first installed thread list
plugin other than the bundled Thread list plugin (`thread-list/thread-list`), or the
bundled plugin when there is none. Installing a thread list plugin therefore switches
to it. Legacy `__builtin__` selections resolve to the bundled plugin; other plugin
selections are preserved.
Use `omnyo settings ui reset sidebar.threadListProvider` to restore Automatic, or
`omnyo settings ui set sidebar.threadListProvider <plugin-id>/<slot-id>` to select
another plugin. The SDK exposes the same setting through `uiPreferences`.

A vertical rail of destinations sits on the left edge of the sidebar on every
screen size. Home is at the top and returns to the last thread; the visible
destinations (Plugins, Skills, and plugin panels) follow; More holds hidden
destinations and Customize rail; Settings is at the bottom. Customize rail
makes the destination icons wiggle: drag them (or press Alt+Up/Down) to reorder,
and switch destinations on or off in the popover beside them. New thread sits in
the sidebar header and cannot be hidden. The list beside the rail swaps between the thread list,
Plugins, Skills, and Settings, and collapsing the sidebar hides that list and
leaves the rail. `sidebar.pluginPanelOrder` and `sidebar.visiblePluginPanels`
order and show or hide rail destinations.

In the macOS desktop app, wide windows add a title bar holding the window
controls, Back and Forward, and the sidebar toggle. It shares the rail's
background, and the sidebar and page sit in a card below it. On narrow windows
and phones the rail sits inside the drawer: Home, Plugins, Skills, and Settings
swap the list beside it and leave the drawer open, and a plugin page closes it.

New installations default to Custom (`chronological`) for `sidebar.organizationMode`.
Migrated installations with existing projects, threads, or UI preferences fall back
to By project (`project`). Explicit server choices take precedence over legacy
browser choices, which take precedence over this installation fallback. Reset
saves the installation fallback as an explicit choice.

The built-in sidebar defaults to Active, including threads with saved messages.
Filter selects Active and Archived and remembers the selection in this browser,
not in the server-backed preferences or SDK/CLI. There is no separate
Drafts section or filter; saved messages remain in their owning thread. The
selected archived threads retain their section, project, machine, and pin placement.
Choose Filter in a sidebar header's combined actions menu to change the selection.
The combined menu offers Organize, Sort by, and Filter.
Organize retains its Sections choices and Groups → By environment toggle.
Desktop archived rows have a persistent Unarchive icon
that restores the thread without navigating away.
Archived loads pages only while selected.
Plugin sidebar replacements own their rendering.

The palette's Filter independently selects Active and Archived before
and after typing. It defaults to Active and remembers its selection in this
browser only; it is not configurable through SDK/CLI.
Active includes threads with saved messages. Search threads retains the existing
title and conversation search behavior and opens the owning thread.
Archived loads a bounded list in most-recently-archived order only while selected.
Search uses the existing
ranked Active/Archived response and displays the selected groups, with six initial
rows in one group or three each when both are nonempty, plus Show more.

`sidebar.threadGrouping.environment` decides whether two or more sibling threads
that share one worktree environment collapse into a single worktree row inside
their section. `true` groups them and `false` keeps every thread on its own row,
in every organization mode. The default, `auto`, groups them in **By project**
and **By machine** and leaves them flat in **Custom**, which is how each mode
behaved before the preference existed. Set this preference through Organize →
Groups → By environment, settings, or
`omnyo settings ui set sidebar.threadGrouping.environment true`; an explicit
`true` or `false` applies to every mode.

Each `sidebar.threadGrouping.*` key toggles one grouping dimension
independently, so a future dimension adds a key rather than changing this one.

Read and write them with:

```sh
omnyo settings ui list [--json]
omnyo settings ui get <key> [--json]
omnyo settings ui set <key> <value> [--json]
omnyo settings ui reset <key> [--json]
```

`set` takes a plain string for enum and provider keys and JSON for lists,
objects, numbers, and `null`, for example `omnyo settings ui set sidebar.organizationMode machine` or
`omnyo settings ui set sidebar.sectionOrder '["threads","pinned","projects"]'`.
It reads the current revision first and retries once on a conflict. `reset`
writes the default and advances the revision. The SDK exposes the same
operations as `sdk.system.uiPreferences.list()`, `.set({ key, value,
expectedRevision })`, and `.reset({ key })` over `GET /preferences/ui`,
`PUT /preferences/ui/:key`, and `DELETE /preferences/ui/:key`. Every write
broadcasts a `ui-preferences-changed` system change to connected clients.

The sidebar waits for these values alongside the project list, so it never
paints a default layout that then snaps to the saved one. The first client to
reach a server that has never stored a key uploads the value it finds in the
old browser storage once, then deletes that copy, so an existing layout
survives the upgrade; a second device that loses that race adopts the server
value. A change on one device reaches every other connected window through the
`ui-preferences-changed` broadcast without a reload.

Sidebar width and open state stay in the browser because they depend on the
window size, and each browser tab or desktop window keeps its own. Collapsing or
resizing the sidebar in one tab leaves every other open tab alone; a newly
opened tab or window starts from the most recent choice made anywhere in this
browser.

### Thread-list visibility

Choose **Hide from list** in Threads, a project, custom section, or machine's menu to
move it into **More**. Its menu in More offers **Add to list** to restore it.
**Customize list** manages visibility and order for the current
organization. Hiding a group preserves its threads, saved order, and collapse
state; pinned threads stay in Pinned. Hidden work remains reachable through More,
search, and direct links. More shows activity without automatically restoring
hidden groups.

The Thread list plugin's `hiddenGroups` preference defaults to `[]` and accepts `threads`,
`project:<projectId>`, `section:<sectionId>`, and `machine:<hostId>` keys
(`machine:no-machine` for the unassigned machine group). Each organization uses
only its matching keys; `threads` applies to every organization. Pinned cannot
be hidden. Duplicate keys are deduplicated; unavailable IDs are retained
without creating sidebar rows, and new groups default to visible.

```sh
omnyo thread-list prefs get hiddenGroups
omnyo thread-list prefs set hiddenGroups '["threads","project:proj_example","section:sec_example"]'
omnyo thread-list prefs reset hiddenGroups
```

`set` replaces the complete list across organizations, so include any existing
keys you want to keep hidden. `reset` restores the default empty list and shows
every group. The plugin's `setPreference` and `resetPreference` RPCs expose the
same operations to its app client.

### Thread row actions

**Customize row actions**, in a thread row's actions menu, picks
the quick-action buttons a thread row shows on hover, left of its actions menu.
It turns that row's quick actions into three editable slots in place, with the
rest of the list still visible; click a slot to pick an action for it, or Hide
to empty a filled slot. Picking an action that is already in another slot swaps
the two. Drag a filled slot onto another to reorder them. Hiding every slot
leaves only the actions menu. Done, Escape, or a click elsewhere finishes;
each change saves immediately.
Archived rows keep their unarchive button regardless of this setting.

The Thread list plugin's `rowActions` preference stores up to three thread
action keys in display order and defaults to `["omnyo--core/archive"]`. Omnyo's
keys are `omnyo--core/split`, `omnyo--core/newThreadInEnvironment`,
`omnyo--core/copyLink`, `omnyo--core/read`, `omnyo--core/pin`,
`omnyo--core/shelve`, `omnyo--core/rename`, `omnyo--core/archive`, and `omnyo--core/delete`; the thread
list's own Move to section is `thread-list/move`, and other plugins add `<pluginId>/<actionId>`.
Bare legacy ids (`pin`, `archive`, `move`, …) and `core/<id>` keys are accepted
and migrate to their current keys. Any other owner's key is kept verbatim and
stays unresolved until a plugin registers it. Duplicates are deduplicated. A key
whose action is hidden for a row (`omnyo--core/split` for the thread in view,
`thread-list/move` for a thread that cannot move) or whose plugin is not
installed is skipped on that row. `omnyo--core/split` reads Focus split for a
thread open in another split pane. `thread-list/move` opens a menu of sections.

```sh
omnyo thread-list prefs get rowActions
omnyo thread-list prefs set rowActions '["omnyo--core/pin","omnyo--core/copyLink","omnyo--core/archive"]'
omnyo thread-list prefs set rowActions '[]'
omnyo thread-list prefs reset rowActions
```

### Sidebar footer

The footer shows as many icons as fit the sidebar's width, followed by an
always-available More menu. More lists hidden actions and actions that don't
fit, plus Customize footer and Hide footer. Hide footer moves every action into
More, leaving only the More button; the same menu item then reads Show footer,
which shows them again. Customize footer opens the same named action rows used in
Settings → Appearance → Footer actions. Use each switch to show or hide an action
and its drag handle to reorder. Removing an action preserves current overflow;
showing another action is disabled while a width-limited footer has no room.
Escape cancels an active reorder first; another Escape closes the editor.
Customize footer and Customize sidebar close each other. Right-click an action
and choose Hide from footer or Customize footer. Hiding an open disclosure closes
it; selecting it from More opens it again. Width overflow never changes saved
visibility.

On the desktop app footer, the cog opens Settings directly. A separate More (⋯)
button holds hidden plugin actions, Report a bug, Customize footer and Hide footer.
Mobile apps is available in Settings → Mobile and can still be pinned with the
footer editor; it is omitted from the default desktop More menu. Built-in actions
(`builtin:mobile`, `builtin:report-bug`) are pinned with a `pinned:<key>` entry in
`sidebar.hiddenFooterItems`. Plugin actions stay in the footer unless you hide them.

The UI preferences `sidebar.footerOrder` and `sidebar.hiddenFooterItems` contain
stable IDs: `builtin:mobile`, `builtin:report-bug`, and
`plugin:<encoded pluginId>/<encoded registrationId>` (URI-encoded components).
Unknown and disabled-plugin IDs are retained across reloads; new actions default
visible. The existing SDK UI preferences and CLI manage the same values:

```sh
omnyo settings ui set sidebar.hiddenFooterItems '["builtin:report-bug"]'
omnyo settings ui set sidebar.footerOrder '["builtin:report-bug","builtin:mobile"]'
omnyo settings ui reset sidebar.hiddenFooterItems
```

`set` replaces the whole list. Include any `pinned:<key>` entries you want to keep,
or the built-in actions are no longer pinned to the footer.

## Thread splits

Thread splits enable up to eight panes in the app's multi-pane thread view and
its sidebar, menu, and keyboard split controls. Edge placement creates panes
through the eighth pane; at the eight-pane limit, opening a new thread with an
edge placement replaces the focused pane. Every pane header can temporarily
maximize that pane without unmounting or resizing the underlying split tree;
the same control restores the exact arrangement. Maximization follows focus and
newly opened panes, closing the maximized pane restores the surviving layout,
and both the split tree and maximized pane restore after reload. Compact
viewports show the ordinary single-page surface while preserving that desktop
layout state.
It also enables explicit split placement through
`omnyo thread open <thread-id> --split right|down|left|top|replace` and the matching
SDK request, plus pane presentation controls through
`omnyo thread pane maximize|restore|toggle|spotlight|clear-spotlight [thread-id]` and
`sdk.threads.paneAction({ threadId, action })`. Pane actions apply only when the
target thread is already open in a multi-pane app window; the response reports
how many connected clients received the broadcast. `spotlight` focuses the
target pane and persistently dims the others; `clear-spotlight` focuses it and
persistently restores undimmed splits.

## Account Pooler

Account Pooler is enabled on fresh installations. Claude Code uses its own
sign-in on the session machine for subscription chats. Account Pooler accepts
explicitly added Anthropic API keys for Claude routing. Older pooled Claude
subscription entries remain listed for reference and removal, with routing disabled.

```sh
printf '%s\n' "$ANTHROPIC_API_KEY" | omnyo pool account add --provider claude --api-key-stdin
omnyo pool account add --provider codex --login
omnyo pool account login-poll --session <id>
omnyo pool account add --provider codex --import
omnyo pool account refresh <id>
```

The Codex login command prints a ChatGPT device verification URL, one-time
code, session ID, and an `account login-poll` command. The same login is
available from **Sign in to Codex** in Account Pooler settings. The Codex
import path uses the Omnyo server host's native Codex login.

Use `--api-key-stdin` to pass an Anthropic API key securely. It reads one
non-empty key. The compatibility form `--api-key <key>` exposes the key in
process arguments, shell history, and agent transcripts.

The plugin stores account metadata in its KV store, usage observations in its
SQLite database, and supported credentials in per-account protected secret
storage. The hub gives eligible sessions a provider route and a machine-scoped
token. Codex uses `CODEX_OPENAI_BASE_URL` and `CODEX_POOL_AUTH_TOKEN` without
editing its config file. Image generation and editing use the same route.
Rotate a machine token with `omnyo pool token rotate --machine <id-or-name>`.
The previous token remains valid for ten minutes so existing requests can
finish. `omnyo pool status` reports usage and recently routed chats.

Use `omnyo pool routing <claude|codex> --off` to turn routing off for one
provider and omit `--off` to restore it. For one chat, use
`omnyo pool bypass <thread-id>` or `omnyo pool bypass <thread-id> --off`.
Use bypass to continue a chat with Claude Code's sign-in if Account Pooler
cannot confirm that the chat previously used an API key.
Manage account state through `omnyo pool account list|enable|disable|remove|priority|refresh`.

For Claude subscription quota, open `/usage` in Claude Code. Omnyo still
reports Claude sign-in status. Composer Predictions uses Codex for every chat
provider.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after 65 idle minutes,
and the pool retains the 4,096 most recently used pins.

Use the up/down arrows in Account Pooler settings, or
`omnyo pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `omnyo pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

Plugin-owned configuration values control routing. `switchThreshold` defaults
to `0.98` and sets the preferred shared or model-family quota fraction for new
conversations. Provider-allowed included quota above that threshold remains
usable before paid fallback.
`anthropicUpstreamBaseUrl` defaults to `https://api.anthropic.com` and
`codexUpstreamBaseUrl` defaults to
`https://chatgpt.com/backend-api/codex`. Codex uses the hub's HTTP Responses
and models routes; the hub forwards each request upstream over HTTPS SSE
without keeping session state. The models route also adds the models that other
enabled accounts' plans offer, from per-account lists the pool keeps for seven
days or until the account's plan changes, and Responses requests for such a
model go to an account whose list includes it. Both URL values exist only for tests and QA
with a controlled fake upstream. Inspect or update the full plugin KV-backed configuration with:

```sh
omnyo pool config
omnyo pool config set switchThreshold 0.98
omnyo pool config set anthropicUpstreamBaseUrl http://127.0.0.1:9000
omnyo pool config set codexUpstreamBaseUrl http://127.0.0.1:9001
```

Upgrading from an Account Pooler build that stored these values through
`api.settings` resets the threshold and both QA-only upstream overrides to
their defaults. Those old values are not migrated.

## Omnyo connect

Remote access makes this Omnyo server reachable at `https://<handle>.omnyo.link`
once it is signed in to a omnyo.link account. Two builtin plugins share the
work:

- **Omnyo account** (`plugins/omnyo-account/`) signs this Omnyo server in and holds the
  server credential in its plugin KV (in `app.db`). It never returns the
  credential; the connect plugin makes its hosted requests through the
  `omnyo-account.v1.fetch` rpc, which serves only connect's `/api/connect/`
  paths. Sign in with `omnyo account login` (a omnyo.link link and
  code to approve in any browser) or Settings → Omnyo account. `omnyo account status`
  shows the account, including a paired Omnyo server whose account hasn't loaded yet
  (it keeps retrying). `omnyo account logout` revokes the credential on
  omnyo.link and forgets it; if omnyo.link can't be reached, it still signs out
  locally and says the server wasn't revoked.
- **connect** (`plugins/connect/`) uses Omnyo account's credential. Its
  background service holds the tunnel: it dials the gate with the server
  credential it reads from Omnyo account, proxies relayed requests to the
  server's own loopback (which serves the SPA, `/api`, and `/ws`), and
  reconnects with capped backoff. When the gate refuses the credential, Omnyo
  account checks it with omnyo.link and signs out if it was revoked. It also
  keeps a copy of the pairing where Omnyo
  builds from before Omnyo account look for it, so downgrading keeps remote
  access. The tunnel lives as long
  as the Omnyo server runs and re-establishes on restart; there is no foreground
  client.

The omnyo.link dashboard's pairing command,
`omnyo connect --code <code> --server https://<handle>.omnyo.link`, signs this Omnyo server
in like `omnyo account login --code <code>` and also turns remote access back on
if it was off. On a machine without Omnyo, install the `omnyo-app` launcher with
the verified private release installer, then run `omnyo connect …`. `--server` and `--base-url` (on both
`omnyo connect` and `omnyo account login`) accept only `https://omnyo.link` and
`https://stg.omnyo.link` origins (a `--server` URL is reduced to its apex);
a development build also accepts `http://omnyo.localhost:<port>`.

The connect plugin's `remoteAccess` setting turns remote access off and on
without signing out. `omnyo connect off` closes the tunnel and machine shares and
keeps the account signed in; `omnyo connect on` reopens them. The same setting is
the Remote access switch in Settings and
`omnyo plugin config connect set remoteAccess <true|false>`. `omnyo account logout`
forgets the pairing, and disabling the plugin (`omnyo plugin disable connect`)
cuts off all remote access until `omnyo plugin enable connect`.

`omnyo connect status` shows the connect state and every share's host and URL.
`omnyo connect expose <port>` run from a thread shares that thread environment's
enrolled host. Server-host URLs remain
`https://<server-label>--<port>.omnyo.link`; other machines use
`https://<machine-label>--<port>.omnyo.link` and proxy directly through the
owning daemon. Outside a thread the command defaults to the server host;
`--host <name-or-id>` overrides host resolution. Access requires the owner's
omnyo.link session (not a public link). `omnyo connect unexpose <port>` and
`omnyo connect shares` use the same host resolution and accept the same `--host`
override. Their JSON rows include `hostId`, `hostName`, `port`, and `url`;
`shares --json` also includes the resolved `host`. A machine without a live
Connect enrollment fails fast with instructions to remove and re-add it in
Settings → Machines.

The CLI commands are proxied to the plugins, and Settings → Omnyo connect
drives connect's rpc (including shared ports).

### Pairing the Omnyo mobile app

Android source builds optionally read `GOOGLE_SERVICES_JSON`, an absolute path
to the Firebase Android configuration file. Without it, they use
`apps/mobile/google-services.json` when present; without either, the app builds
without Firebase push configuration. For EAS, configure it as a file environment
variable. Android build, signing, and Play submission instructions are in
[`apps/mobile/README.md`](../apps/mobile/README.md#android-production-setup).

The Omnyo mobile app reaches a paired Omnyo server through the same connect route. It
enrolls as a connect **machine** — its own credential on the omnyo.link account,
separate from the server's pairing secret and individually revocable — so
pairing starts from the Omnyo server, not from the phone. No experiment is required.

- Settings → Mobile → **Add mobile device** mints a one-time code and
  shows it as a QR code plus copyable text with a countdown.
- `omnyo connect machine-code` prints the same code, server URL, connect apex,
  and expiry; `omnyo connect machine-code --json` returns
  `{code, serverUrl, apex, expiresAt}` (the QR encodes that JSON).

Settings → Mobile → **Paired devices** lists this server's paired devices, their pairing dates and last recorded activity. **Refresh** fetches current relay data. `omnyo connect devices --json` provides the same list to agents. This list does not report live connection status.

Scan or type the code in the mobile app. The code lasts 10 minutes and works
once. The phone then appears in the omnyo.link dashboard machine list, where you
can revoke it; every enrollment takes one of the account's machine slots
(desktop apps, remote execution machines, and phones all count), so a
machine-limit error asks you to revoke an unused device first. Both surfaces
need the experiment on, the Omnyo server signed in (`omnyo account login`), and the connect
plugin enabled; with the experiment off the panel hides the section and
`omnyo connect machine-code` exits 1 with a pointer to the toggle.

## Message editing

Message editing is available for eligible, accepted root user messages in a
Codex, Claude Code, or Pi thread, including failed or incomplete turns. Grouped
multi-message requests are not yet editable. Opening the editor does not change
history; if the thread is running, submission stops the current turn and waits
for it to settle before atomically replacing that message and every later turn
while keeping workspace changes.

## Experiments

Experiments have no Settings page. Change them with
`omnyo settings experiment <key> <true|false>` or the SDK. Each experiment's
description states its shipped default. Omnyo stores only the experiments you
set; the others follow the shipped default.

Omnyo releases restorable provider sessions after 10 idle minutes. The daemon
checks for these sessions every minute. Active turns, commands, agents,
workflows, and monitors keep their sessions loaded.

Long timelines and large expanded timeline details retain stable
height-preserving wrappers while mounting only rows near their active
scrollport.

The `serverMove` experiment is off by default. When enabled, Settings → Machines
offers Move server here, and the server accepts `omnyo server move`,
`omnyo server export`, and old server copy deletion (`POST /api/v1/server/move`,
`/server/move/check`, `/server/export`, `DELETE /api/v1/hosts/:id/old-server-copy`).
While it is off those routes return 403 `server_move_experiment_disabled`;
move status and cancel stay available. Toggle it with
`omnyo settings experiment serverMove <true|false>`.

The `compactExpiredCache` general setting is on by default. It reports
`compactionOfferAt` on a thread's context usage (timeline `contextWindowUsage`
and `omnyo thread context`) once the provider has reported a prompt-cache
lifetime, the provider supports manual compaction, and the context holds at
least 100k tokens. After that time the composer offers to compact first; the
send then passes `compactFirst`, so the server runs `/compact` and queues the
message behind it. Choosing Keep history sends normally for that one message.
No offer appears while the thread's latest request is a compaction that is
running or completed; a compaction that failed or stopped keeps the offer.
Turn it off in Settings → General or with
`omnyo settings general compactExpiredCache false`.

The `autoCompactBeforeCacheExpiry` experiment is on by default. Omnyo compacts
an idle Claude Code chat while its one-hour prompt cache is still warm. The
compaction then reads the context at the cache-read price, and the owner's next
message reads only the summary. A server sweep checks every minute
and compacts a chat once, between 50 and 55 minutes after its last provider
request, when all of these hold:

- The provider is Claude Code with manual compaction, and its latest usage
  reports a one-hour cache. A turn that ended in overage reports five minutes.
  Accounts in overage or on credits are skipped.
- The context holds at least 200k tokens.
- The chat is a visible, idle root chat that the owner started and last
  messaged. Child, agent-launched, plugin-created, automation, archived and
  shelved chats are skipped.
- Its work label is open, external or needs-you. It has no pending question,
  queued or scheduled message, live wait, or start, stop or update in progress,
  and its environment and machine are ready.
- Its latest request is not already a compaction, and fewer than two automatic
  compactions are running.

The compaction is a maintenance turn with initiator `system`. It keeps the last
turn's model, reasoning level and service tier. It does not mark the chat
unread, write an Inbox receipt, send a push, or change its readiness, Tidy
decision or composer suggestion. The timeline shows "Compacted before the prompt
cache expired" and then "Context compacted". A message sent meanwhile queues
behind the compaction. A failed or stopped compaction leaves the chat idle with
its full history and says so in the timeline.

`omnyo thread context THREAD_ID --json` reports
`autoCompaction: { state, at, reason, cacheReadShare }`. `state` is `scheduled`
(`at` is the due time; `reason` is `running` while the compaction runs),
`skipped` (`reason` is `lapsed` when the window passed while the server slept,
and `at` is the missed due time), `disabled` (`reason` names the rule that
blocks it, such as `opted-out`, `experiment-off`, `small-context` or
`queued-message`), `done`, `failed` or `stopped`. A `done` outcome reports `cacheReadShare`, the
share of the compaction's input read from the prompt cache, or `null` when
Claude Code reported no usage for it. While a compaction is scheduled, the
timeline `contextWindowUsage` also carries `autoCompactionAt`; for a chat that
is opted out but would otherwise be compacted, it carries `autoCompactionAt`
with `autoCompactionOptedOut: true`, so the composer chip can turn automatic
compaction back on.

Opt one chat out with Keep full history on the composer's compaction chip,
`omnyo thread auto-compaction THREAD_ID --off`, the SDK's
`threads.experimental_setAutoCompaction({ threadId, enabled: false })`, or
`PUT /api/v1/threads/:id/auto-compaction` with `{ "enabled": false }`. Use
`--on` or `true` to opt it back in. Turn the feature off with
`omnyo settings experiment autoCompactBeforeCacheExpiry false`.

## Thread Timeline Window

Timeline pages select conversation groups using user-message anchors. The
`OMNYO_FF_TIMELINE_WINDOW_EVENT_BUDGET` setting (default 1500) guides the number
of groups selected and limits the number of content leaves returned. Grouping
loads complete selected turns, their delegation descendants, and lifecycle
context. The setting is not a hard limit on query bytes, event count, or CPU:
one large turn can require substantially more work.

Pages target 4 MiB of rendered rows. An oversized group is continued by an
opaque content cursor after grouping. Turn/delegation ancestors keep their
canonical IDs, source ranges, and summary counts while their children are
paged. A single indivisible row may exceed the byte target; its content is not
silently discarded. Retained tool-output previews and full-output availability
continue to use the large-output sidecar policy.

A walk is bound to its initial history sequence, grouping version, and display
options. Appends do not move that snapshot. Edits, deletions, or out-of-order
insertions invalidate its cursor, including after a server restart. A new
latest response replaces the client's loaded snapshot when its identity
changes; old page responses cannot merge into it. This conservative behavior
also handles late events that change earlier grouping. It can require loading
older pages again during live updates.

Older activity loads as the user scrolls. `omnyo thread log --all` walks one
snapshot and joins repeated summary ancestors; rerun it if an edit invalidates
the walk. The API and SDK contract is described in
[timeline-pagination.md](timeline-pagination.md). The budget is a server-start
operator setting, not an app preference.

Timeline builds slower than 150ms log `Thread timeline build blocked the event
loop` with a per-stage breakdown, and event-loop stalls over 500ms log `Event
loop stalled`. Both log at `info`, so they are visible in `~/.omnyo/logs/` without
raising `OMNYO_LOG_LEVEL`.

## Plugins

Plugins are on by default. Builtin plugins ship with Omnyo and install on fresh
installations. Core builtins, including connect, can be disabled but not
removed. The included plugins from Omnyo's plugin collection
(`origin: "omnyo-plugins"` in `apps/server/src/services/plugins/builtin-registry.ts`)
can be removed in Settings or with `omnyo plugin remove <id>`, which deletes
their settings, secrets, and schedules like any removal. A removed included
plugin stays removed across restarts and Omnyo updates until you install it
again from Omnyo Official with `omnyo plugin install <name>` or Plugins → Browse
plugins. User-installed plugins come from `omnyo plugin install` or the bundled
official store.

Plugin state lives under the data dir:

```
<dataDir>/plugins/<id>/data.db     Per-plugin SQLite database
<dataDir>/plugins/<id>/secrets/    Secret settings and the plugin HTTP token
<dataDir>/plugins/<id>/logs/       api.log output (plugin.log, JSONL, rotated
                                   at 5MB; read with `omnyo plugin logs <id>`)
<dataDir>/plugins/git/, npm/       Managed installs for git:/npm: sources
<dataDir>/marketplaces/staging/    Throwaway checkouts a git: marketplace
                                   refresh reads its manifest from, deleted
                                   as soon as the catalog is stored
<dataDir>/skills-generated/        Server-generated skills (the
                                   plugin-commands skill listing plugin CLI
                                   commands, injected into agent threads)
```

Omnyo's store-only official plugins (Modal Sandbox, Docs, Memory, Tasks, and Theme Preview) ship bundled
inside the app and install from the local bundled copy — no network, no remote catalog.
Discover them with `omnyo plugin search` or Plugins → Browse plugins; users
cannot add, remove, or configure entries in this bundled catalog. Removing an
installed plugin keeps its catalog entry, so it can be installed again. Installed official
plugins are pinned to the bundled copy and update with Omnyo app releases. Local
path installs remain available directly through `omnyo plugin install ./path` or
`path:...`, and direct `npm:`/`git:` installs stay supported.

Marketplace catalogs and their validated icon bytes live in the Omnyo database,
not on disk. `omnyo marketplace add|list|refresh|remove` and Settings → Plugin
marketplaces manage them; the reserved `omnyo-official` marketplace ships with
the app and cannot be added or removed. Adding a marketplace
installs nothing, and removing one keeps its installed plugins as direct
installs. A `git:` marketplace reads `marketplace.json` from the repository
root, or from the relative directory given with
`omnyo marketplace add --subdirectory <relative-path>` (the Subdirectory field in
Settings); Omnyo stores that directory and reuses it on every refresh.

### Multi-plugin repositories

A repository can hold several plugins. Each plugin directory keeps its own
`package.json` and `omnyo` manifest; an optional `.omnyo/plugins.json` collection
manifest at the repository root indexes them:

```json
{
  "$schema": "https://app.example.invalid/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "acme-plugins",
  "plugins": [
    { "name": "notes", "source": "./plugins/notes" },
    { "name": "status", "source": "./plugins/status" }
  ]
}
```

The file is strict: `schemaVersion` must be `1`, names match
`^[a-z0-9][a-z0-9-]*$`, unknown fields and duplicate names are rejected, and
each `source` is a repository-relative directory starting with `./` — absolute
paths, `..`, empty segments, and the repository root itself are refused. An
invalid file is rejected whole. The manifest is an index only; it never
overrides a plugin's identity, branding, entry points, or engine ranges.

Install one plugin of the repository with
`omnyo plugin install git:<url>[@<ref|semver-range>] --plugin <name>` (resolves a collection
entry) or `--subdirectory <relative-path>` (the primitive, which needs no
collection manifest). Both flags work for `path:` sources and are mutually
exclusive. Installs from the same repository and commit share one cached
checkout, and the selected subdirectory is recorded with the install, so
`omnyo plugin outdated`, `update`, rollback, and `remove` act per plugin. A
repository that has a collection manifest and is not a plugin itself refuses
an unselected install and lists its entry names.

### Plugin updates

Bundled builtin and official plugins update with Omnyo app releases. For direct
`git:`/`npm:` installs, update application is manual: `omnyo plugin outdated` or
the "Check for updates" key on the Plugins page checks tracking sources, and
`omnyo plugin update <id>` / `omnyo plugin update --all` or the "Update x.y.z" pill
applies compatible candidates. The server also checks every installed plugin
every 6 hours (the first check runs when any plugin has no recorded check or
the oldest one is older than 6 hours), at most four plugins at a time, and a
manual check joins a sweep already in flight; a check only records what is
available and never installs or runs plugin code. There is no automatic plugin update
application or update audit feed. Reinstalling an already-installed managed plugin is
refused — use `omnyo plugin update`. Before activation Omnyo snapshots the plugin
database, host-managed settings/storage/schedules, secrets, and registration.
A failed activation restores that snapshot and records the latest failure on
the plugin so it can be surfaced as needing attention.

### Claude Code provider

Omnyo forwards only two environment variables to the Claude Code CLI, stripping
every other. `OMNYO_CLAUDE_CODE_EXECUTABLE` picks the `claude` binary;
`CLAUDE_CODE_OAUTH_TOKEN` authenticates it on a machine with no interactive
login, such as a CI runner. Mint the token with `claude setup-token`, which is
long-lived where the credentials from `/login` are not. A logged-in machine
needs neither. The bridge also sets Claude Code's OpenTelemetry log variables
itself, pointed at its own loopback receiver, to measure each `/compact` turn's
usage; a thread's own environment overrides win. See
[provider-bridge-protocol.md](provider-bridge-protocol.md).

### Ask User Question plugin

The builtin Ask User Question plugin keeps an unanswered question card open for
30 minutes by default. When it expires, the agent receives a timeout result and
the card closes. Choose `1 hour`, `4 hours`, `8 hours`, `24 hours`, `3 days`, or
`7 days` under the plugin settings, or configure it from the CLI:

```bash
omnyo plugin config ask-user-question set questionTimeout "24 hours"
```

The setting applies to questions asked after it changes. A server restart still
closes every open card.

### Provider retry plugin

The builtin Provider retry plugin is enabled on fresh installations. When a turn
fails on a structured Codex or Claude Code subscription-window limit that
reports a reset time, it queues that turn after the window opens. It also
retries structured provider overloads with exponential backoff and jitter.
Prior output or tool activity does not block recovery. If the provider accepted
the failed input, core sends an agent-only continuation; if it rejected the
input before starting, core re-sends the original message as agent-only. Disable
the plugin under Settings → Installed plugins or with
`omnyo plugin disable provider-retry`.

It never blocks a send. A remembered rate limit is a stale picture of the
provider's state, so the plugin never refuses a dispatch on one — if you raised
your plan or the window opened early, the next send simply works. The cost is
that several threads on one exhausted subscription each fail once before each
schedules its own retry; the retries are jittered so they do not all wake in the
same instant. Overload retries start after 5–10 seconds, double their delay
after each failure, with five total attempts for connection failures.
A model still at capacity or an account with unknown availability uses a slow
15-minute recheck, with up to a minute of jitter. Known reset times use the
reported availability instead. The `maximumWait` setting defaults to `No limit`;
explicit `6 hours` and `24 hours` settings still cap waits and slow rechecks.
Configure the cap under the plugin settings or from the CLI:

```bash
omnyo plugin config provider-retry set maximumWait "24 hours"
```

A pending retry is a queued row on the thread, not an in-process timer, so it
survives a restart and shows its reason and time on the queue card above the
composer. The recovery card shows the next attempt and can send the same retry
now or select another model from the same provider. Inspect them with
`omnyo provider-retry status`, cancel one on that card or with
`omnyo provider-retry cancel <thread-id>`, or run
`omnyo provider-retry retry <thread-id>` to send it now instead of waiting. Limits
that do not reset on a clock — credit and spend-control exhaustion — schedule
nothing, because waiting does not fix them.

### Workflows plugin

The builtin Workflows plugin is disabled on fresh installations. Enable it
under Settings → Installed plugins or with `omnyo plugin enable workflows`. Its six
settings are bounded integers, edited with numeric inputs under Plugins →
Installed plugins or with `omnyo plugin config workflows set <key> <value>`:

| Key                    |    Default |       Allowed range | Behavior                                               |
| ---------------------- | ---------: | ------------------: | ------------------------------------------------------ |
| `maxActiveRuns`        |        `4` |            `1`–`32` | Concurrent runs across the plugin; changes apply live. |
| `maxConcurrentAgents`  |        `8` |            `1`–`64` | Concurrent agent calls within one run.                 |
| `maxAgentCalls`        |      `100` |          `1`–`1000` | Total agent calls within one run.                      |
| `totalRunTimeoutMs`    | `86400000` | `60000`–`604800000` | Maximum total run duration in milliseconds.            |
| `retentionDays`        |        `7` |          `1`–`3650` | Days to retain completed workflow data.                |
| `maxNotificationBytes` |    `16384` |     `1024`–`262144` | Maximum UTF-8 size of a completion notification.       |

The five settings other than `maxActiveRuns` are snapshotted into each new run.
Settings changes do not require a plugin reload.

`omnyo plugin install npm:<package>[@<version|tag|range>]` uses Omnyo's shipped npm
and its running Node runtime; neither executable needs to be on PATH. Packages
are installed with `--ignore-scripts`. Git plugins also use this npm with
lifecycle scripts disabled and `--omit=dev --omit=optional`. Plugins may keep
normal development dependencies in their manifests; npm resolves these but
does not install them. They may depend on third-party runtime packages; Omnyo
then builds both their server and frontend bundles. `node_modules` is
retained, because a dependency can load data files that bundling cannot
inline. A committed `dist/` is always replaced by the bundles Omnyo builds.
Dependency resolution and bundling run on install and update-apply only —
never on an update check, which reads the manifest and stops. An omitted npm
spec tracks the newest compatible stable release, ranges track within the
range, dist-tags track the tag, and exact versions are pinned. A bare HTTP(S)
Git repository URL or `git:<url>[@<ref|semver-range>]` requires `git`; an
omitted ref tracks the repository's default branch, explicit branches track
their head, and tags and commits are pinned. A semver range
(`git:<url>@^1.2.0`, or `@semver:<range>` to state the intent explicitly)
tracks the repository's `[<tag-prefix>]vX.Y.Z` release tags: Omnyo installs the
highest release the range allows, excludes prereleases unless the range names
one, records the tag and the commit it pointed at, and refuses that tag later
if it moved. `--tag-prefix <prefix>` ranges over one plugin's tags in a
multi-plugin repository. A bare range that is also a literal branch or tag
name fails the install and asks for `@semver:` or `@ref:`. Local
path installs register the directory in place and never delete it. Builtin
plugins use `builtin:<name>` and ship with Omnyo unless removed. Managed
(`git:`/`npm:`) installs
refuse plugins whose optional `engines.omnyo` or `engines.omnyoPluginSdk` ranges
do not match the running Omnyo/SDK, or whose `dist/*.meta.json` plugin identity
does not match the package manifest; installing a non-builtin source whose
derived id collides with a builtin name (automations, connect,
custom-instructions, inline-vis, secrets, workflows) is also refused.

`engines.omnyoPluginSdk` is a floor, not a ceiling. Omnyo reads the lowest version
the range allows and runs the plugin on any SDK at or above it within the same
major, so a caret range such as `^0.4.1` keeps working after the SDK moves to
`0.4.3` or a later `0.x`. Only a plugin that asks for a newer SDK than this Omnyo
provides, or one pinned to a different major, is incompatible. Declare the
oldest SDK you need (`>=0.4.3`); a breaking plugin API change bumps the major.

The same tracking intent drives updates: `omnyo plugin outdated` checks for
compatible candidates (and reports blocked incompatible newer releases);
`omnyo plugin update <id>` / `omnyo plugin update --all` applies them. Pinned source
intent is never widened by update; remove and reinstall to choose a different
source intent. Dev builds (Omnyo `0.0.0`) do not enforce `engines.omnyo` and annotate
that on check results.
Update confirmation matches install (full-trust code; `--yes` skips; non-TTY
refuses without it). Plugins are full-trust code running inside the Omnyo server
process: they can read all local Omnyo data, including other plugins' secrets.

## Secret vault

The server seals its credentials with AES-256-GCM: `auth-secret`,
`machine-environment-key`, plugin secret settings, plugin HTTP tokens and the
values plugins keep through `api.experimental_secrets`. The key is a random
32-byte vault key for each data directory. `<data dir>/vault/vault.json` records
which key store holds it. On first start the server seals any of these files
that an earlier version left in plaintext.

`OMNYO_VAULT_KEY_STORE` chooses the key store when the server creates the vault
on its first start. After that the record decides, and the variable has no
effect on that data directory.

- `keychain` is the macOS default. The key is a generic password in the login
  Keychain, service `app.omnyo.vault`. A copied disk, backup or data folder
  cannot be decrypted without the user's login password. With automatic login
  turned on, `/etc/kcpassword` on the same disk weakens this.
- `dpapi` is the Windows default. A signed-in user gets DPAPI user scope, which
  protects like the Keychain. An unattended boot task (S4U, batch or service
  logon) gets machine scope. Any process on that PC can then decrypt the key,
  and a copied whole disk carries the SYSTEM and SECURITY hives that unlock it
  offline. Machine scope protects only a copied data folder or a folder-level
  backup, so BitLocker is still needed against theft.
- `key-file` is the default on other platforms. The key sits in
  `<data dir>/vault/key-<id>` beside the ciphertext, so it gives no protection
  against a copy of the data folder. Tests, `pnpm dev` and the QA launcher use
  it because their sandboxes refuse Keychain writes.

No key store protects against processes that run as the same user. On macOS the
Keychain item trusts `/usr/bin/security`, so any same-user process, including
agents and in-process plugins, can read the key without a prompt.

When the server cannot open the vault, it stops with an error that names the
data directory, the key store and the error code (`key_unavailable`,
`key_missing`, `record_invalid`). It never creates or replaces a secret in that
case. A backup of the data directory restores its secrets only together with
the vault key, which the Keychain or DPAPI holds outside that folder.
`omnyo server export` and server moves decrypt sealed files into the archive
and leave out `vault/`, so the archive carries plaintext secrets as before. The
destination seals them under its own vault on its first start.

## Startup Flags

Use launcher flags for per-run startup details:

```bash
omnyo-app --data-dir ~/.omnyo-test --server-port 48886 --host-daemon-port 48887
```

The server listens on `127.0.0.1` by default. Set
`--server-bind-host 0.0.0.0` (or `OMNYO_SERVER_BIND_HOST=0.0.0.0`) only when a
trusted network boundary must reach the listener directly. The public API is
unauthenticated and permits command execution and file reads, so never expose a
wildcard-bound server to an untrusted network. The only accepted bind hosts are
`127.0.0.1` and `0.0.0.0`; this startup-only setting is not available through
`omnyo-app config`.

The startup `Server listening` and `app` lines show the actual listener address.
With wildcard binding they show `http://0.0.0.0:<port>`, while Omnyo's health check
and colocated host daemon continue to connect through `127.0.0.1`. That local
connection does not narrow the listener. `0.0.0.0` exposes IPv4 interfaces only;
Omnyo does not currently offer an IPv6 wildcard bind option.

The data directory is the root directory for all Omnyo-managed state: the SQLite
database, logs, host identity, thread storage, custom themes (`theme/`,
including optional Pierre / VS Code `pierre-dark.json` and `pierre-light.json`),
and
plugins. It defaults to `~/.omnyo/` for the packaged app. The `pnpm dev` source launcher derives an isolated data
directory under `~/.omnyo-dev/<checkout-instance>/` from the checkout path. The
checkout instance id is the sanitized path to the checkout, relative to your
home directory, plus a short hash suffix. Use `--data-dir` to point packaged-app
instances at different data directories for fully isolated environments.

If the default ports are already in use, set explicit ports before starting:

```bash
omnyo-app --server-port 48886 --host-daemon-port 48887
```

The Settings → Machines installer assigns every enrolled standalone host daemon
a stable local API port so it can coexist with the desktop app and with daemons
enrolled to other servers. The selected port is persisted in the machine data
directory and reused by subsequent runs. Its generated command accepts
`--host-daemon-port <port>` when an explicit port is required.

## Source Development

`pnpm mobile:apk:dev` builds the standalone Android development app, **Omnyo dev**,
with orange icons and package `app.getbb.mobile.dev`. Output is
`apps/mobile/build-output/omnyo-dev.apk`; append `-- x86_64` for an Intel emulator.
The build command sets `OMNYO_MOBILE_VARIANT=dev` for Expo configuration. Direct
Expo commands accept `OMNYO_MOBILE_VARIANT=production` (the default) or `dev`;
other values fail validation. The dev variant omits production Firebase and
HTTPS app-link registration. See [mobile build instructions](../apps/mobile/README.md#android-local-apk-and-verification).

For source development only, `pnpm dev`, `pnpm start:worktree`,
`pnpm start:worktree-remote`, `pnpm start:worktree --dryrun`,
and `pnpm start` load the repo-root dotenv
cascade. Add a repo-root `.env` only when you need to override the defaults
described above.

The standard [dotenv-cli](https://github.com/entropitor/dotenv-cli) cascade
applies to source development. `pnpm dev` loads `.env`, `.env.local`,
`.env.development`, and `.env.development.local`, then overrides the instance
selectors (`OMNYO_DATA_DIR`, server URL/port, host-daemon local API port, and Vite
port) with deterministic values derived from the checkout path. The SQLite
database path is always derived from `OMNYO_DATA_DIR`. Both the main server and
Vite app bind to loopback by default; an explicit `OMNYO_DEV_APP_HOST` still
overrides the Vite listener. Remote HTTP dev via `OMNYO_DEV_APP_HOST` also requires
`OMNYO_SERVER_BIND_HOST=0.0.0.0` for realtime updates; the Tailscale Serve HTTPS
path avoids this because WebSocket traffic goes through the Vite proxy.
`pnpm start:worktree` loads the same development dotenv cascade and uses the
same checkout-specific data directory, server port, and host-daemon port. It
builds production artifacts and serves the frontend bundle from the main
server, so there is no separate Vite listener or hot reload. Telemetry remains
disabled for this source-development command. Its worktree data directory,
ports, inherited skills, listener host, absent Vite port, and telemetry policy
take precedence over conflicting values saved in that instance's `config.json`
or `env.json`.
Add `--dryrun` to `pnpm start` or `pnpm start:worktree` to prepare through Turbo,
print the same resolved ports and paths that normal startup uses, and exit.
This writes build outputs and may repair native modules, but does not start
services, migrate instance data or require ports to be free. Normal startup
also runs Turbo preparation and preserves the command's runtime policy. See
[Prepared Worktree Restarts](debugging-and-qa.md#prepared-worktree-restarts).
`pnpm start:worktree-remote` applies the same policy while binding the main
server to `0.0.0.0` for direct access on a trusted network. The API is
unauthenticated and permits command execution and file reads, so protect the
port with a trusted network boundary such as Tailscale and a host firewall.
`pnpm start` loads `.env`, `.env.local`, `.env.production`, and
`.env.production.local`.

Production startup from source uses the same launcher policy as the packaged
app while reading build outputs directly from `apps/app`, `apps/server`, and
`apps/host-daemon`. `pnpm start:host-daemon` continues to run the packaged
`packages/omnyo-app/dist/omnyo-app.js host-daemon` entrypoint. Source-only scripts do
not own production ports or data-dir defaults.

Source checkout commands such as `pnpm omnyo`, `pnpm omnyo:dev`, and `pnpm reset`
are thin wrappers around `@omnyo/scripts`. Those wrappers force `NODE_ENV` to the
intended mode so ambient shell state does not silently retarget Omnyo.

Use `pnpm reset` or `pnpm reset:dev` to clear a data directory. These only
remove Omnyo-managed state, not provider credentials.

`OMNYO_PROVIDER_BRIDGE_RECORD_DIR=<dir>` in the host daemon's environment turns
on bridge record mode: every provider bridge writes the lines that cross its
runtime and provider wires as NDJSON under `<dir>/<providerId>/<threadId>/`.
It is a development and diagnostics knob, off by default, and never reaches a
provider child. See [provider-bridge-protocol.md](provider-bridge-protocol.md),
"Record mode", and [debugging-and-qa.md](debugging-and-qa.md). Raw recordings
can contain secrets; redact them with `scripts/provider-recordings/redact.mjs`
before you share them.

## Browser Automation runtime

Agents use `omnyo browser-automation` through its bundled skill. Screenshot results
contain temporary JPEG paths and the browser host ID; remote captures can be
fetched with `omnyo file read <path> --host <host-id> --json`. Read or copy images
before closing the session, which deletes its temporary files. Opening a
local headless session also returns a `previewDirective` that the agent pastes
into its message; Omnyo renders it inline as a live preview that expands into a
lightbox. Desktop sessions return none, because
that browser is already visible in the app. There is no setting for it;
collapse the card to pause it.

The Browser Automation plugin supports desktop attachment and headless Chrome on enrolled hosts. Cloud browsers are deferred. The plugin pins one exact `dev-browser` npm release (currently 1.0.0-rc.4) with per-platform binary digests in `plugins/browser-automation/runtime-pin.ts`; the pin, the verification steps, and the bump procedure are documented in `plugins/browser-automation/README.md`.

On each selected browser host, the plugin's host worker installs that release automatically on first use under `<plugin host dataDir>/runtime/npm/`, using the host's `npm` with scripts disabled, verifying the registry signature and SLSA provenance, downloading the matching GitHub release binary, and checking its digest before launch. Later sessions reuse the verified install without network access. Headless mode discovers installed Chrome/Chromium or uses `<plugin host dataDir>/runtime/chrome`. These files belong to the plugin host storage directory; they are not paths on the server or invoking agent host, and the user's global npm installation is never modified. No runtime sandbox-disabling setting is provided.

For isolated development smoke tests only, `DEV_BROWSER_SMOKE_BINARY` selects the absolute binary path for the runtime smoke and `DEV_BROWSER_SMOKE_CHROME` selects the absolute Chrome path. The `smoke:install` task performs a real install of the pinned release into a disposable directory. These variables do not change normal plugin runtime behavior.

## Agent guidance plugin settings

Omnyo guide is installed and enabled by default. In Settings → Installed plugins
→ Omnyo guide, `introduction` controls the Omnyo introduction, `skills` controls all
three bundled skills, and `omnyoCli`, `pluginAuthoring`, and `skillCreator` control
individual skills. All default to true. Disabling Omnyo guide removes its
introduction and skills; other plugins and independently installed skill
copies retain their own configuration.

Connect's `sendRemoteInstructions` setting ("Tell agents about remote access")
defaults to true. When false it suppresses Connect's active/recent remote-use
message without disabling sharing.

Use `omnyo plugin config <id> set <key> true|false` or the SDK's
`plugins.updateSettings({ pluginId, values })`. These settings apply when
agent configuration is next assembled, not retroactively to existing text.

### Machine server access

Machines settings expose **Server URL reachable by machines** (`machineServerUrl`)
and **Default machine access** (`defaultMachineAccess`). The URL must be HTTP
or HTTPS without embedded credentials. An unset URL falls back to
`OMNYO_EXTERNAL_URL`. The URL input appears when Manual is selected. An unset access provider selects
Omnyo connect, even when unpaired; Machines settings links to its setup. Choose
Manual (`direct`) explicitly to use your own URL. An explicit provider must
be installed and available. Configure these with `omnyo settings general
machineServerUrl <url-or-null>` and `omnyo settings general defaultMachineAccess
<provider-id-or-null>`. `omnyo settings show --json` reports the effective access
selection. Access grants serve ongoing runtime requests as well as enrolment.

Bootstrap v2 carries optional provider headers. The machine persists them as
`serverHeaders` in its private `config.json`; the launcher supplies them to the
daemon through `OMNYO_SERVER_HEADERS` as a JSON string map. These headers are private
credentials and cover enrollment, HTTP, WebSocket, and runtime proxy requests.
Direct grants omit headers. Legacy `machineCredential` configuration is translated
into the corresponding request header when loading an existing machine.

For machine enrollment, `OMNYO_DATA_DIR` selects isolated machine state instead of
`~/.omnyo-machines/<server-host>`; a reconnect command defaults to the data
directory the machine's daemon last reported. `omnyo machine enroll` refuses the default `~/.omnyo`
directory unless its `host-id` already names this machine, and it refuses a
conflicting host or server identity. Local `install-machine.sh
--start|--stop|--uninstall --host-id <id>` treats `OMNYO_DATA_DIR` (or `--data-dir`) as an
ownership assertion, not permission to act on arbitrary files: lifecycle commands
require a canonical installer-owned directory under `~/.omnyo-machines` and verify
identity and service/process ownership. Optional `--server-url` asserts the server.
Without an explicit directory, lifecycle commands locate the unique matching host.

### Machine environment

Core resolves machine contributions through
`apps/server/src/services/hosts/host-environment.ts` before dispatching setup and
teardown hooks. Ordinary setup uses `environment.attach`; explicit hooks use
`environment.hook.run`. Both carry transient `contributedEnv` values;
the daemon applies them to the hook child process. Hook progress and errors are
forwarded as-is, so contributed values printed by the child remain visible.
Machine selection and precedence stay in the server
resolver.

Settings → Environment variables is the machine environment editor. Its scope
control sits under the section header and switches between All projects and a
single project. Project settings →
Advanced settings exposes the same editor for that project, where inherited
global variables are listed read-only with an Override action. Project variables
follow the project across machines and worktrees, including the primary host.
Values are encrypted in one `environment_variables` table;
`project_id IS NULL` denotes global scope. Database migration preserves existing
ciphertext from `app_settings_values`. New ciphertext authenticates both scope
and name; legacy global ciphertext remains readable. The server keeps the key
in its data directory's `machine-environment-key` file (mode 0600), sealed under
the [secret vault](#secret-vault). Back it up with the database and the vault
key. Names and notes are public metadata; settings APIs never
return saved values. Provider environment diagnostics mask core contributions.
Commands can still print their own environment values.

Built-in credentials are overridden by global variables, then project variables.
Agent-provider contributions retain precedence over these values. Empty strings
are explicit overrides. Deleting a project override restores the inherited value.
Project deletion removes its variables when its database row is removed.

Global values synchronize into every host daemon, including the primary host,
before work, on reconnect, and when settings change. Project values are resolved
by the server and passed only to project operations core runs: agent turns/resume,
source clones, setup/teardown hooks, and new terminals. They never modify the
daemon's global environment. Existing terminals and commands retain
their launch environment. Agent turns receive fresh values on the next turn;
providers reconstruct sessions where needed to apply changed or removed values.

Plugin host calls receive global variables only; they cannot select a project.
A plugin worker keeps its current environment while any of its calls are active,
as before. This means a project override of a credential such as `GH_TOKEN`
applies to the project's clone, setup script, terminals, and agent turns, but
not to git commands an environment provider plugin runs on the machine, which
use the global value. Project-scoped contributions require daemon protocol 211;
older daemons update before the server accepts their session.

For non-primary hosts, the built-in GitHub row uses `gh auth token --hostname
github.com` and `gh api --hostname github.com user` on the server host. It
supplies `GH_TOKEN`, Git's
`GIT_CONFIG_*` environment entries for an HTTPS credential helper and SSH URL
rewrites for github.com, and author/committer identity. The helper expands
`GH_TOKEN` when Git calls it; no helper file, global Git config, or credential
store is installed. The primary host continues using its local Git authentication
unless an explicit global or project `GH_TOKEN` overrides it. A server without a
local host daemon has no primary host, so every machine receives the built-in
row. Private email uses
`<id>+<login>@users.noreply.github.com`.
A user `GH_TOKEN` overrides the built-in token, and the row shows overridden.
Tokens obtained from gh are never persisted by the server. Image construction
and Modal filesystem snapshot settings do not receive these contributions.

Use `omnyo machine env list`, `omnyo machine env set NAME [--note text]`, and
`omnyo machine env unset NAME`; all accept `--project <id>` and `--json`.
Omitting `--project` retains global behavior. Set reads stdin, removes one
trailing newline, and never accepts a value in argv. For example:
`printf '%s' staging | omnyo machine env set DEPLOY_REGION --project proj_example`.

SDK parity: `sdk.system.machineEnvironment`, `replaceMachineEnvironment`,
`setMachineEnvironmentVariable`, and `deleteMachineEnvironmentVariable` manage
global values. The same methods under `sdk.projects` take `projectId`.
Set/delete mutate one variable atomically. Replacement atomically replaces one
scope, with `value: null` retaining an existing secret; missing saved values
are rejected. Project reads return `variables` and `inheritedVariables`, with
`value: null` and `secret: true` for every row. `builtInGit` reports effective
GitHub credential readiness.

Automatic GitHub credential forwarding to non-primary hosts is enabled by default. Use
`omnyo settings general machineGitCredentialsEnabled false` to stop forwarding the
server gh credentials to machines; `true` enables them again. In Settings →
Environment variables, the automatic GH_TOKEN switch controls the same setting.
This does not log the server out or suppress an explicit custom GH_TOKEN.
Changes apply to new turns, setup commands and terminals.

## Modal machines

The optional Modal sandbox plugin builds/reuses named tools images for new
machines. Its plugin page keeps the bundled Standard Dockerfile as the first
image and can add named Dockerfiles, existing Modal image IDs, and named CPU/memory
presets. CLI: `omnyo modal image show`, `omnyo modal image set --file PATH`, and
`omnyo modal image reset` (append `--json`). Typed plugin RPCs `image.definition`,
`image.set({dockerfile})`, and `image.reset` expose the same persistent definition.
Supported instructions are one FROM followed by RUN, ENV, WORKDIR, and USER; no
build context or multi-stage builds. Saving does not build or modify existing
machines. The next new machine uses the saved definition. Omnyo installs the daemon
on demand, then clones the project and runs its setup hook.

Configure `tokenId` and `tokenSecret` in secret plugin settings; `appName` defaults
to `omnyo-sandboxes`. With no size preset, Modal's CPU and memory defaults apply.
`idleMinutes` defaults to 15 (0 disables idle suspension), and `timeoutMinutes`
defaults to 1440 with an allowed range of 1–1440. Existing machines use current idle
policy; running compute keeps its vendor deadline and restored compute uses the
current lifetime. Resource reservations stay pinned across restore.

There is no automatic retention removal. Use `omnyo machine remove MACHINE --yes`
for explicit cleanup. Manual and idle pauses save a filesystem snapshot before
terminating compute. There is no pre-expiry scheduler: a sandbox that stays active
until its configured timeout can lose changes since its last successful pause.
Provider details expose expiry and saved-image status; missing compute never
silently restores stale state. Open terminals prevent idle suspension.

`omnyo modal account inspect --json` tests credentials without allocating resources.
Create with `omnyo machine create --provider modal-sandbox --project PROJECT --json`.
See [modal-sandboxes](../plugins/environment-modal-sandbox/skills/modal-sandboxes/SKILL.md)
for prerequisites and lifecycle commands.

## Repository build caches

App production builds persist validated React Compiler transform results at
`<git-common-dir>/omnyo-cache/react-compiler`, shared safely across this
repository's worktrees. Non-Git checkouts use Vite's cache directory. Missing,
invalid, or corrupt entries are rebuilt; development and compiler diagnostic
modes bypass the cache. The cache has no user configuration and can be removed
while no builds are running. See [build performance](build-performance.md) for
its identity, portability, and verification contract.

Coordinator usage has separate installation-wide weekly-count and per-client product analytics choices. Settings → General shows both effective states. `omnyo settings usage status --json`, `count on|off`, `analytics on|off`, `preview --json` and `erase` use the same owner. An explicit product grant creates a random client capability; other clients and automation have no grant. The legacy `telemetryEnabled=false` switch and `OMNYO_TELEMETRY=false` veto both purposes; legacy true never grants analytics.

`OMNYO_USAGE_COLLECTOR_URL` explicitly selects a first-party origin; there is no built-in usage destination. `OMNYO_USAGE_COUNT_REGION=US` enables a count default only after the installation notice is acknowledged. Unknown and other regions ask first. The weekly report has an empty body and no identifier, and the coordinator attempts it at most once per newer UTC week after an accepted human action. Product reports use day precision, a scoped random subject, fixed event/property enums and bounded cumulative counts. Withdrawal cancels pending sends; explicit erasure uses the saved client proof. Raw product records expire after 30 days. See [the data dictionary](usage-privacy.md) for exact fields, meaningful limits and the difference between local implementation and deployed privacy evidence.

Error reports are separate from usage telemetry. A production coordinator
server or host daemon (`NODE_ENV=production` and a packaged version such as
`1.0.1`, not `0.0.0-dev`) sends unexpected failures to Alex's
Omnyo project in Sentry after the reporting choice is known: process-ending uncaught exceptions,
and server requests that end in an unhandled error or an `internal_error` 500.
Each report carries the runtime version, service (`coordinator` or
`host-daemon`), platform and architecture. A final allowlist rebuilds every
event immediately before transport. It retains fixed error categories, owned
source locations, line numbers, source-map debug IDs and validated technical
context such as operation, stage, outcome, duration, attempt, HTTP status and
transport code. Unknown details remain `unknown`. It discards arbitrary error
messages, request bodies and headers, prompts, transcripts, audio, user and IP
fields, breadcrumbs, extra data, uncontrolled tags and private paths. Up to eight
causes and 80 owned frames per cause may remain. There is no tracing, profiling,
session replay or log collection. Expected dependency responses such as a
disconnected host (502) are not reported. An `AbortError` on a cancelled incoming
request returns 499 with code `request_cancelled`, without an error log or Sentry
report. The same applies to a verified Node request-body disconnect (`ECONNRESET`
with the incoming signal's `Error: aborted` reason). Boot reads check cancellation
before consuming their nested responses.
An `AbortError` on an active request and unrelated failures on cancelled
requests retain normal error handling. Expected terminal update holds settle
as retryable refusals; synchronous terminal handler failures remain contained
and logged. Fatal paths wait up to two seconds
for delivery and then exit as before. Each process logs one startup line,
`Sentry error reporting enabled` or `Sentry error reporting disabled` with the
reason. `OMNYO_SENTRY_DSN` replaces the built-in project DSN, for example with
`omnyo-app env set OMNYO_SENTRY_DSN <dsn>`. An empty `OMNYO_SENTRY_DSN` in the
environment that starts the coordinator or host daemon disables error
reporting; `omnyo-app env set` rejects empty values. The setting is
startup-only, so restart with `omnyo-app stop && omnyo-app start`. Development,
worktree, desktop-dev, smoke and QA launches set `OMNYO_SENTRY_DSN=""` next to
`OMNYO_TELEMETRY=false`, so they never report to the production project. An
empty or unset `OMNYO_APP_VERSION` makes the host daemon treat itself as a
`0.0.0-dev` run, which disables its reports without blocking startup. Error
reporting does not cover the launcher, the `omnyo` CLI, or provider and plugin
workers.

Thread storage protected by a retention receipt remains protected. Its first
cleanup refusal is an informational hold; retries do not emit duplicate host
warnings. Browser Automation releases its exact host session and control lease
after the owning chat is deleted, without calling browser APIs that require a
live chat. A failed host cleanup remains pending and logs its actual cause.
Final feature-download failures report the final HTTP status, timeout, or
network category and attempt count, without request URLs or raw network errors.

The `crashReportsEnabled` setting, on by default, controls web, coordinator,
host daemon and voice diagnostics. Turn it off in Settings → General → Privacy &
diagnostics → Crash reports or with `omnyo settings general crashReportsEnabled false`; SDK callers use `system.updateGeneralSettings` with
`crashReportsEnabled`. The saved server-wide preference persists across restarts.
The coordinator keeps remote reporting off until it reads the persisted choice
from its database, so failures before that point remain in local diagnostics.
The effective policy also requires a configured recipient and an eligible
production build. A public beta build cannot enable automatic reports, including
on a separately enrolled production-capable daemon, by changing the saved switch.
The beta bundler removes the production Sentry default from executable bytes and
source maps. Its compiled collection cap also forces `OMNYO_TELEMETRY=false`,
even when the launch environment supplies `true` and a collector URL. Older distributed packages keep their original code until upgraded;
source changes do not modify those existing archives.

A host daemon starts with remote reporting off and waits for the current
coordinator's policy on its authenticated WebSocket. The session-open HTTP
response includes a policy snapshot, but cannot enable reporting: the owner may
change the setting before the socket connects. Each socket receives the latest
effective policy, and older revisions and callbacks from replaced connections are ignored.
A disconnect or server move turns reporting off until the new connection receives
fresh policy. Protocol 258 requires this behavior; older daemons must update
before connecting. The previous `crash-reports.json` file is no longer read or
written and cannot enable reporting. An empty `OMNYO_SENTRY_DSN` still disables
remote reporting regardless of the setting.

The web app keeps reporting off until it receives the server's effective choice. Turning
reporting off also retires queued voice diagnostics and aborts their pending
uploads. Enabling it again never replays retired records. Local voice recording,
transcription, Retry and Download remain available when diagnostics are off.
The server discards voice diagnostics received while reporting is off.

Sentry keeps unexpected terminal failures and genuine process failures. Explicit
validated recovered, cancelled and deferred outcomes are discarded before
ordinary capture, while fatal and unclassified failures remain reportable.
Safe fixed summaries identify the failed operation. Web failure context records
request/body phase, import classification, preflight result and observed online
state without sending request URLs or browser content. Timeline projection
failures include bounded sequence/count facts and whether the stored turn start
was missing or excluded from the selected window. Push receipt reads retry at
15, 30 and 60 minutes after sending, without resending the push notification;
only permanent or exhausted failures create an error event.

`GET /api/v1/system/config`
returns `diagnostics.release` (the runtime version) and, only while reporting
is enabled on the server, `diagnostics.sentryDsn`. Web reports cover uncaught errors, unhandled promise rejections and React render
errors, tagged `service=web`. The browser uses the same final event allowlist and
binds reports to the loaded web artifact, while retaining the coordinator runtime
identity separately. Only validated technical diagnostic, artifact and runtime
contexts survive; arbitrary messages, contexts, tags and external or private
source paths are discarded. The browser posts envelopes only to the same-origin
`POST /api/v1/system/web-errors` route, with credentials restricted to that origin
and no referrer. The coordinator validates one bounded error event, reapplies the
allowlist, and sends only generated headers to its fixed configured Sentry
recipient. Browser Origin, Referer, forwarding headers, cookies, request URLs,
private stack origins and product analytics subjects are not forwarded. Neither
hop follows redirects or falls back to direct browser delivery. Withdrawing the
choice aborts pending browser and relay sends. There is no tracing, session replay,
profiling or session tracking.

The browser reports a `Slow Shelf move` warning under the same Crash reports
setting when a core Shelf move takes at least two seconds to settle or reach a
foreground frame. The warning records bounded milliseconds for local preparation,
optimistic UI commit, the first foreground frame observed after commit, and the
SDK request through JSON decoding. When available for the same response, it also
records the coordinator's request-to-response duration and the browser's
time from SDK request start to the first and last response bytes. The outcome
records whether the move saved, failed, or was still pending at ten seconds.
Reports are limited to one per five minutes per tab and contain no chat
identifier, title, request URL, or response body.
A foreground frame is a rendering opportunity. It does not confirm which pixels
the browser presented.

Report a bug in the sidebar footer (`builtin:report-bug`), `omnyo bug report`
and SDK `system.experimental_reportBug` all send a deliberate bug report through
`POST /api/v1/system/bug-reports`. The coordinator sends it as Sentry user
feedback to the same project, tagged with its runtime version, so it follows
the same `crashReportsEnabled` setting and DSN conditions. The report carries
the written description (up to 4,000 characters, with credentials redacted and
the home directory replaced by `~`) and an optional follow-up email. The app
also links the last web error it delivered to Sentry, if any. It never attaches
chats, logs, screenshots, user, request or host data. When Crash reports is off
or the server has no DSN, the route answers `{ status: "unavailable", reason }`
with `crash-reports-off` or `not-configured`, the app says so instead of showing
the form, and the CLI exits with `bug_reports_unavailable`. A send that Sentry
rejects or that takes longer than 10 seconds returns a retryable 502.

### Thread list provider icons, read status grouping, and lifecycle filter

The Thread list plugin's `showProviderIcons` preference defaults to `true`.
Organize → Rows → Provider icons or
`omnyo thread-list prefs set showProviderIcons false` hides the agent provider
icon before each thread title. Unknown provider ids have no icon.

The `showEmptyProjects` preference defaults to `true`. Organized by project,
Filter → Empty projects or
`omnyo thread-list prefs set showEmptyProjects false` hides project groups with
no visible threads. Hidden threads and threads shown under Pinned do not count.

The `groupByReadStatus` preference defaults to `false`. Organize → Groups →
By read status or `omnyo thread-list prefs set groupByReadStatus true` lists
threads that show an unread dot above the rest, keeping the selected sort within
each group. Parent threads start collapsed while it is on, without changing the
saved collapsed state. The open thread keeps its place until another thread is
opened, and pinned threads keep their manual order. It is exclusive with By
environment: while it is on, worktree threads are not grouped.

The Thread list plugin's `threadLifecycles` preference selects `["active"]`
(the default), `["archived"]`, or `["active","archived"]`. Set it with
`omnyo thread-list prefs set threadLifecycles '["archived"]'` or the header's
Filter menu. It syncs to every window and rejects empty or duplicate values.

## Desktop browser cookie discovery

The desktop app combines known-browser definitions with schema-based discovery
of Chromium and Firefox cookie stores matched to registered web browsers.
Known-browser entries remain available without registration metadata.
On Linux, an absolute `XDG_CONFIG_HOME`
in the desktop process environment replaces `~/.config` for discovery and known
Chromium profile locations; relative values are ignored. Flatpak and Snap data
directories are also searched. On macOS, discovery searches Application Support.
The desktop app's own profile is excluded. See `omnyo guide browser` for search
bounds, encryption limitations, and the `import-sources` / `import-cookies`
commands. No additional Omnyo setting is required to enable discovery.

Settings → Browsers → Keep logins synced (or `omnyo browser cookie-sync enable
--from <source> --profile <directory>`) refreshes the Omnyo browser profile from one
source profile every 15 minutes. Its Sync from dropdown, or running `enable`
again with another source, switches the mirrored profile. The desktop app stores the choice and the
identities of cookies it synced, never their values, in
`browser-cookie-sync.json` in its user data directory; nothing about individual
cookies is sent to the server.

On macOS the desktop app reads the system default browser and that browser's
last-used profile and offers it as the recommended source: a Connect button in
Settings → Browsers while sync is off, the Browser step of desktop onboarding,
and `recommended` in `omnyo browser import-sources`. No setting controls this;
the recommendation is omitted when the default browser is unsupported or
unavailable.

### Mobile app

Pair a phone through Settings → Mobile (`/settings/mobile`) → **Add mobile device**.

### Server performance diagnostics

`OMNYO_PERF_DIAGNOSTICS=1` permits opt-in CPU profiling and detailed server
performance logs; the default is false. Restart to change it. The launcher
flag `pnpm start --perf-diagnostics` (also `pnpm start:worktree` and `omnyo-app`)
grants permission for that launch; the experiment must also be on. See [diagnostics](debugging-and-qa.md#opt-in-server-performance-diagnostics)
for capture retention, overhead, and interpretation.

Diagnostics require **both** startup permission (`--perf-diagnostics` or
`OMNYO_PERF_DIAGNOSTICS=1`) and the `performanceDiagnostics` experiment. The
experiment defaults to off. Use
`omnyo settings experiment performanceDiagnostics true` to enable it, or `false`
to stop it; SDK clients use the existing experiments update endpoint. The
experiment takes effect live on that server. Without startup permission it
cannot start collection. Turning it off restores normal logging thresholds,
stops the sampler and flushes the in-flight profile; existing files remain.
The launch flag only grants permission and still requires a restart to change.

## Prompt Library

The bundled Prompt Library plugin is disabled by default. Enable it in
Settings → Plugins or with `omnyo plugin enable omnyo--prompt-library`. Its
**Search prompts** command defaults to Ctrl+R and can be rebound in Keyboard
Settings. Search scope is remembered in browser local storage separately for
new-thread and follow-up composers. Starred text and mentions persist in the
plugin database. See the [Prompt Library skill](../plugins/prompt-library/skills/prompt-library/SKILL.md)
for CLI and SDK commands.

## Composer predictions

The bundled Composer Predictions plugin (`omnyo--composer-predictions`) exposes
`enabled` and `codexModel`. It uses an existing Account Pooler Codex subscription
for every chat provider. Enable Codex routing and connect an account with included
allowance and zero paid credits. See
[account and allowance](../plugins/composer-predictions/README.md#account-and-allowance).

## Automation script execution host

The Automations plugin setting `scriptHostId` selects an enrolled host for all
script automations. An empty value uses the Omnyo server. Set it through plugin
settings in the app, `omnyo plugin config automations set scriptHostId <host-id>`,
or SDK `plugins.updateSettings`, then run `omnyo plugin reload automations`. The host owns script working directories and stable stored script
copies; a disconnected host fails the run without running it on the server.
Held direct-access preparation captures the original source host once while
preserving automation definitions. See the Automations skill’s script runtime
reference for storage and environment behavior.

## OpenSEO workspace API key

The Automations plugin setting `openSeoWorkspaceApiKey` is a write-only
secret for this Omnyo installation. Set it in Automations settings using a
key from the relevant OpenSEO workspace. OpenSEO grants the key the issuing user’s workspace permissions. Omnyo uses
it only to list projects and read saved keywords. Each Weekly Content Feed copy requires
separate authorization for its exact site and matching OpenSEO project.
Replacing or clearing the key invalidates those authorizations. Confirmed
workflows retain their approved evidence until the owner changes their brief.

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

## Private web delivery

`scripts/private-continuous.json` enables `webUpdates: true` and supplies
`commands.webBuild` as a command array. The runner persists its delivery route
before activation. Matching committed non-UI runtime fingerprints select the
web-only route; unsupported capabilities or changed runtime inputs select the
full route with a recorded reason. Other capability errors stop delivery.
Only private runtime builds with a packaged `web-build.json` support this path.
See [private shipping](private-ship.md#web-only-delivery).

## Project icons

Project settings → Change icon saves a custom image across clients. Use automatic icon restores repository discovery. The app converts selected images to PNG at up to 96 pixels. `omnyo project update ID --icon FILE.png` and SDK `projects.update({ projectId, customIcon: pngDataUrl })` accept PNG up to 512 × 512 pixels and 48 KiB; `--reset-icon` or `customIcon: null` resets the override. Personal keeps its built-in icon.
