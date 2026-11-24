Run a waiting chat on a free machine that has no checkout of its project. Omnyo copies the original machine's exact base commit there for that chat, copies the chat's commits back to the original checkout, and deletes the copy once its work is safe.

## What you get

- A temporary copy of the project's base commit on the free machine, about 50 MiB for omnyo, built from the same branch rule as a worktree.
- The chat's commits back on its branch in the original checkout after every turn, and on demand with `omnyo temporary-copy sync <thread-id>`.
- Every branch, tag, stash entry, HEAD and uncommitted file preserved under `refs/omnyo/temporary-copy/<thread-id>/` before the copy is deleted.
- Steps that need the original machine, such as Xcode builds, simulators, `git push` or releases, run there from the same chat with `omnyo temporary-copy run`. Omnyo tells each chat in a copy how.

## How it works

The concurrency-limit plugin's overflow uses this provider when it moves a waiting chat to a machine without the project. The original machine packs the base commit; Omnyo relays the pack in checked chunks; the free machine builds a shallow repository from it and runs the project's setup script. Copy-back sends only objects the original checkout lacks and never touches its working trees. If a branch was rewritten, is checked out or is being rebased in an original worktree, the side refs hold the work instead.

Archiving deletes the copy only after the original machine confirms every ref. If that machine is offline, or the copy contains a nested repository it cannot preserve, the copy stays and Omnyo retries; after about 15 minutes it shows Needs recovery with the copy intact until `omnyo environment cleanup`.

A step run on the original machine uses a checkout of the chat's branch in this plugin's data folder there, reset to the copy's commits and uncommitted changes before each run. The checkout is a locked git worktree, so storage cleanup leaves it alone. Commits the step makes come back to the copy; uncommitted files it leaves are listed, not copied. `run` and `pull` refuse while an earlier step still runs or its machine is reconnecting. Archiving deletes that checkout and stops any step still running in it.

Commits a step made that cannot come back stay in the original repository at `refs/omnyo/temporary-copy/<thread-id>/origin-HEAD`, unless another ref already holds them. This covers commits that build on history the shallow copy lacks, such as a merge or rebase onto newer `main`, and commits nobody pulled before the next run or archive.

The preserved refs stay in the original repository. Remove a chat's refs once its work is merged with `git for-each-ref --format='delete %(refname)' refs/omnyo/temporary-copy/<thread-id>/ | git update-ref --stdin`.

## For agents and scripts

- `omnyo temporary-copy run <thread-id> -- <command>` runs a command on the original machine in a checkout of the chat's branch and prints its output; add `--detach` for long jobs.
- `omnyo temporary-copy pull <thread-id>` brings back commits a detached run made.
- `omnyo temporary-copy sync <thread-id>` copies the commits back without running anything.

Pushes and deliveries happen on the original machine; the copy has no push remote.
