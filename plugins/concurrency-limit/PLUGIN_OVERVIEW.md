Keep Omnyo from starting more agent threads than your machines can handle. When a limit is reached, new turns wait in line and start as soon as a running thread goes idle. With overflow on, a waiting new chat starts on another machine that has room instead.

## What you get

- An automatic limit for each host: one running thread per available processor.
- A per-host override. Set a fixed number, or set it back to `auto`.
- An overall limit across all hosts, or `unlimited`.
- Overflow: a new chat that waits for a full machine starts on a free machine that meets its project's needs.
- A Settings section that lists every host with its capacity, detected system and tools, its limits, and whether it takes overflow.

## How it works

Before Omnyo sends a message to an idle thread, the plugin counts the threads that are running. If the count meets the limit for that host, or the overall limit, the message waits. The thread shows why it waits. A message to a thread that is already running is not held. A thread that Omnyo is compacting automatically before its prompt cache expires does not count. When a thread goes idle, fails, is archived, or finishes that compaction, the plugin rechecks the line.

With overflow on, a waiting new chat moves before its first turn when its machine is full and the overall limit still has room. The plugin picks the eligible machine with the most free slots. A machine is eligible when Omnyo can start the chat there, the machine takes overflow, and it meets the project's needs. A project without declared needs stays on machines with the same operating system as the machine it was started for. Each machine reports its system, architecture, full Xcode and NVIDIA GPU, and can carry tags such as `dia` for things Omnyo cannot detect.

Only new chats move. A chat started on a machine you picked stays there, and so do forks, child chats and chats working in a machine's own checkout. A chat whose first message mentions Xcode, iOS, a simulator, TestFlight or releasing also stays on its machine, because those steps usually need it. A chat that moved and later needs its original machine runs those steps there from the same chat with `omnyo temporary-copy run`. A moved chat's transcript starts with "Started on Mac Air because Mac Pro was full." A chat never changes its model or permission mode by moving; a machine that cannot serve them is skipped.

## For agents and scripts

Use the `omnyo concurrency-limit` command:

- `omnyo concurrency-limit status` shows the effective limits, machine facts and overflow.
- `omnyo concurrency-limit global unlimited|<limit>` sets the overall limit.
- `omnyo concurrency-limit host <host-id> auto|<limit>` sets one host.
- `omnyo concurrency-limit host <host-id> --overflow on|off --tags a,b` sets whether a host takes overflow and its tags.
- `omnyo concurrency-limit overflow on|off` switches overflow.
- `omnyo concurrency-limit needs <project-id> <needs>|same-os` sets what a project's chats need, from `macos`, `windows`, `linux`, `arm64`, `x64`, `xcode`, `nvidia-gpu` or `tag:<name>`.

Add `--json` for machine-readable output. Limits go from 0 to 10000. A limit of 0 holds every new turn in that scope. To move one waiting chat by hand, use `omnyo thread start-on <thread-id> --machine <machine>`.

## Credits

Maintained and extended by Omnyo, based on the [concurrency-limit plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/concurrency-limit). Thank you to Michael Yong and the bb contributors for the original work. The upstream code is [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong.
