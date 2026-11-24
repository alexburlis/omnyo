---
kind: instruction
title: Omnyo Guide — Machines
summary: Command reference for listing and targeting execution machines.
intent: Explain execution-machine discovery and selection from the CLI.
editingNotes: Keep the user-facing noun machine; internal APIs and types use Host.
---

Machine commands

A host is an identity and daemon connection. A machine is a host with a
provider-owned lifecycle. The local host has no machine provider. Every other
host is a machine, including existing machines enrolled with the built-in
`manual` provider (Manual machine setup). Add machines under Settings → Machines
or from the composer machine picker.

On the new chat screen, the machine row under the composer lists each machine
with its status. Pick a ready machine in one click. A machine marked `+` has no
checkout of the project yet; picking it opens project setup instead of
selecting it. Offline or updating machines are disabled, and their tooltip says
why. When the default machine for new chats has no checkout of a project, that
project's chip names a machine that has one, such as `Stratoclash · 5080`.
Picking it selects the project and that machine together.

One machine runs the Omnyo server. It stores threads, the database, and settings,
and every other machine and app connects to it. Settings → Machines badges it
`server` once there are several persistent machines, and `omnyo machine list` shows
`server` in its Role column. Keep the server machine on: while it is asleep or
off, nothing can reach Omnyo and running threads may stop. The server machine
cannot be removed.

The server listens on loopback by default. Remote execution machines need
a server access provider: paired Omnyo Connect, or a configured direct URL reachable
from the target, such as a private Tailscale Serve URL. A configured URL alone
does not prove reachability.

The Settings installer uses the exact `omnyo-app` tarball served by that Omnyo
server at `/install/omnyo-app.tgz` and stops when the server does not provide it;
it never installs from the npm registry. npm installs omnyo-app under this
machine enrollment's Omnyo data directory, so the installer needs neither `sudo`
nor a global npm configuration. Installed launchd/systemd services pass
`--auto-update`. On a newer server protocol mismatch, the daemon downloads that
same artifact, updates its private install, and exits for the service manager to
restart. Failed attempts use a persisted exponential backoff that starts at 5
seconds and caps at 5 minutes. A daemon never auto-downgrades to an older server
protocol. Use Settings → Machines or `omnyo machine retry-update` to bypass the
current backoff after a transient failure.

To opt out, remove `--auto-update` from the launchd plist or systemd user unit
and reload that service. Foreground/manual `omnyo-app host-daemon` runs leave it off
unless you pass `--auto-update` explicitly.

`omnyo-app`, `omnyo-server`, and `omnyo-host-daemon` capture service stdout and stderr
directly under the selected data directory in `logs/server-stdio.log` and
`logs/host-daemon-stdio.log`. These files append across restarts and contain
console output and startup errors; rotating application logs remain separate.
Use `tail -F` to follow them without coupling service logging to the terminal.

omnyo machine list List persistent machines with role,
ID, type, connection status, and
relative last-seen time
--all Include disposable provider
sandboxes
--json Print the raw host list
omnyo machine providers List installed machine providers
--json Include inputs schemas and policy
omnyo machine create --provider <id> Create a standalone machine
--key <idempotency-key> Reuse this creation on retries
--inputs <JSON> Non-secret provider inputs
--json Print the created machine as JSON
omnyo machine enroll --bootstrap-file <path>
--bootstrap-env <NAME> Alternative private bundle source
omnyo machine show <id-or-name> Show machine details
omnyo machine housekeeping <id-or-name> [--json] Show idle-session cleanup and retention reasons
omnyo machine rename <id-or-name> <name> Rename a machine
omnyo machine away <id-or-name> Stop Omnyo work on a machine and hold new turns
omnyo machine available <id-or-name> Let Omnyo use the machine again
omnyo machine retry-update <id-or-name> Retry a pending daemon update now
omnyo machine reconcile <id-or-name> Reconcile compute with core’s recorded state
omnyo machine suspend <id-or-name> Suspend a provider-managed machine
omnyo machine resume <id-or-name> Resume a machine (already active is a no-op)
omnyo machine retry-cleanup <id-or-name> Retry failed teardown now
omnyo machine remove <id-or-name> [--yes] Revoke and remove a machine
omnyo machine provider-cli status <machine>
omnyo machine provider-cli install <machine> <provider-id>
--action <install|update> [--yes]

`--yes` pauses chats on the selected machine, installs or updates the CLI,
then resumes those chats. Without `--yes`, running work blocks installation.

`omnyo machine housekeeping <id-or-name> --json` and SDK
`hosts.experimental_housekeeping({ hostId })` read the last completed host cleanup
check without starting cleanup or waking a suspended machine. The result is
`not-run`, `complete`, or `failed`; failed inspection never means zero retained
sessions. Each retained session identifies its thread, environment, provider,
provider bridge process ID when known, idle duration and retention reason. Memory
is the bridge process RSS and excludes its child processes. RSS can understate
usage under compression; sessions
sharing a process repeat the same measurement and must not be summed.

The existing cleanup cycle runs every minute. On macOS the native memory-pressure
signal selects ten minutes of idle grace normally, two minutes under warning
pressure, or one minute under critical pressure. Unsupported platforms and failed
pressure reads report pressure unavailable and retain the normal ten-minute grace.
Active turns, pending starts or answers, in-flight commands, background work and
sessions that cannot be restored remain protected under every pressure level.

`omnyo machine show <id-or-name> --json` and SDK `hosts.get` include `directAccess`.
Owner access returns coordinator admission, phase, instance/session linkage and
an owner fingerprint, plus a read-only observation of the actual worker probe.
Worker `status: "available"` with `probe: null` means no worker probe exists;
`status: "unavailable"` means ownership could not be observed. Committed and
uncommitted probes include SHA-256 owner fingerprints, never their challenges.
Inspection does not release admission or clear ownership. Machine credentials
still receive machine details, with `directAccess.status: "unavailable"`; they
cannot inspect worker ownership. A connected protocol-compatible worker is
required for an observation.

Each machine has a permission limit: the highest permission mode any thread on
that machine can run with. The default is Full Access. A thread that asks for
more resolves down to the limit, and a provider that supports no mode under the
limit cannot run there. Set it in Settings → Machines → the machine → Permission
limit; that page also shows the machine's projects, provider CLIs, update state,
and rename/remove. There is no CLI or SDK command to set it, and a paired
machine cannot set it for any machine, so a sandbox machine can stay at Full
Access while your laptop stays lower. `omnyo machine list --json` and `omnyo machine
show` report the current limit.

Standalone create does not create a thread or workspace. Omit inputs to use the
provider defaults; supply JSON when its schema requires additional values. Omit
`--key` to let the server generate one, or supply a stable key for retries.
Creation is durable:
`--no-wait` returns the creating host ID immediately; otherwise the CLI polls
that host until active. SIGINT stops following and exits 130 while creation
continues. `omnyo machine list` includes machines still being created. It lists persistent
machines only; pass `--all` to include the disposable sandboxes that
environment providers create per thread.
Use `omnyo machine show <host-id>` to inspect progress and `omnyo machine
remove <host-id>` to cancel and clean up. The SDK provides
`hosts.experimental_create`; pass `wait: false` to receive the creating host and
poll it with `hosts.get`. Aborting a caller signal never cancels the server operation. A connected daemon does not
yet imply an agent-ready checkout and authenticated provider.

`omnyo machine reconcile` / `hosts.experimental_reconcile` is an explicit request,
not a core timer. For a machine core records as suspended, it runs the provider’s
save-and-stop operation. The API returns HTTP 202 immediately; the CLI polls
machine status until completion. Active machines and lifecycle
operations already in progress are left alone. Plugins request suspension
separately when their idle policy decides an active machine should pause.

Suspend and resume are available only when the machine provider implements
both operations. Retry cleanup is accepted only for a retiring machine whose
provider teardown failed.

Application logs rotate in `logs/server.N.log` and `logs/host-daemon.N.log`
under the selected data directory. Startup errors, crashes, and other output
that bypasses the logger are appended to `logs/server-stdio.log` and
`logs/host-daemon-stdio.log`; a file over 10 MB is renamed to `-stdio.1.log`
when its service starts. Follow them with `tail -F`.

Updates commands

One consolidated view of Omnyo and provider CLI updates across machines — the
CLI counterpart of Settings → Updates and the sidebar Updates badge.

omnyo updates [status] Show omnyo-app and provider CLI update
status for every machine
--machine <id-or-name> Limit to one machine
--json Print the aggregate as JSON
omnyo updates apply Run every available provider CLI
install/update, one at a time
--machine <id-or-name> Limit to one machine
--yes Pause chats on each affected machine, update and resume them
--json Print per-target results as JSON
omnyo updates app [status] Show whether Omnyo can update itself,
the available version, and the last result
--json Print the status as JSON
omnyo updates app apply Download the update and restart Omnyo into it
--yes Update now: stop running chats, restart and resume them afterwards
--no-wait Return once the update starts
--json Print the final status as JSON
omnyo updates app cancel Stop an update that is waiting for running
chats to finish
--json Print the status as JSON
omnyo updates app dismiss Mark the last update result as seen

`omnyo updates apply` covers provider CLIs only. `omnyo updates app apply` updates
Omnyo itself when it was started from the `omnyo-app` launcher or with
`pnpm start` from a `main` checkout, without `--no-in-app-updates`: it installs the new version next to the
running one and restarts into it. It does not roll back if the new version
fails to start. Source checkouts update only from a clean `main` that
fast-forwards to `origin/main`.
A private coordinator updates to the runtime staged for it. Without `--yes` it
installs once every chat is idle and never holds new messages while it waits;
JSON status reports this as `installsWhenIdle`. If chats are still running 10
minutes after the apply, it takes the update-now path itself; the waiting status
reports that time as `activity.stopsRunningChatsAt`. `--yes` (the bottom-bar
update button in the app) does this immediately: it stops every running chat on
every machine, saves continuations, and restarts without waiting for worker
activity. The launcher stops the coordinator and its local worker, including
browser sessions, terminals, and plugin work. It sends SIGKILL if either process
does not stop within five seconds. Each paused chat resumes after the restart.
Ordinary idle updates still require worker admission. If a chat cannot be
paused, the update fails visibly and eligible chats resume.
Update now also pauses idle chats with pending background work. It preserves one
continuation per chat, including existing queued messages. Status distinguishes
preparation, pausing chats, and restarting. An idle worker-admission refusal
reports `runtime_update_busy`; a pause failure reports
`app_update_pause_failed`. Failure results include `errorCode` in JSON and the UI
details. Existing saved results without a code remain readable.
`omnyo updates app cancel` stops a waiting update. New turns pause only for the
short restart handoff or update recovery; JSON status exposes this as
`newTurnsPausedForUpdate`.
Desktop users update through the desktop app's relaunch; development servers
and `omnyo-server` cannot update themselves. Connected daemons follow the server
version automatically.

For source installs, `omnyo updates` shows the checkout commit and explains manual
Git updates when no update shim is running. It does not compare that checkout
with npm releases. Failed or unavailable release checks show “Latest unknown”;
“Up to date” requires a successful check.

Private server releases show their private channel and use the verified private
release installer. They do not query npm or claim a successful release check.

Machine selectors accept either an exact machine ID or an unambiguous machine
name. `--host` is an alias for `--machine`.

omnyo thread spawn --project <id> --machine <id-or-name> --prompt "..."
omnyo thread spawn --project <id> --new-machine <provider-id> --prompt "..."
--machine-inputs <json>
omnyo project create --name "..." --root <path> --machine <id-or-name>
omnyo project source add <projectId> --machine <id-or-name> --path <path>

For thread spawning, machine targeting works with an unmanaged workspace path,
a new managed worktree, or the personal workspace. Do not combine it with an
existing environment ID: the reused environment already selects its machine.
`--new-machine` creates through a machine provider and uses its advertised
environment row when declared. Otherwise add `--environment-provider <id>`
(required for SSH). Use `--environment-inputs <json>` for workspace configuration,
separately from `--machine-inputs <json>`. Machine inputs are persisted and
readable by plugins; never put secrets there. Store credentials in plugin settings and pass only
non-secret configuration or references.

When `--new-machine` selects an environment provider requiring a project
checkout, core clones the project's Git remote and registers a source on the
connected machine before creating that environment. Existing sources are reused.
Automatic setup uses a stable per-project target and shares concurrent setup on
the same host. After a server restart, it registers a completed checkout whose
remote matches instead of cloning again; a conflicting target is refused.
The project needs a Git remote and the machine needs Git access to it. Choosing
Personal workspace first does not clone a project. Standalone `omnyo machine create`
does not set up a project source and remains available until explicitly removed.
Machines created for threads retire after their last live thread is archived
when the provider declares them ephemeral.

For project creation and sources, `--root`/`--path` refers to a path on the
selected connected machine. Omit the selector to keep the existing local CLI
machine fallback (normally the server machine). Pass `--clone` to source add
instead of `--path` to clone the project's Git remote there; `--remote-url` and
`--target-path` optionally override the clone inputs.

## Server access

Set Machines → Server URL reachable by machines, or run `omnyo settings general
machineServerUrl https://omnyo.example.com`. An unset value uses OMNYO_EXTERNAL_URL.
Select Manual to show the URL input. Set Default machine access with
`omnyo settings general defaultMachineAccess direct` or `connect`; `null` uses
the first registered access provider, or direct when none is registered. An
unpaired provider reports setup required. `omnyo settings show --json` includes
fresh provider availability and the effective selection; failed or timed-out
checks report unavailable without acquiring a grant. Settings and creation
banners refresh this status when the access provider signals a change. Machines use this
access for ongoing runtime requests, including account-pool endpoints.

For an already enrolled idle worker, `omnyo machine direct-access <id>` verifies
HTTP, WebSocket and a fresh primary session through the configured direct URL.
The worker keeps its identity and credential. Busy, uncertain, incompatible or
server-role machines are refused. `retirementPending:true` means the old provider
grant still needs confirmed retirement; repeat the command to prove and retry.
If the worker already uses the direct route, the same command proves its current
HTTP and WebSocket connection and retires the exact old grant without restarting
the worker or interrupting active work. This confirmation requires protocol 236;
protocol 235 workers keep their normal connection until an idle runtime update.

`omnyo server maintenance status` reports the actual runtime and framework activity.
Maintenance commands accept `--json` for structured output and errors.
Acquire with `omnyo server maintenance acquire --id ID --owner-id OWNER
--runtime-id RUNTIME --host-id HOST --data-dir PATH`. Release with
`omnyo server maintenance release --id ID --owner-id OWNER --host-id HOST`.
The matching server-owned hold survives restart. Acquisition never stops busy
user work. Only a positive held receipt permits the caller's later installation.
Remote desktop clients must not hold their shared coordinator to update themselves.
Migration holds additionally require confirmed local target authority before release.
`omnyo server maintenance repair-runtime --id ID --owner-id OWNER --host-id HOST
--data-dir PATH --hold-sha256 SHA --runtime-root ROOT --runtime-sha256 SHA --json`
works offline after the recognized server service is stopped. It binds a fully
verified repair package to an already promoted migration in `releasing` phase.
The historical hold stays unchanged; a separate protected receipt retains its
complete preimage and binds the approved runtime. The command rejects a running
runtime, conflicting migration markers, an unpromoted move, or mismatched owner,
identity, and package bytes. It neither starts the server nor releases the hold.

`omnyo server maintenance adopt-identity --request-file PATH --phase preflight|stage|rollback [--json]`
runs the selected verified runtime's stopped-state identity controller. The versioned
request binds the exact host, acquired hold, source and destination profiles, external
job, runtime and complete installed-plugin artifact cohort. Preflight verifies actual
installed IDs and artifact bytes; stage refuses live writers and preserves existing
state. Rollback requires that no writer was admitted. The command does not stop or
start the service, change its owner, or offer an automatic update.
Identity updates with `activation: "idle-only"` wait indefinitely and refuse force.

SDK: `server.maintenance.status/acquire/prepare/release` and `hosts.convertToDirect(id)`.

For a held first start, set launch-only `OMNYO_SERVER_STARTUP_HOLD` to strict JSON
with exactly `id`, `ownerId`, `expectedServerHostId` and absolute
`expectedDataDir`. The host and directory must match the existing source. The
server persists a `startup` hold before database recovery, factories or scheduled
work. A matching restart is idempotent; later launches can omit the value and
retain the hold. Conflicting or already released ownership fails visibly.

`omnyo server maintenance prepare <operation>` requires `--id ID --owner-id OWNER
--runtime-id RUNTIME --host-id HOST --data-dir PATH` on each operation:

  quiesce                                      Stop running threads
  create-manual-target --name NAME              Prepare one hold-owned target
  configure-direct-access --server-url URL      Set canonical direct machine access
  convert-to-direct --worker-id ID              Convert one existing idle worker
  enable-server-move                           Enable only serverMove
  rebind-plugin --plugin-id ID --root-path PATH  Rebind an installed direct-path plugin

These operations print JSON and keep admission held. Rebinding preserves plugin
settings, enabled state, secrets and schedules without starting its factory.
The manual target uses its normal one-use enrollment command from
`hosts.experimental_getEnrollmentCommand({id})`. Its preparation stays admitted
until the target connects and creation finishes, excluding move, release and
further preparation. Other enrollment and ordinary mutations remain frozen.
Move start requires both `--startup-hold-id ID --startup-owner-id OWNER`, or
SDK `startupOwnership: {id, ownerId}`. Move checks exclude preparation/release,
and active preparation excludes move start. A failed or cancelled move leaves
the same durable startup hold; exact-owner release resumes normal work.

## Move the server

Moving the server is experimental and off by default. Turn on the `serverMove`
experiment with `omnyo settings experiment serverMove true`; until then Settings → Machines hides
Move server here, and `omnyo server move`, `omnyo server export`, and deleting an old
server copy from the server are refused.

Agents must not move a server, abandon a move, or unlock an old copy without
the user's explicit confirmation in the conversation. Run `--check`, show the
user the checklist, and wait for their confirmation; don't pass `--yes` to skip
the confirmation on their behalf.

A move copies the server's data (database, settings, plugin data, attachments)
to another persistent machine, points every machine and app at it, and keeps the
old computer running as a regular machine. Worktrees, thread storage, and
checkouts stay on the machines that own them.

  omnyo server move --to <id-or-name>        Stop all work and move the server
    --check                               Print the checklist and stop
    --address <url>                       New server address (direct setups)
    --startup-hold-id <id>                 Exact startup hold ID when starting held
    --startup-owner-id <id>                Exact startup hold owner ID when starting held
    --archive-existing-data               Move omnyo server data on the target aside
    --yes                                 Skip the confirmation
    --json                                Print the final move status
  omnyo server move status                   Show the steps, or the last move
  omnyo server move cancel                   Cancel before the switch starts
    --yes                                 Abandon a move that needs recovery without asking
  omnyo server export --out <file>           Export a running server
  omnyo server import <file>                 Install an export on this computer
    --data-dir <dir>                      Target data directory
  omnyo server unlock                        Let this computer's old copy start again
    --force                               Skip the new-server health check
  omnyo server allow-connect                 Turn Omnyo connect and Omnyo account on for an imported copy
  omnyo server delete-old-copy               Delete the old copy a move left here
  omnyo server install-machine-service       Keep this computer connected after a move

When the target never confirms that it took over, the move waits in
`recovery_required`: the old server stays up and read-only, and Omnyo finishes the
move on its own once the target answers. `omnyo server move` and
`omnyo server move status` exit 2 in that state and name the exits:
`omnyo server move cancel` abandons the move and keeps the server here (it asks
first, since abandoning while the target took over leaves two servers; `--yes`
skips the question), and `omnyo server unlock` recovers an old copy that stopped.

`--check` exits nonzero while a blocker remains. With Omnyo connect, machines and
apps keep the same URL. A direct-address server needs `--address`: the URL every
machine and app will use to reach the new server. Existing omnyo server data on the
target is archived to `<dir>.before-move-<date>` only with
`--archive-existing-data`; it is never merged. The move follows the steps until
the new server takes over; SIGINT stops following while the move continues.
Failure or cancellation before the switch leaves the server where it was.

`omnyo server export` streams a gzip archive to a 0600 file and keeps it only when
it matches the SHA-256 digest the server sent. The archive is not encrypted and
holds the server's credentials and plugin secrets, so keep it private; `--json`
prints `path`, `sizeBytes`, `sha256`, and that `warning`.
`omnyo server import` works offline: it refuses a data directory that has `app.db`
or a running Omnyo, refuses an export made by a newer Omnyo or by a server with the
`serverMove` experiment off, asks you to re-export an archive encrypted by an
older Omnyo, and applies path fixups when the imported server first starts. If an
import was interrupted, rerunning `omnyo server import` rolls it back first from
`server-import-journal.json` (`--json` reports `rolledBackInterruptedImport:
true`), and a server move to that machine does the same;
until then Omnyo refuses to start a server on that directory. Stop the original
server before starting the imported one; two servers holding the same Omnyo
connect credential take each other's tunnel.

An imported server starts with Omnyo connect and Omnyo account off
(`server-connect-hold.json`), so the copy can't take the original server's
tunnel or use its omnyo.link account.
`omnyo server allow-connect [--data-dir <dir>] [--yes] [--json]` removes the hold
once the original server is stopped (`--json` prints `dataDir` and
`connectHoldRemoved`); Omnyo connect and Omnyo account start the next time that
server starts.

After a move, the old computer's data directory keeps `server-moved.json`, so
Omnyo there refuses to start the old server and runs as a regular machine.
`omnyo server delete-old-copy` deletes the server files left behind and keeps that
lock. The desktop app installs the persistent, self-updating service a
CLI-installed machine gets as soon as its server moves, and on later launches
if the service is missing; until that succeeds (it needs Node.js 22.19 or newer
on the PATH), the app keeps that machine connected only while it is open and
explains why once. After a move from `omnyo-app`, or to retry by hand,
`omnyo server install-machine-service [--data-dir <dir>] [--yes] [--json]` installs
the same service on macOS and Linux (on Windows it refuses, because the service
is launchd or systemd): it needs
Node.js 22.19 or newer on the PATH, stops Omnyo running from that directory, and
runs `install-machine.sh --adopt --data-dir <dir>`, which keeps the machine ID,
downloads the new server's omnyo-app package, and installs the launchd or systemd
service (`--json` prints `dataDir`, `serverUrl`, `toHostName`, and
`serviceFile`). `omnyo server unlock` refuses while that service exists. `omnyo server unlock` removes the lock as a last resort: everything since
the move is lost on that copy, and the new server must be stopped first. It
refuses while the new server still answers (`<serverUrl>/health`, or
`/api/v1/system/version` with this computer's machine grant for Omnyo connect)
unless `--force` is passed, and Omnyo on that computer starts the old server within a few
seconds. It also
removes `serverUrl`, `serverHeaders`, `machineCredential`, and
`connectMachineId` from that directory's `config.json`. Both
default to `OMNYO_DATA_DIR` or `~/.omnyo` and accept `--data-dir <dir>`; neither
calls a server. The SDK equivalents are `sdk.experimental_server.checkMove`,
`startMove`, `moveStatus`, `cancelMove`, and `export`. In the desktop app,
picking This Mac on macOS or This Computer on Linux after a move shows where
the server went, with actions to open the moved server or choose another server.
It leaves the old copy locked and its machine service in place.

## Local daemon lifecycle

`install-machine.sh --adopt --data-dir <path>` installs the service for a data
directory that is already enrolled, reading its machine ID from `auth.json` and
its server address and headers from `config.json`; `omnyo server
install-machine-service` runs it for the directory a server move left behind.

Reconnect a disconnected machine whose server access or host key was revoked
or became stale, without changing its Omnyo host ID:

  omnyo machine reconnect <id-or-name>       Print a short-lived reconnect command and wait for reconnection
    --json                                Print the command and expiry without waiting

Run the printed command on the affected machine. It is a one-time enrollment
command for the existing host ID. Fetching the installer releases the machine's
access grant and acquires a new one from the same provider; if that fails, run
the command again. The machine then re-enrolls: it replaces `auth.json` with a
new host key, replaces the server-access headers, and restarts the owned daemon
service. Environments, workspaces, and thread associations are kept.

The command reuses the data directory the machine's daemon last reported, so it
works unchanged for a custom `OMNYO_DATA_DIR` and for `~/.omnyo` on a computer that a
server moved away from; an explicit `OMNYO_DATA_DIR` still takes precedence. Before
downloading anything, the installer refuses a directory that does not hold this
machine, which is what happens when the command runs on another computer.
The server's own machine cannot be reconnected this way.

`install-machine.sh --start|--stop|--uninstall --host-id <id>` starts, stops or removes an
owned local installation. Optional `--server-url <url>` and `--data-dir <path>`
assert the expected installation. OMNYO_DATA_DIR is treated as an assertion too.
An identity mismatch refuses the operation. These commands are local machine
primitives; `omnyo machine remove` asks the server to remove the provider resource.
They verify the canonical installer-owned directory, enrolled identity, and
service or process ownership before acting. Stop and uninstall safely succeed
when no matching installation exists; start requires an installation. They
refuse the default Omnyo data directory. Stopping a daemon is distinct from
`omnyo machine suspend`, which invokes provider suspension and polls until the machine
is paused. `omnyo machine resume` likewise waits for provider restore and bootstrap.

## Enroll a preinstalled machine

`omnyo machine enroll --bootstrap-file <path>` or `omnyo machine enroll --bootstrap-env <NAME>` consumes a versioned private enrollment bundle prepared by core. Supply exactly one source. The environment source is removed from the CLI process environment after reading it; files remain under the caller's ownership. Neither command prints the bundle or credentials.

The CLI refuses another host or server identity in the selected machine directory. Repeating enrollment with the same persisted identity succeeds without exchanging the credential again, including when the original bundle expired. Machine data defaults to `~/.omnyo-machines/<server-host>`; `OMNYO_DATA_DIR` can select another isolated machine directory, but enrollment refuses the default `~/.omnyo` directory unless its `host-id` already names this machine.

The manual copy command fetches `/install.sh` using a short-lived `X-Omnyo-Enrollment` header. The server supplies the bootstrap only for a pending, unexpired, uncancelled manual enrollment whose credential has not been consumed; downloaded responses are not cached. On an invalid credential, the server returns a shell error that prints the reason when piped to `sh`. The command contains no bootstrap JSON or access-provider credentials.

Each pending manual enrollment also has a short setup code such as `7KQ4-M2XD`, so the command can be typed: `curl -fsSL https://<server>/m/7KQ4-M2XD | sh` on macOS or Linux and `irm https://<server>/m/7KQ4-M2XD.ps1 | iex` on Windows. Add a machine shows this short command first, with the code large enough to read aloud, and keeps the full command under Copy full command. Opening the same `/m/<code>` address in a browser on the new machine shows both short commands as plain text, the one for the browser's operating system first, so they can be copied there without sending them to that machine; the dialog and CLI show this address under the commands. A browser is recognized by `Accept: text/html`; the page never contains the enrollment credential, and an invalid code shows the refusal reason. `hosts.experimental_getEnrollmentCommand` returns it as `shortCommand` (`code`, `command`, `windowsCommand`, `pageUrl`, `expiresAt`) while the code is usable, and `omnyo machine create --provider manual` prints it before the full command. The code lasts ten minutes or until the enrollment expires, whichever is sooner, and stops working once the enrollment is used, replaced or cancelled. The server accepts it in any case, with or without the dash, and reads O as 0 and I or L as 1. It keeps the code in memory only, beside the pending enrollment, and looks it up by hash. After ten incorrect codes from one client within ten minutes, `/m/` refuses every code from that client, and after fifty from all clients it refuses every code, until those failures are ten minutes old. Behind the relay, the client is the visitor address the relay reports. Each refusal returns a script that prints the reason and exits 1, or throws in PowerShell, so it shows when piped to `sh` or `iex`.

A Windows machine uses the PowerShell form of the command, which fetches `/install.ps1` with the same header and pipes it to `iex`. That script runs a Node installer: it installs the server's host package under `%USERPROFILE%\.omnyo-machines\<server-host>\npm`, enrolls, starts the daemon without a window, and registers it in the user's `Run` registry key so it starts at sign-in. Node.js 22.19 or newer must be on PATH. The installer leaves a copy of itself in the machine directory; `node <machine-dir>\install-machine-windows.mjs --stop|--start|--uninstall --host-id <id>` manages the daemon. On an invalid credential the server returns a script that throws the reason.

The installer accepts `--bootstrap-env <NAME>` and uses the same enrollment command. It installs a private CLI and supplies `~/.local/bin/omnyo` without replacing an existing path. Non-login transports can use `command -v omnyo` with `~/.local/bin/omnyo` as a fallback. On Linux, the installer retries the user systemd bus using the current user's runtime path from `loginctl` when the caller's session environment is incomplete. If the bus is still unavailable on a systemd host, installation fails before enrolling; containers and machines without systemd as init run a detached daemon. `OMNYO_INSTALL_SKIP_SERVICE=1` explicitly leaves a detached daemon without startup after reboot. The temporary daemon used for a first join is not supervised; when the installer starts a previously joined daemon without a service, its launcher restarts it after crashes and self-updates while running. systemd and launchd services provide persistent restarts.

Machine bootstrap v2 supplies optional server request headers. `omnyo machine enroll`
persists them privately as `serverHeaders`; the launcher passes `OMNYO_SERVER_HEADERS`
to the daemon for enrollment, connection and runtime requests. Server-access
plugins redeem provider codes on the server. Pending encrypted v1 bundles are
upgraded by the server when prepared again.

Delivered enrollment bundles from v1 remain valid until their expiry. The CLI accepts both file and environment forms, upgrades the bundle to v2 headers locally, and persists legacy Connect redemption before enrollment so a retry reuses it. The installer upgrades v1 environment bundles before authenticated artifact downloads.

## Existing machines

`omnyo machine create --provider manual` waits for a private enrollment command,
prints it once, and follows the host until the daemon connects. Run that command on the target
machine; it installs Omnyo if needed. Server access is resolved through the selected
default access provider, just like SSH or cloud machines. `--no-wait` returns the
creating host ID. The CLI prints the setup code and short commands with their
expiry, then the full enrollment command for macOS and Linux, the
PowerShell command for Windows, and their expiry while it follows. This command is built transiently from the in-memory pending bundle;
durable host progress contains no credential. After enrollment or removal, the
host-keyed command endpoint returns no command. Treat it as a credential.

Use `omnyo machine show <host-id>` to recover progress and
`omnyo machine remove <host-id>` to cancel and revoke enrollment/access. Stopping
the CLI or closing the dialog only stops following; creation continues.
Manual machines never idle-suspend or automatically retire and do not expose
suspend/resume. Removing one revokes its server access without executing on the
machine. Run the original installer with `--uninstall --host-id <host-id>` on that box, with its
original `OMNYO_DATA_DIR` if explicitly configured, to remove its installation.
Removing a persistent machine cleans up its workspaces first when it is online.
If it stays offline for two minutes, removal finishes without that cleanup, and
`omnyo environment show <id>` names each Omnyo-created path it did not clean up.

## Away machines

`omnyo machine away <id-or-name>` marks a machine Away, for example while you play
a game on it. Omnyo stops its running threads, ends every remaining agent process
on a Windows machine through its Omnyo host job, and holds new turns for that
machine with a "waiting while <machine> is Away" reason. Away is stored on the
server, so it survives restarts and reconnects; a reconnecting Away machine has
its agent processes ended again. `omnyo machine available <id-or-name>` releases
the held turns. The same switch is in Settings -> Machines -> <machine> ->
Availability, and the SDK exposes `hosts.experimental_setAvailability`.
`omnyo machine list` shows `connected, away` for an Away machine.

## Agent memory limit on Windows

Windows daemons run all agent provider processes and their descendants in one
below-normal-priority job capped at half of physical memory. Allocations past
the cap fail inside the job instead of paging the machine. Set
`omnyo-app env set OMNYO_AGENT_MEMORY_LIMIT_MIB <MiB|off>` on that machine, with
its daemon's `--data-dir` when not the default, and restart its daemon to
change it.

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

`omnyo machine env list --json` lists global machine variables and built-in GitHub
health. `omnyo machine env set NAME [--note text] --json` reads its value
from stdin, removing one trailing newline; values are never accepted in argv.
`omnyo machine env unset NAME --json` removes an override. All values are encrypted in the database and never returned by list or set.

Settings → Environment variables edits variables inline. Add, remove,
then Save variables; Discard changes leaves saved values
untouched. Saved secrets can be replaced but never revealed. The automatic
GH_TOKEN row shows server login health; a custom GH_TOKEN overrides it. User variables
override built-in values on every connected host, including the primary host.
Agent-provider variables win over these host values for agent turns. The server synchronizes these values into the daemon environment at connection
and whenever settings change. Background commands and newly launched processes
inherit them, including git and gh operations. Removing an override restores the
original daemon value. Existing processes and terminals retain their launch
environment. Environment synchronization does not restart cached provider
runtimes; they retain their launch environment until recreated. Runtime output is forwarded as-is,
so commands and providers can print contributed values.

Plugin host calls start immediately using the current environment while any calls
are active in that plugin worker. Changed or removed machine variables take
effect on the next call after all active calls finish. Continuous overlapping
calls can keep the previous values until the worker becomes idle.

The server's gh login provides GitHub credentials, a Git environment-only HTTPS
helper and SSH rewrites, and commit identity to non-primary hosts. The primary
host uses its local Git authentication unless a user supplies an explicit global
or project GH_TOKEN. The built-in row reports logged in,
not logged in, or overridden. No credentials are installed in images or global
Git config. SDK: system.machineEnvironment() and
system.replaceMachineEnvironment({ variables }). Replacement is atomic; pass
every row to retain, using value: null for an unchanged saved secret.

Thread startup does not install or update agent CLIs, probe authentication, or validate workspace fingerprints. Core runs repository setup when creating an owned environment and teardown before removing it. Resume does not rerun setup.

`omnyo machine list --json` includes lifecycle phase, progress, and any suspension or resume error.
Maintenance interrupts active turns and closes terminals before saving. Submit a
new continuation turn after restore; interrupted turns are never reported successful.

Resuming a machine restores its provider state without rerunning environment setup.

Automatic GitHub credential forwarding to non-primary hosts is enabled by default. Use
`omnyo settings general machineGitCredentialsEnabled false` to stop forwarding the
server gh credentials to machines; `true` enables them again. In Settings →
Environment variables, the automatic GH_TOKEN switch controls the same setting.
This does not log the server out or suppress an explicit custom GH_TOKEN.
Changes apply to new turns, setup commands and terminals.

Manual enrollment commands display the server expiry timestamp as a countdown;
while a short setup code is shown, the countdown is the code's. When the code
lapses before the enrollment, the dialog shows the full command and its own
countdown. After expiry, Add a machine offers Generate new command: it cancels the old
attempt and creates a fresh one. Manual owns the command and expiry in memory;
polling does not renew it. Restart machine setup if the plugin or server restarts.

For a new thread on a new Modal sandbox, select the environment composition:
`omnyo thread spawn --project <id> --environment-provider modal-sandbox --prompt "..."`.
It creates the machine, prepares the project checkout, and runs environment setup.
Progress and failures appear in the thread's provisioning details. If cloning
fails, the machine remains available for retry or explicit removal.
`--new-machine <id>` requires an explicit `--environment-provider <id>`; machine
providers do not implicitly choose an environment.

`omnyo machine show` includes `threadStorageRootPath` from the latest daemon session
without waking the machine. It works offline and with no live threads; the path
is null before the first session. Reading details does not create directories.

### Web interface updates

`omnyo updates web status [--json]` reports the coordinator's web-only capability,
compatibility hash, active source and rollback generation.
`omnyo updates web apply --directory PATH [--replace-active ID] [--json]` uploads a
prepared app directory with `web-build.json` and activates it only when its runtime
fingerprint matches.
`omnyo updates web rollback [--replace-active ID] [--json]` restores the previous
interface, including the packaged interface after the first update. While a generation
is active, both commands refuse without `--replace-active` and its exact id from
`omnyo updates web status --json`; with no active generation the flag is optional and
takes `packaged`. The server rejects an id that is no longer active. Name a generation
only when you activated it yourself or were explicitly told to replace it. Neither
command restarts Omnyo or forces a page reload. Native changes still use the normal app update path.
