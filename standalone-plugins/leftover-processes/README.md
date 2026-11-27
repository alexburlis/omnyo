# Task Manager

Chats start servers and scripts that outlive them. The starting shell exits, the
process moves to launchd, and it often sits in its own process group, so killing a
tree or a group misses it. This plugin shows what each chat left running, with its
memory, and stops it when the chat is archived or has been idle for 24 hours.

## How a process is tied to a chat

Every agent tool subprocess inherits `OMNYO_THREAD_ID` and `OMNYO_THREAD_STORAGE`. The host
entry reads them on macOS only, through a short Perl script that calls the kernel's
`KERN_PROCARGS2`. `ps -E` is not an option: it stops at the zeroed arguments of any
process that rewrites its title, such as `next-server`, so those would be missed.

- A process's environment is secret. The script prints only the three tags, so the rest
  never enters this plugin. Nothing else is returned, stored, logged or put in an error.
- A tag counts only when `OMNYO_THREAD_STORAGE` is under this machine's
  `<data dir>/thread-storage/`, so a dev Omnyo's chats are never touched.
- A process owns its own tag, or the tag of its nearest tagged ancestor.
- The plugin worker, its ancestors, and anything running from `<data dir>/app-versions/`
  are excluded.
- Daemons that any chat can start and every chat shares are excluded: `adb`,
  `gpg-agent`, `keyboxd`, `dirmngr`, `scdaemon` and 1Password's `op`. They use little
  memory, and stopping one can break another chat's work.

| Role       | Meaning                                                                    | Stoppable |
| ---------- | -------------------------------------------------------------------------- | --------- |
| `agent`    | A `claude` or `codex` whose ancestors reach `omnyo-provider-bridge-worker` | No        |
| `helper`   | Under an agent, through a direct child that is not a shell (an MCP server) | No        |
| `workload` | Everything else, including an agent CLI that lost its bridge               | Yes       |

Memory comes from `top` footprint for workloads, because RSS under-reports under
pressure. A pid that `top` did not return shows a labelled RSS reading.

### Inspection coverage

The list returns `coverage` as `complete`, `partial`, or `failed`. Memory and process counts are observed totals. Partial or failed inspection does not establish that the machine has no leftovers. The list retains the last successful inspection time separately from the latest attempt.

Mixed legacy and current ownership tags remain refused. The scanner holds that process and its descendants, reports the affected PID, and continues inspecting other processes. It never substitutes an ancestor owner for the held process.

### What it cannot see

macOS hides the environment of Apple platform binaries. A tagged `/bin/sleep` or
`/bin/zsh` shows no tags, while a tagged `node` or Homebrew `python3`
does. An orphaned Apple-signed process with no tagged ancestor therefore goes
unnoticed. This is why the integration test drives `node`.

## Machine and chat usage

`omnyo leftover-processes usage --json` and the read-only `usage` RPC return machine
CPU, GPU and physical memory, plus all attributed agent, helper and workload processes.
The sidebar resource toggle and Task Manager use this RPC. Plugin identity, CLI name
and existing panel paths remain unchanged.

Machine CPU measures the change in OS CPU counters over at least 250 ms, normalized
across all logical cores to 0–100%. Physical memory is OS total minus free memory,
including resident caches; it is not the sum of chat RSS. On macOS, GPU usage is the
highest `Device Utilization %` exposed by IOAccelerator. Windows machines with NVIDIA's
`nvidia-smi` use its `utilization.gpu`: the percentage of the driver's sample period
with a kernel executing, taking the busiest NVIDIA adapter. If the NVIDIA tool is
absent, Windows uses the busiest physical GPU engine after summing that engine's
process counters. Each command has a 2.5-second bound. An installed NVIDIA tool that
fails or reports unsupported utilization returns `null`, without substituting another
counter. Missing, refused or invalid GPU counters never become estimated utilization.
The [NVIDIA counter definition](https://docs.nvidia.com/deploy/nvidia-smi/) differs from
Windows engine utilization, so percentages need not match Task Manager.

Chat and task CPU is the change in process CPU time over a fresh interval of at least
250 ms, as a percentage of one core. Parallel work can exceed 100%. Chat memory sums
RSS, so shared pages can be counted more than once. These totals exclude unowned
processes and managed Cua guest memory. A task contains only its PID, safe executable
basename, CPU percentage and RSS bytes. Arguments and environment values are excluded.

The response is `{hosts: [{hostId, hostName, system: {cpuPercent, gpuPercent,
memoryUsedBytes, memoryTotalBytes}, coverage, threads: [{threadId, cpuPercent,
memoryBytes, tasks: [{pid, name, cpuPercent, memoryBytes}]}]}]}`. Every known host remains
represented. Process attribution is macOS-only: Windows can report machine metrics
while chat coverage remains `unsupported`. Unreachable hosts report `failed` and null
machine metrics. Ownership conflicts or process identity changes report `partial`;
an unavailable CPU sample is `null`, not zero. An absent chat has zero observed usage
only on a host with complete attribution coverage. Coverage describes chat attribution;
check each machine field for `null` independently.

Concurrent requests share one in-flight collection at both the server and host. Each
host measurement has an eight-second bound, and the server reads at most four hosts
concurrently. Usage reads never change cleanup snapshots, CPU baselines, keep records,
history or scheduling.

## When a process stops

`decide` in `policy.ts` is the one place this is decided. The first match wins.

| Order | Condition                                                                                  | Disposition               |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------- |
| 1     | The user kept it, or an ancestor                                                           | `kept: user`              |
| 2     | It or an ancestor set `OMNYO_KEEP_RUNNING=1`                                               | `kept: launch-env`        |
| 3     | The chat is `starting`, `active`, `stopping` or `pending`                                  | `in-use`                  |
| 4     | Any workload in the chat used over 5% of a core since the last sweep, or has no sample yet | `waiting: busy`           |
| 5     | The chat has open work, or it cannot be read                                               | `waiting: open-work`      |
| 6     | `autoStop` is off                                                                          | `waiting: timer`, no time |
| 7     | Under 24 hours since the plugin was installed                                              | `waiting: notice-period`  |
| 8     | The chat's timer has not ended                                                             | `waiting: timer`          |
| 9     | Otherwise                                                                                  | `stop`                    |

An idle chat's timer ends `idleHours` after its `updatedAt`. An archived chat's timer
ends 60 seconds after `archivedAt`, which covers the 30-second undo window. A chat the
server answers with `thread_not_found` has no timer. Any other failure reading a chat
holds its processes and shows the failure.

Open work means a wait, background activity, a required answer, a postponement, or
unverified ownership in the thread work summary. A failed run alone is not open work,
so a crashed chat's leftovers still stop.

Stop verifies each pid and start time immediately before signalling, sends SIGTERM,
waits up to 10 seconds, then sends SIGKILL to survivors.

## Using it

The Task Manager panel lists processes by machine and chat. A chat shows a companion
card only while it has leftovers. The title bar toggle for that card is owned by Omnyo
and appears on every chat.

See [the skill](skills/leftover-processes/SKILL.md) for the commands. The panel and CLI
call these RPCs, which other plugins can reach through `plugins.callRpc`: `list`, `stop`,
`keep`, `unkeep`, `sweep`, `history` and `usage`.

| Setting     | Default | Effect                                            |
| ----------- | ------- | ------------------------------------------------- |
| `autoStop`  | `true`  | When off, sweeps report and never stop anything   |
| `idleHours` | `24`    | Hours a chat stays idle before its leftovers stop |

## Development

Run the checks on Node 22 (`.nvmrc`). The linked SDK's `better-sqlite3` is built for it.

```sh
pnpm install
npm run verify
```

`threads.experimental_work` and `experimental_threadCompanion` exist only in the private
SDK, so `package.json` pins the vendored artifact built from
`omnyo/packages/plugin-sdk`, as Glance and Tidy do.

## Managed Cua runtimes

The Cua adapter supports the installed local Linux runtime backed by Colima. It preserves sandbox disks and data when it stops the shared VM. It does not start or create VMs.

Inspect existing infrastructure with `omnyo leftover-processes cua observe --host <hostId> --json`. Observation does not grant ownership or enable cleanup.

For a new job-owned sandbox, register it before launching work:

```sh
omnyo leftover-processes cua register --host <hostId> --thread <threadId> --sandbox <name> --consumer <jobId> --managed --json
omnyo leftover-processes cua release --resource <resourceId> --consumer <jobId> --thread <threadId>
```

Management requires a newly created sandbox with verified startup processes. Unknown startup variants and pre-existing work are refused; those resources remain available for observation. Acquire another consumer before another job uses a registered resource, and release it when that job finishes. A forgotten consumer is expired only when its owner has verifiably finished and has no open work. Active or unknown owners retain their consumers.

The existing sweep waits five minutes after the last consumer leaves. Another sandbox, an unregistered container, a connected client, additional guest work, a changed process identity, or failed inspection holds shutdown. Auto-stop off and Keep running also prevent shutdown. Uncertain shutdown outcomes require `cua reconcile`; they are never silently replayed.

After the normal Cua owner resumes a stopped sandbox, its original owner can use `cua acquire` with the same resource ID. The adapter verifies the original container identity and a new idle VM binding before accepting the job. A replaced sandbox cannot inherit the old ownership record.

The panel and `cua list` show the owner, retention reason and cleanup deadline. Memory is labelled as the last observation, not a continuously live measurement. The plugin RPC contract exposes the same registration, observation, consumer, keep and reconciliation operations.
