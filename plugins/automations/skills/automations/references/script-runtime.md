# Automation script runtime

Read this file before you use a script file or depend on the script runtime.

## Stored script files

`--script-file` reads a file through the host file API. A relative path starts
at the current directory.

Inside a thread, the command reads from the thread environment host. Outside a
thread, it reads from the server host. Use `--host <name-or-id>` for another
machine.

The plugin stores a private copy under
`<data dir>/plugins/automations/scripts/<automationId>/`. Runs use this copy.
Source edits do not apply until an update copies the file again.

The create and update commands print the exact refresh command; it keeps the
interpreter, timeout, variables, and working directory. The create,
update, and show commands print the stored path on the `Script:` line. JSON
output returns it as `execution.storedScriptPath`.

## Script execution host

Automations settings expose `scriptHostId`. Leave it empty to run scripts on
the Omnyo server. Set an enrolled host ID to run all script automations there,
then run `omnyo plugin reload automations`. The same setting is available through
`omnyo plugin config automations set scriptHostId <host-id>` and SDK
`plugins.updateSettings`. The server stores definitions and script copies; the
selected host runs the code through the private host worker interface.
An unavailable host fails the run without local execution.

Remote scripts use the configured Omnyo app URL for `OMNYO_SERVER_URL`. Their stored
copies live at `<host data dir>/plugins/automations/host-data/scripts/<automationId>/`
with the original filename. Adjacent script state and output remain there across
runs. Remote inherited environment uses the host worker's sanitizer; explicit
saved environment values and the automation IDs are preserved.

Held direct-access preparation captures the original server host as the script
execution host if no explicit setting exists. Repeating preparation preserves
the captured owner and all automation definitions.

## Working directory

Every script stores `execution.workingDirectory` as one of these policies:

- `{"type":"automation-storage"}` uses the plugin's shared script storage
  directory
  `<data dir>/plugins/automations/scripts/`. Every automation on this policy
  shares it; remote scripts use the selected host’s `host-data/scripts/` directory.
  Each automation's stored script lives in a subdirectory of it,
  not in the working directory itself.
- `{"type":"project"}` uses the project's source on the script execution host.
- `{"type":"path","path":"/absolute/path"}` uses that directory on the script
  execution host.

New standard-project scripts default to `project` when that project has a
source on the script execution host. Personal scripts and projects without
such a source default to `automation-storage`. Automations stored before this
field existed also decode as `automation-storage`, so an upgrade does not
silently change their relative
paths. Updating an existing script preserves its current policy unless the
update includes `--working-directory`; changing an agent automation to script
uses the same source-aware default.

Use `--working-directory automation-storage|project|<absolute-server-path>` on
create or
update. A `project` policy fails if the project has no source on the script execution
host. An explicit path must be absolute and an existing directory. The run
fails instead of silently using another directory when either selection is
unavailable.

The create, update, and show commands print the directory the script actually
runs in on the `Working dir:` line, or `unavailable` when a `project` policy
has no source on the script execution host. JSON output returns it as
`execution.resolvedWorkingDirectory`, which is `null` when unavailable or when
remote host storage is selected; that path is resolved on the host at execution.
The `list` result carries the stored policy only, without this resolution.

A failed run's summary includes its exit code and a terminal-control-stripped
first non-empty stderr line. The complete captured stdout and stderr remain
available unchanged in run output.

## Variables and CLI lookup

The plugin injects these variables:

```text
OMNYO_SERVER_URL          The Omnyo server API base URL
OMNYO_PROJECT_ID          The automation project
OMNYO_AUTOMATION_ID       The automation ID
OMNYO_AUTOMATION_RUN_ID   The run ID
OMNYO_CLI                 The absolute omnyo CLI path, when available
```

The plugin does not inject `OMNYO_ENVIRONMENT_ID` or `OMNYO_HOST_DAEMON_PORT`.
Scripts do not inherit the server's or host's own `OMNYO_*`
variables; the variables above are the only ones the plugin sets.

The plugin resolves `omnyo` from `OMNYO_CLI`, `OMNYO_CLI_DIR`, `PATH`, and common
macOS install paths. It adds the selected directory to `PATH`.

If the plugin cannot find `omnyo`, the script still starts. Its output starts with
an `[omnyo] warning:` line. A later `omnyo` call then fails normally.

## Execution safety

- An automation has at most one active run. A duplicate tick or manual request
  uses the active run.
- Failed recurring runs retry after 30 seconds and then 60 seconds, but never
  later than the next scheduled run. The third
  consecutive failure pauses the automation. Transient agent failures (provider
  overload, rate limits, dropped connections, 5xx responses, or a turn that
  failed while the plugin was restarting) keep retrying with growing backoff
  and never pause it. A script run whose script host is
  offline is skipped instead and waits for its next scheduled time, so a
  coordinator restart or a disconnected machine cannot pause the automation.
- Agent recovery keeps the failed thread and original turn request chain. An
  already queued or running provider retry is adopted with its existing delay.
  Recovery never spawns a replacement thread for that failed run. A later
  unrelated turn supersedes recovery; the next regular schedule starts normally.
- A successful or skipped run clears the failure count. A resume command also
  clears the count.
- An unavailable target thread disables every enabled automation that targets
  the thread immediately. This path does not retry and does not use the failure
  count. The plugin treats a thread as unavailable when it is missing, deleted,
  archived, pending, starting, or stopping. A target thread whose last turn
  failed stays available: the next run starts a new turn in it.
- Run completion, a timeout, or an output limit stops remaining processes in
  the script's process group. Scripts cannot leave background work running in
  that group after a run completes. On Windows, only the direct child is
  stopped. A process that starts its own session or process group, such as
  `setsid`, `tmux`, or a daemon, leaves the script's group and is not stopped.
- Startup settles runs interrupted by a server restart or plugin reload.
  Script runs without a process become skipped.
- Agent runs without a thread become skipped. Other agent runs follow their
  thread state. A run whose thread is idle becomes succeeded with an
  `interrupted` reason, because Omnyo did not see the turn finish.

An exit-zero run with no output is a silent skipped tick. A final non-empty
line of `{"wakeAgent": false}` has the same result.
