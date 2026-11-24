---
name: wait-sources
description: "Wait on an outside event with omnyo wait --event: a URL answering (http), a file existing on a machine (file) or a shell command succeeding (command); or build a new event source for something else."
---

# Wait on outside events

Use these keys with `omnyo wait --event <key>` when Omnyo itself can check the
event. Prefer a callback, a sub-chat or `--chat` when another Omnyo chat or job
will report the result. Run `omnyo wait sources` for every installed family and
its health.

| Key                                | Fires when                                                | Approval |
| ---------------------------------- | --------------------------------------------------------- | -------- |
| `http:<url>`                       | The URL answers with a 2xx status                         | Owner    |
| `http:<url>#<text>`                | It answers 2xx and the first 256 KB contain `<text>`      | Owner    |
| `file:<hostId>:<absolute path>`    | The file or folder exists on that machine                 | None     |
| `command:<hostId>:<shell command>` | The command exits 0 on that machine; stdout is the result | Owner    |

Before you wait, run `omnyo wait check <key>`. It validates the key and runs one
check: `Fires now`, `Not yet`, or the error.

```sh
omnyo wait check "file:host_j3eq7xguuw:/tmp/build-done"
omnyo wait --self --key build-done --for "The build writes /tmp/build-done" \
  --event "file:host_j3eq7xguuw:/tmp/build-done"
```

## Rules

- **Owner approval.** Your wait on an `http` or `command` key becomes a
  proposal. The owner sees the exact URL or command and accepts it from the
  Inbox; nothing runs before that. Only the owner can dry-run these keys. Say in
  your final message what the wait will run and why.
- **Not yet versus a problem.** A non-2xx answer, a connection error, a
  missing file, a non-zero exit and a disconnected machine all mean "not yet":
  the chat keeps waiting until the deadline. An unknown machine, a malformed
  key, a command that is not found (exit 126 or 127) or one that runs past 20
  seconds is a problem; after three in a row the owner sees "Can't check".
- **Cadence.** Omnyo checks `http` and `file` keys every minute and `command`
  keys every two minutes while a wait is pending.
- **Commands.** One line, at most 400 characters, run in the machine's home
  directory by its default shell. Keep them read-only and quick, such as
  `test -f`, `curl -fsS`, or `gh run view <id> --json status -q .status | grep -q completed`.
  They get the machine's environment without Omnyo's variables.
- **URLs.** Use http or https without credentials in the URL. The text after
  the first `#` is what to look for; Omnyo never sends a URL fragment.
- **Machine ids.** `omnyo machine list` shows them. The id goes before the first
  colon; the path or command follows it.

## Build a source for something else

When no family fits, such as a ticket tracker, a deploy service or a queue,
make a plugin that registers its own family:

1. Run `omnyo plugin new <name> --event-source`. The scaffold registers one
   family with `api.experimental_eventSources.register`, and has tests and a
   skill.
2. Edit `validate`, `describe` and `poll.check` in `server.ts`. Return
   `{ target, result }` for fired targets and `{ target, problem }` for targets
   that cannot be checked; throw only when the whole source cannot check.
3. Run the plugin's tests, then `omnyo plugin install .`.
4. Run `omnyo wait sources` and `omnyo wait check <family>:<target>`.

The omnyo-plugin-authoring skill has the full contract in its
backend-event-sources.md reference: backoff, proofs, owner approval, push
sources and machine access.
