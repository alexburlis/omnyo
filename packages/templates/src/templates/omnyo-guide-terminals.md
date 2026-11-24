---
kind: instruction
title: Omnyo Terminal Guide
summary: Creating and managing persistent terminals across thread, environment, and machine scopes.
intent: Help agents route terminal sessions explicitly and manage them by terminal ID.
editingNotes: Keep scope selectors and ID-only commands aligned with omnyo terminal --help.
---
Terminal commands

Use terminals for long-running commands that should stay alive for the user,
such as dev servers, watch tasks, REPLs, and database consoles. A terminal is a
real persistent PTY and appears in the Omnyo UI.

List and create require exactly one explicit scope:

  omnyo terminal list --thread <thread-id>
  omnyo terminal list --environment <environment-id>
  omnyo terminal list --machine <id-or-name> [--cwd <path>]

  omnyo terminal create --thread <thread-id> --command "pnpm dev"
  omnyo terminal create --environment <environment-id>
  omnyo terminal create --machine <id-or-name> [--cwd <path>]
    --host <id-or-name>                   Alias for --machine
    --title <title>                       Display title
    --cols <n>                            Initial terminal columns
    --rows <n>                            Initial terminal rows
    --attach                              Attach after creating
    --json                                Print machine-readable output

Machine names are resolved to an explicit machine ID. No scope defaults to the
server machine, and --cwd is valid only with --machine or --host.

A terminal runs the machine's own shell: $SHELL (then zsh, bash, sh) on macOS
and Linux; on Windows, PowerShell 7 when `pwsh` is on PATH, otherwise Windows
PowerShell, otherwise cmd. Write --command in that shell's syntax. To run a
program with arguments without knowing the shell, pass them after `--`
(`omnyo terminal create --thread <id> -- pnpm test "my file.ts"`): the machine
quotes each argument for its own shell. `send --enter` presses Enter (a carriage
return), which every one of those shells accepts. The terminal's exit code is
the command's own exit code on every shell.

All other operations need only the terminal ID. They also accept the scope
flags above and ignore them, so a command built for `list` or `create` still
runs:

  omnyo terminal show <terminal-id>
  omnyo terminal attach <terminal-id>        Ctrl-B d detaches
  omnyo terminal send <terminal-id> --text <text> [--enter]
    --stdin                               Read bytes from stdin instead of --text
  omnyo terminal resize <terminal-id> --cols <n> --rows <n>
  omnyo terminal rename <terminal-id> <title>
  omnyo terminal restart <terminal-id>       Atomically replaces it with a shell; does not replay the original command
  omnyo terminal foreground <terminal-id>   Idle, the running command, or unknown (Windows)
  omnyo terminal close <terminal-id> [--if-clean]

  omnyo terminal output <terminal-id>
    --since-seq <n>                       Read output chunks from a sequence
    --tail-bytes <n>                      Bound output to latest N bytes
    --limit-chunks <n>                    Bound output to latest N chunks
    --json                                Print chunks, nextSeq, truncated, status, exitCode, and closeReason

  Output stays readable after the command exits: the machine keeps a finished
  terminal's scrollback for 30 minutes, until its daemon restarts, or until many
  newer terminals have exited. For an exited terminal the output is followed by
  `Terminal <id> exited with code N` on stderr. Once the scrollback is gone,
  output fails with `terminal_output_unavailable` and says why.

  omnyo terminal wait <terminal-id>
    --contains <text>                     Wait for new output containing text
    --regex <pattern>                     Wait for new output matching regex
    --exit                                Wait until the terminal exits
    --from-start                          Include existing scrollback
    --timeout <duration>                  Seconds, or a duration with a unit: 90s, 5m (default: 30s)
    --poll-interval <duration>            Milliseconds, or a duration with a unit (default: 500ms)

  When the terminal exits before the text appears, wait stops at once with exit
  code 124, the terminal's exit code, and the last output it printed. `--exit`
  prints the exit code. Text and regex matching ignore colors and other
  terminal escapes, so `--contains "Local:"` matches a bold `Local`.

For a dev server, prefer:

  omnyo preview register --thread <thread-id> --url http://localhost:4399/compare \
    --cwd /absolute/project/path -- /absolute/path/to/verified-launcher
  omnyo preview restart <preview-id>

Use the project's actual launch command and fixed port. Use a previously verified launcher, not a command inferred from the URL.

Managed preview servers

`omnyo preview` stores a server's exact executable, arguments, working directory,
owning environment and loopback endpoint. Registration stores the recipe without
starting it. Return the binding's original URL in chat; Omnyo uses localhost on a
confirmed owning device and its private preview link elsewhere.

  omnyo preview register --thread <thread-id> --url <loopback-http(s)-url> \
    [--cwd <absolute-path>] [--readiness-path <path-and-query>] -- <command...>
  omnyo preview list --thread <thread-id>
  omnyo preview show <preview-id>
  omnyo preview status <preview-id>
  omnyo preview restart <preview-id> [--request-id <id>]
  omnyo preview remove <preview-id>

All accept --json. Registration and show omit the private recipe. List returns
`{previews: [...]}`. Status returns the observed readiness state. Restart exits
0 only when online; other states return a `preview_not_ready` error with exit 1.
After a starting result, check `omnyo preview status <preview-id>` for readiness.
A restart that comes online adds a "Started <url>" step, with live status and
an Open action, once per turn (or once between turns). The step goes to the chat
whose agent ran the restart (`OMNYO_THREAD_ID`) when that chat is in the same
project, otherwise to the chat that registered the preview; archived chats get
none. A plain successful `omnyo preview restart <id>` command folds into it.
`omnyo guide previews` opens this chapter. The SDK exposes the same operations as
`sdk.previews.register/list/get/status/restart/experimental_remove`.

Remove deletes a saved recipe once nothing runs it, for example after its
workspace is gone; the chat's Dev servers shelf then drops it. The owning machine
must be connected and report no live run for the preview. A running or starting
server returns `preview_running` or `preview_restarting`; remove never stops a
server.

Restart ensures the recorded server is ready. A ready owned run is reused;
concurrent taps share one start. Keep the same request ID when retrying an
uncertain request. Restart never guesses a legacy command, kills a port occupant
or moves the server to another port. A foreign listener reports conflict.
An offline owning machine cannot be restarted through Omnyo until it reconnects.

Use an existing protected launcher or the environment's configured variable
references for credentials. Never put secret values in command arguments, chat
links or a registration payload. Do not adopt or stop an unrelated running
server to make registration look healthy. Terminal restart opens a shell and
does not replay a preview server's launch.

Do not run long-lived servers as one-off foreground commands when the user will
need to inspect logs, refresh the page, or stop the process later.
