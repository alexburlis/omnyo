# Worktrees, setup scripts, and teardown scripts

When you start a thread in Omnyo, you can run it in your project's existing
checkout or in a fresh **managed worktree** — a separate working copy on disk
with its own branch. Worktrees let Omnyo work on multiple things in parallel
without touching your main checkout, and they make it easy to throw away
whatever the agent does without affecting the rest of your work.

You can pair a worktree with a **`.worktreeinclude` file** that lists the local
files each new worktree needs, and with a **setup script** that Omnyo runs the
first time the worktree is created — useful for installing dependencies,
generating secrets, or anything else you need before the agent starts.
You can also add a **teardown script** that releases resources outside the
worktree before Omnyo removes it.

## What is a managed worktree?

A managed worktree is a `git worktree` of your project's repo, on a fresh
branch. Under the hood it's `git worktree add` plus some bookkeeping:

- It shares the repo's `.git` state with your main checkout — cheap to
  create, no full clone.
- It gets its own branch so multiple threads can run in parallel.
- It lives at
  `<OMNYO_DATA_DIR>/plugins/environment-git-worktree/host-data/worktrees/<thread-id>/<repo-name>`
  — for example, `~/.omnyo/plugins/environment-git-worktree/host-data/worktrees/thr_abc.../myrepo`.
- Once every thread using the environment is deleted, Omnyo cleans the worktree up
  (`git worktree remove --force`). Archiving the last thread starts a
  five-minute grace period instead, so unarchiving within it keeps the
  worktree; after it elapses the worktree is removed the same way.

Worktrees are created by Omnyo's built-in **Worktree** plugin, which is enabled by
default. Disabling it in Settings → Installed plugins leaves existing worktrees alone
but stops Omnyo from making new ones: a thread that asks for one waits until the
plugin is running again.

## Start a thread in a worktree

In the app, pick **Worktree** under the new chat box when starting a thread. On
a phone, pick it in the environment picker below the composer.

From the CLI:

```bash
pnpm omnyo thread spawn \
  --project <project-id> \
  --new-environment worktree \
  --prompt "..."
```

Omit `--base-branch` for Omnyo's smart default. A named branch such as `main`
uses `origin/main` when the local branch is equal to it or behind it, and keeps
the local branch when it is ahead or has diverged. `origin/main` and
`refs/heads/main` are honored exactly. Selected remote refs are fetched before
creation; when the fetch of an automatically chosen `origin/<name>` fails, the
worktree starts from its last fetched commit and the provisioning progress says
so.

New worktree branches start at the selected base without tracking it as an
upstream, even when Git's `branch.autoSetupMerge` is enabled. Publish with
`git push -u origin HEAD` to set the upstream to the task's remote branch.
Reusing an existing branch preserves its upstream configuration.

## Copy local files with `.worktreeinclude`

A new worktree checks out tracked files only. Your `.env`, your local
certificates, and anything else git ignores stay behind in your main checkout.

Commit a `.worktreeinclude` file at the root of your repo to list what a
worktree needs. It uses gitignore syntax — one pattern per line, `#` for
comments, `!` to negate an earlier pattern:

```gitignore
# Local credentials the agent needs
.env
.env.*
!.env.example
certs/
```

Omnyo copies every untracked file in the source checkout that matches a pattern,
after it creates the worktree and before it runs `.omnyo-env-setup.sh`. Your
setup script can therefore read the copied files.

Contract:

- Omnyo copies files. It does not create symlinks, and each worktree gets its own
  copy — an edit inside the worktree does not change your main checkout.
- Omnyo never replaces anything the worktree already has. If the branch tracks a
  file at that path, the tracked file wins and Omnyo reports the skip.
- Omnyo skips symlinks in the source checkout rather than copying their targets,
  and it never writes through a symlink in the worktree.
- A pattern that matches nothing, an unreadable file, or a failed copy is
  reported in the provisioning transcript. Provisioning continues.
- Large directories such as `node_modules` are copied file by file, which is
  slow. Install dependencies in `.omnyo-env-setup.sh` instead.

## Run setup with `.omnyo-env-setup.sh`

Drop a file named `.omnyo-env-setup.sh` at the root of your project. If Omnyo finds
one after an environment provider creates a path it owns (`ownsPath: true`), Omnyo
runs the script inside that path before handing the thread to the agent. Core
owns this policy for every provider. Attaching a project checkout or personal
workspace (`ownsPath: false`) does not run either hook. Provider-specific
preparation, including `.worktreeinclude` copying, finishes before setup starts.

Use it for anything the agent will need in a fresh checkout — install
dependencies, sync local state, generate tokens, etc. To bring local files in
from your main checkout, prefer `.worktreeinclude` above.

```bash
#!/usr/bin/env bash
set -euo pipefail

pnpm install
```

Contract:

- The script runs with `env bash`, working directory set to the new worktree.
- stdin is closed. stdout and stderr stream into the thread's provisioning
  transcript in the app.
- A non-zero exit, a signal, or a timeout (15 minutes) fails provisioning and
  the thread doesn't start.
- A bash script on every platform. On native Windows Omnyo runs it with the bash
  that Git for Windows installs and fails with a message naming Git for Windows
  when there is none.

## Cleanup

You don't need to clean up worktrees by hand. The Worktree plugin watches every
worktree it made and removes the ones nothing is using:

- Deleting the last thread on a worktree removes it right away.
- Archiving the last thread starts a five-minute grace period. Unarchive a
  thread within it and the worktree is kept; let it elapse and the worktree
  goes.
- Archiving is not an instant stop. For 30 seconds an archived thread keeps its
  terminals, and one that is mid-turn keeps running, so Undo on the archive
  toast — or an unarchive within those 30 seconds — picks up exactly where it
  was. After that Omnyo stops the thread and closes its terminals.

Removal runs `.omnyo-env-teardown.sh` inside the worktree and checks Git state
and workspace consumers before removing the checkout. The branch keeps its
commits in the shared Git store. Changed files, untracked files, and ignored
artifacts require preservation before teardown.

The Omnyo repository's setup script records the ignored directories it creates
during a successful fresh pnpm install. Teardown can remove those directories
while their recorded contents are unchanged. An additional or changed artifact
holds the worktree for review.

## Run teardown with `.omnyo-env-teardown.sh`

Commit a file named `.omnyo-env-teardown.sh` at the project root when setup
creates resources outside the worktree. For example, the script can remove a
database, a proxy registration, a container, or a port reservation.

```bash
#!/usr/bin/env bash
set -euo pipefail

docker rm -f "my-project-${USER}"
```

Contract:

- Omnyo runs the script before calling a provider to remove a path it owns,
  including cleanup after failed setup. Attached paths do not run it.
- Omnyo runs `env bash .omnyo-env-teardown.sh` from the worktree before it removes
  the worktree, so the script can read tracked and generated files.
- stdin is closed. Omnyo records stdout and stderr in the server lifecycle logs.
- The script gets a separate 15-minute timeout.
- A non-zero exit, a signal, or a timeout reports a failure. It never stops Omnyo
  from removing the worktree.
- The script receives the same sanitized environment as the setup script.
- A bash script on every platform. On native Windows Omnyo runs it with the bash
  that Git for Windows installs and fails with a message naming Git for Windows
  when there is none.

Hook operation IDs and their started/finished state are saved per launch attempt.
After a server restart, Omnyo reconciles the original daemon operation instead of
starting setup again. If an RPC disconnects, cleanup cancels the operation and
waits for its process group to terminate before releasing the path. An
unreachable daemon leaves cleanup pending for retry. Durable daemon cancellation
records resolve never-started operations and prevent delayed execution.

## If something isn't working

A few quick checks:

1. If worktree creation fails, look at the thread's provisioning transcript
   in the app. Failures from `git worktree add` (dirty source checkout,
   invalid base branch, conflicting branch name) show up there with the exact
   git error.
2. If `.omnyo-env-setup.sh` doesn't seem to run, make sure it's committed to
   the branch you're working from. A file that exists only in the working
   copy of your main checkout won't appear in the new worktree.
3. If your setup script hangs, remember stdin is closed. Anything that
   prompts for input will time out at 15 minutes.
4. Run `bash .omnyo-env-setup.sh` manually in a clean clone to verify it works
   outside Omnyo before debugging through the provisioning transcript.
5. Run `bash .omnyo-env-teardown.sh` manually before you delete a test worktree.
   Confirm that repeated runs do not fail or remove shared resources.

## Fresh project clones on machines

Core applies the same setup and teardown policy when a project checkout is freshly
cloned onto a new machine and the environment provider reports that it owns the
checkout. `.omnyo-env-setup.sh` must succeed before the environment is ready.
`.omnyo-env-teardown.sh` runs before removal with its own 15-minute timeout; a failure
is reported but does not prevent removal. A user-maintained checkout attached to
Omnyo remains unowned and runs neither hook.

Fresh machine clones do not apply `.worktreeinclude`: no local source checkout
exists on the new host. Supply local files and secrets through core Machine
environment settings. Keep the repo hook's cache/no-op logic in the repository;
Modal's stored Dockerfile recipe contains image-build instructions only.

Restoring a machine filesystem does not rerun `.omnyo-env-setup.sh`. Setup runs when core first creates an owned environment. Fresh machine clones do not apply `.worktreeinclude`; supply local files and secrets through Machine environment settings.

Thread startup does not validate workspace fingerprints, probe agent authentication, or automatically install agent CLIs.
