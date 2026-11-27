---
name: leftover-processes
description: "Measure per-chat CPU and memory, see and stop what chats left running, and keep a process that must outlive its chat. Use BEFORE starting anything long-running that should survive the chat (a server, a watcher, a long job, a Cua Linux sandbox), when memory is short, or when asked what a chat left behind. Covers `omnyo leftover-processes` and `OMNYO_KEEP_RUNNING`."
---

# Task Manager

Omnyo stops the processes a chat leaves behind. A process stops 60 seconds after its
chat is archived, once its chat has been idle for 24 hours, or when its chat is
deleted.

## Keep a process that must outlive its chat

Do one of these before the chat ends, or Omnyo stops the process:

- Start it with `OMNYO_KEEP_RUNNING=1`, for example `OMNYO_KEEP_RUNNING=1 pnpm dev`.
- Mark a running process with `omnyo leftover-processes keep <pid>`. The keep also
  covers everything that process started.

## Commands

| Command                                                                        | Use                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `omnyo leftover-processes usage [--json]`                                      | Machine CPU/GPU/memory, chat RSS and CPU, and safe task names             |
| `omnyo leftover-processes list [--all] [--thread <id>] [--host <id>] [--json]` | Fresh scan with memory and next step. `--all` adds chats that are running |
| `omnyo leftover-processes stop <pid...> [--host <id>]`                         | Stop processes and what they started                                      |
| `omnyo leftover-processes keep <pid> [--host <id>]`                            | Keep a process after its chat                                             |
| `omnyo leftover-processes unkeep <pid> [--host <id>]`                          | Let a kept process stop with its chat                                     |
| `omnyo leftover-processes sweep [--thread <id>] [--now]`                       | Check now and stop what is due                                            |
| `omnyo leftover-processes history`                                             | Recent stops                                                              |

`sweep --thread <id> --now` skips the timers and the first-day notice period for
that chat. It still leaves running chats, busy processes, open work and kept
processes alone.

## What is never stopped

- The chat's agent and its MCP servers. `stop` refuses them.
- Daemons chats share: `adb`, `gpg-agent`, `keyboxd`, `dirmngr`, `scdaemon` and `op`.
- Anything in a chat that is running, busy or has open work.
- A process using more than 5% of one core. A long job finishes first.

## Check inspection coverage

Read `coverage` with the JSON counts. `complete` means the returned host inspections succeeded; `partial` means the counts cover only observed processes; `failed` means usage is unknown. A nonzero `list` exit code marks incomplete inspection. Never interpret zero observed bytes as a clean machine when coverage is incomplete.

Mixed legacy/current process ownership tags are held with their descendants. Other owned processes remain visible. Inspect the host failures and last successful inspection time before deciding what can stop.

The read-only `usage` RPC accepts `{}` and returns each host's `hostName`, `system`
CPU/GPU and used/total physical memory, chat `coverage`, and `threads`. Each thread has
CPU, RSS and `tasks` containing PID, executable basename, CPU and RSS. Task names never
include arguments or environment values. Machine CPU is normalized across all cores;
chat and task CPU use one-core percentages and can exceed 100%. Both use fresh deltas
over at least 250 ms. Physical memory includes resident caches; shared pages can be
counted more than once in chat RSS.

Unknown metric values are `null`. GPU values come from macOS IOAccelerator device
utilization, NVIDIA driver utilization on Windows when `nvidia-smi` is installed,
or Windows GPU engine counters when it is absent, never estimates. A failed or
unsupported NVIDIA counter stays unknown; it does not switch counters. Windows machine metrics
can be available with `unsupported` chat coverage. Coverage describes chat attribution,
so inspect the system fields separately. Failed and unsupported chat inspections must
not be displayed as zero chat usage. These measurements do not change cleanup state.

## Limits

Process attribution and cleanup work on macOS only. macOS hides the environment of Apple-signed programs
such as `/bin/sleep` and `/bin/zsh`, so Omnyo finds one of those only while a process
with a visible chat tag is its ancestor.

## Cua Linux sandbox ownership

Inspect manual or existing Cua infrastructure with `omnyo leftover-processes cua observe --host <hostId> --json`. Never register someone else's sandbox as managed.

For a fresh sandbox created for this job, register ownership before launching work:

```sh
omnyo leftover-processes cua register --host <hostId> --thread <threadId> --sandbox <name> --consumer <jobId> --managed --json
```

Keep the returned resource ID. Acquire a consumer before each additional job uses it, and release that consumer in the job's completion path:

```sh
omnyo leftover-processes cua acquire --resource <resourceId> --consumer <jobId> --thread <threadId>
omnyo leftover-processes cua release --resource <resourceId> --consumer <jobId> --thread <threadId>
```

Use `cua keep` for an intentionally persistent runtime and `cua unkeep` to allow cleanup. `cua list --json` reports ownership, consumers, retention reasons and deadlines. `cua reconcile` resolves an uncertain stop before further cleanup. Run `omnyo leftover-processes cua help` for flags.

Cleanup stops an owned unused shared VM through its supported runtime owner and preserves disks. It holds for active clients, additional work, unregistered sandboxes, unknown ownership or failed inspection. Existing or unsupported sandbox startup states remain observed. After the normal Cua owner resumes a stopped sandbox, reacquire the original resource; do not create a new ownership record for the old container.
