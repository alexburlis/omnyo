---
name: concurrency-limit
description: "Inspect or change global and per-host limits on concurrently running Omnyo threads, and overflow of waiting new chats to other machines."
---

# Concurrency limits

Use `omnyo concurrency-limit status --json` to inspect current limits, each
machine's detected system and tools, and overflow.

```sh
omnyo concurrency-limit global [unlimited|<limit>] [--json]
omnyo concurrency-limit host <host-id> [auto|<limit>] [--overflow on|off] [--tags a,b] [--json]
omnyo concurrency-limit overflow [on|off] [--json]
omnyo concurrency-limit needs <project-id> [<needs>|same-os] [--json]
```

Automatic host limits allow one thread per available processor. A thread that
Omnyo is compacting automatically before its prompt cache expires does not count
against a limit. Resolve the host with `omnyo machine list` before changing a
host limit. Omit the value to inspect it;
change limits only for the requested scope and verify the resulting status.

With overflow on, a waiting new chat whose machine is full starts on the
eligible machine with the most free slots. Needs are comma-separated from
`macos`, `windows`, `linux`, `arm64`, `x64`, `xcode`, `nvidia-gpu` and
`tag:<name>`; a project without needs keeps its machine's operating system.
Pinned chats, forks, child chats and chats in a machine's own checkout never
move. A chat whose first message mentions Xcode, iOS, iPhone, iPad, a
simulator, TestFlight, the App Store, releasing, shipping, deploying or
notarizing also stays home, and the plugin log names the word. To move one
waiting chat by hand, use `omnyo thread start-on <thread-id> --machine <machine>`;
without `--machine` it lists each machine and why it can or cannot take the
chat. A chat that moved and later needs the original machine runs those steps
there with `omnyo temporary-copy run`.
