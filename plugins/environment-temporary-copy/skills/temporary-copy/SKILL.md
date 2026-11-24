---
name: temporary-copy
description: "Use when a chat runs in a temporary copy on another machine because its own was full: run Xcode builds, simulators, git push or releases on the original machine, and sync commits back."
---

# Temporary copies

A chat whose transcript starts with "Started on <machine> because <machine> was
full." and whose workspace is under
`plugins/environment-temporary-copy/host-data/copies/` runs in a temporary copy.
Omnyo also adds a note to such a chat's instructions naming both machines. Commit
there as usual. Omnyo copies the commits back to the original checkout after each
turn and before the copy is deleted.

The copy's machine may lack tools the original machine has, such as Xcode,
simulators or release access, and the copy has no git remote. Run those steps
on the original machine:

```sh
omnyo temporary-copy run "$OMNYO_THREAD_ID" -- xcodebuild -version
omnyo temporary-copy run "$OMNYO_THREAD_ID" -- 'git push origin HEAD:main'
```

`run` sends your commits and uncommitted changes, runs the command on the
original machine in a checkout of this chat's branch, prints the output, exits
with the command's exit code and brings back commits the command made. One
quoted argument is run as a shell command; several arguments are quoted for you.
`OMNYO_THREAD_ID` is set for the command, so release tooling reports back to this
chat.

For a job longer than about ten minutes, start it detached, follow it, then
bring back its commits:

```sh
omnyo temporary-copy run "$OMNYO_THREAD_ID" --detach -- pnpm private:ship --version X.Y.Z
omnyo terminal output <terminal-id>
omnyo temporary-copy pull "$OMNYO_THREAD_ID"
```

When a pull reports that the copy could not fast-forward, the commits are at
`refs/omnyo/from-origin` in the copy; merge them yourself. Uncommitted files a
command leaves on the original machine are listed, not copied back.

Commits that build on history this copy lacks, for example after a step
merged or rebased onto newer `main`, cannot come back. The output names the
ref that keeps them on the original machine; push or merge them there with
another `run`. `run` and `pull` refuse while a step still runs or its
machine is reconnecting; follow the terminal they name, then retry.

To copy commits back without running anything, use
`omnyo temporary-copy sync "$OMNYO_THREAD_ID" --json`. It names the original machine,
checkout and branch. When `branchUpdated` is false, the branch was rewritten or
is checked out there, and the work is under
`refs/omnyo/temporary-copy/<thread-id>/` in that checkout instead.
