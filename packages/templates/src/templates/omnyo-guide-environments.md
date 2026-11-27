---
kind: instruction
title: Omnyo Guide — Environments
summary: Command reference for environment setup, inspection, commits, and merges.
intent: Provide complete environment command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Environment commands

Environments determine where threads run. Multiple threads can share an environment
(e.g., a coding thread and a review thread in the same worktree).
The first-party choices are Project checkout (the project's existing directory),
Worktree (a fresh Git worktree), and Personal workspace (a projectless workspace).

On supported APFS volumes, the Worktree plugin shares storage for identical tracked files when creating a managed worktree. Each copy remains independently editable. The default-on switch is under Settings → Installed plugins → Worktree. Storage → Worktrees offers Reclaim space for selected idle worktrees on a machine.

New Worktree branches start at the selected base without an upstream, regardless
of Git's branch.autoSetupMerge setting. Publish with `git push -u origin HEAD`
to track the task's remote branch. Existing branches keep their upstream.

Making your repo work with Omnyo:

  If the default environment plugin is disabled or missing, creation fails
  before inserting a thread. Enable the plugin or explicitly choose another
  environment; Omnyo does not silently replace an isolated worktree with a checkout.
  Host-dependent preflight checks require the selected machine to be connected.
  Directory switching creates a core-owned attachment with no provider identity.

  Commit a .omnyo-env-setup.sh script at the repo root when new Omnyo worktrees need
  repo-specific setup. After Omnyo creates a new managed worktree environment, it
  looks for .omnyo-env-setup.sh inside that new workspace. If the file is absent,
  provisioning continues with no error.

  The script must be tracked by git. A fresh worktree only checks out tracked
  files, so an untracked .omnyo-env-setup.sh in your source checkout will not be
  present and will not run.

  Omnyo runs the hook as `env bash .omnyo-env-setup.sh` with cwd set to the new
  workspace. On Windows it runs the script with the bash that Git for Windows
  installs, so the same script works there; without Git for Windows the hook
  fails with a message naming it. The hook
  inherits the host daemon's sanitized environment: NODE_ENV and every OMNYO_* variable
  are removed, and Omnyo does not inject OMNYO_PROJECT_ID, OMNYO_ENVIRONMENT_ID,
  or OMNYO_SOURCE_PATH.

  Core admits and claims the path before hooks, and runs hooks only
  after create confirms ownsPath: true. Attached project
  checkouts and personal workspaces never run hooks. Hook IDs derive from the launch attempt. A server restart can join the same
  operation while the daemon remains alive. Hook state is held only in daemon
  memory; a daemon restart leaves an interrupted hook outcome unknown.

  A non-zero exit, timeout, signal, or cancellation fails provisioning and Omnyo
  removes the new worktree after confirming the script has stopped. An unknown
  hook outcome stops automatic cleanup. Inspect the workspace, confirm no hook
  process is still running, then run
  `omnyo environment cleanup <id> --hook-stopped`; Omnyo records the confirmation and
  finishes removal without rerunning the interrupted hook.
  Keep optional setup steps non-fatal inside the
  script if the environment should still open. Provisioning progress reports
  "Running .omnyo-env-setup.sh" and then ".omnyo-env-setup.sh finished",
  ".omnyo-env-setup.sh failed", or ".omnyo-env-setup.sh cancelled".

  Commit a .omnyo-env-teardown.sh script at the repo root when setup creates
  resources outside the managed worktree. Omnyo runs the hook as
  `env bash .omnyo-env-teardown.sh` from the worktree before it removes the
  worktree. The hook receives the same sanitized environment as the setup
  hook, and stdin is closed.

  Teardown has a separate 15-minute timeout. A non-zero exit, timeout, or
  signal reports failure in the destroy transcript, but Omnyo removes the
  worktree after script termination. If transport fails, Omnyo cancels the hook
  and confirms its process group has stopped before releasing the workspace.
  An unreachable daemon leaves cleanup pending for retry, unless its machine is
  being removed and stays offline: then Omnyo skips that cleanup. If the daemon no
  longer knows the hook, automatic cleanup stops with an explicit unknown-outcome
  error that names the recovery command. There is no cross-restart script
  recovery or persisted process tracking, so only the owner's
  `omnyo environment cleanup <id> --hook-stopped` releases that workspace.
  Teardown only runs for paths whose ownership was confirmed by create.

  New worktrees do not contain untracked files such as .env.local. To copy
  them from the source checkout, commit a .worktreeinclude file at the repo
  root. It uses gitignore syntax: one pattern per line, # for comments, ! to
  negate an earlier pattern. Omnyo copies each untracked file in the source
  checkout that matches a pattern:

    .env
    .env.*
    !.env.example
    certs/

  Omnyo copies files only. It follows no symlinks, and it replaces nothing that
  the worktree already has. The copy runs after `git worktree add` and before
  .omnyo-env-setup.sh, so the setup script can read the copied files. A pattern
  that matches nothing, or a file Omnyo cannot read, is reported in the
  provisioning transcript and does not fail provisioning.

  Large directories such as node_modules are copied file by file. Install
  dependencies in .omnyo-env-setup.sh instead of listing them here.

  For files that customize agent instructions and skills (AGENTS.md,
  .omnyo/AGENTS.md, .omnyo/skills/), run `omnyo guide agent-configuration`.

  omnyo environment providers                List registered environment providers in picker order:
                                          Project checkout, Worktree, then other installed providers
                                          by display name; includes id, name, the `requires` facts (host,
                                          projectCheckout, gitCheckout, gitRemote, projectless), and whether
                                          it takes --environment-inputs (--json prints the JSON Schema)
    --project <id>                        Filter by structural eligibility for this project
    --machine <id-or-name>               Scope structural eligibility to this machine
    --host <id-or-name>                  Alias for --machine
  omnyo environment list                     List environments that are not destroyed
    --project <id>                        Only environments in this project
    --provider <id>                       Only environments this environment provider produced
    --host <id-or-name>                   Only environments on this machine
    --instance-key <key>                  Only the environment its provider named with
                                          this instance key (with --provider, the one
                                          row that provider's launch produced)
    --status <status>                     Only environments in this status: provisioning,
                                          ready, error, destroyed (the only way to see
                                          destroyed rows)
    --limit <n> / --offset <n>            Page through the rows, oldest first
  omnyo environment delete <id>              Request provider cleanup; refused while threads are
                                          live or stopping. The command returns with cleanup
                                          requested; lifecycle becomes destroyed only after
                                          provider removal completes. Unarchiving one of its
                                          threads before removal starts cancels the request
  omnyo environment show <id>                Show environment details (path, branch, status, lifecycle, retirement deadline and teardown attempts)

  omnyo environment status <id>              Show workspace status. Each file list holds at most
                                          200 entries (tracked changes first); fileCount is
                                          the total number of changed files
    --merge-base-branch <branch>          Include merge-base status
      If squash-merge detection hits its limits (1,000 commits, 1 second),
      mergeBase.squashMergeCheckComplete is false and counts may include
      already squash-merged commits.

  omnyo environment branches <id>            List local and remote branches
    --query <query>                       Filter branch names
    --limit <count>                       Limit local and remote results

  omnyo environment paths <id>               Search workspace paths
    --query <query>                       Fuzzy path query
    --limit <count>                       Maximum results
    --files                               Include only files unless combined with --directories
    --directories                         Include only directories unless combined with --files

  omnyo environment diff <id>                Show file summary and full git diff
  omnyo environment diff-files <id>          List changed-file metadata
    --target <target>                     uncommitted, branch_committed, all, or commit (required)
    --merge-base-branch <branch>          Required for branch_committed and all
    --sha <sha>                           Required for commit

  omnyo environment diff-file <id>           Read one side of a changed file
    --target <target>                     Diff target (required)
    --path <path>                         Repository-relative path (required)
    --side <old|new>                      File side (required)
    --merge-base-ref <sha>                Required for branch_committed and all
    --sha <sha>                           Required for commit

  omnyo environment diff-patch <id>          Fetch selected file patches
    --target <target>                     Diff target (required)
    --path <path>                         Changed path; repeat for multiple files (required)
    --merge-base-branch <branch>          Required for branch_committed and all
    --sha <sha>                           Required for commit

  A short merge-base branch name such as main resolves to origin/main when the
  local branch only trails it, and to the local branch otherwise. Pass
  refs/heads/<branch> to always compare against the local branch.

  omnyo environment update <id>              Update environment metadata
    --merge-base-branch <branch>          Set merge-base branch override
    --clear-merge-base-branch             Clear merge-base override
    --name <name>                         Set display name
    --clear-name                          Clear display name

  omnyo environment commit <id>              Create a commit in the environment

  omnyo environment archive-threads <id>     Archive all threads in an environment

  When the last thread of a worktree environment is archived, the worktree
  plugin waits five minutes and then tears it down: it runs
  .omnyo-env-teardown.sh, stops every process whose working directory is inside
  the worktree (the agent process, background jobs it left behind, and also
  shells, editors, or servers you started there yourself; SIGTERM, then
  SIGKILL after a short grace period), removes the worktree, and records the
  environment as destroyed. The branch is kept. Deleting the last thread starts
  teardown without the retirement grace; cleanup still completes asynchronously. Unarchiving a thread inside the grace window cancels the
  teardown. Move your own shells out of the worktree first if you want to
  keep them.

  omnyo environment pull-request show <id>   Inspect a pull request
  omnyo environment pull-request ready <id>  Mark a pull request ready
  omnyo environment pull-request draft <id>  Convert a pull request to draft
  omnyo environment pull-request merge <id>  Merge a pull request
    --method <method>                     merge, squash, or rebase

Every inspection command accepts an arbitrary environment ID and supports
`--json`. Non-git status/diff responses are reported explicitly. `diff-file`
prints UTF-8 content directly and labels base64 binary content; diff and patch
truncation markers are preserved.

Omnyo account (omnyo.link sign-in):

  The builtin "Omnyo Account" plugin signs this omnyo server in to your
  omnyo.link account and holds its server credential. Remote access uses it
  and never sees the credential.

  omnyo account status                       Show the signed-in account
  omnyo account login                        Print an omnyo.link link and code to approve
    --wait                                Wait for that sign-in to finish
    --code <code>                         Pair with a one-time dashboard code
    --base-url <url>                      https://omnyo.link or https://stg.omnyo.link
  omnyo account logout                       Revoke the credential and sign out

  `omnyo account login` returns after printing the link; approve it in any
  browser and Omnyo finishes signing in on its own. Every command accepts
  `--json`. `omnyo account status` reports a paired Omnyo whose account hasn't
  loaded yet as pending; it keeps retrying. `omnyo account logout` says so when
  omnyo.link didn't confirm revoking the server. In a source checkout,
  `pnpm dev --staging` points sign-in at the staging relay through
  `OMNYO_DEV_CONNECT_BASE_URL` (plain `pnpm dev` points it at the worktree's
  `omnyo.localhost` origin, which needs a locally run relay); an explicit
  `--base-url` still wins, and a
  development build also accepts `http://omnyo.localhost:<port>` there.

  Operator relay migration preserves an existing pairing. Against the coordinator
  loopback, run `omnyo account rebind-relay --from-base-url OLD_APEX
  --from-server-url OLD_TENANT --user-id USER_ID --server-id SERVER_ID
  --server-label LABEL --check --json` using its checkpoint. Only the previous
  production/staging slashnew.com hosts map to omnyo.link. After validation, repeat
  without `--check`; retry the same checkpoint after a partial write. Verify account
  status and a connected tunnel at the new URL. This does not create a server, rotate
  its credential or move any chat data.

Remote access (Omnyo connect):

  Expose this omnyo server at <handle>.omnyo.link so you can reach it from any
  browser. Remote access starts once this Omnyo is signed in to its Omnyo account
  (`omnyo account login`). A pairing command from the omnyo.link dashboard
  still works like `omnyo account login --code`, and also turns remote access
  back on:

  omnyo connect --code <code> [--server https://<handle>.omnyo.link]
    --code <code>          One-time pairing code from the dashboard
    --server <url>         Dashboard server URL; only its omnyo.link or
                           stg.omnyo.link apex is used

  The Omnyo SERVER holds the tunnel itself — so it stays up as long as Omnyo is
  running and reconnects on restart (no foreground process). It connects with
  the server credential Omnyo account holds.

  omnyo connect status                       Show the server's connect status
  omnyo connect off                          Turn remote access off, stay signed in
  omnyo connect on                           Turn remote access back on
  omnyo connect expose <port> [--host <name-or-id>]    Share a host's HTTP port
  omnyo connect unexpose <port> [--host <name-or-id>]  Stop sharing on that host
  omnyo connect unexpose-all [--host <id>] [--json]   Stop sharing all ports on one machine
  omnyo connect shares [--host <name-or-id>]           List that host's shares
  omnyo connect servers                      List every Omnyo on this account (handle, url, live)
  omnyo connect devices --json               List devices paired with this server
  omnyo connect machine-code                 Mint a one-time code that pairs the Omnyo mobile app

  Port sharing works from threads on any enrolled host. In a thread,
  `omnyo connect expose <port>` resolves the thread environment's host; outside a
  thread it defaults to the server host. `--host <name-or-id>` overrides that
  choice for expose, unexpose, and shares. Server-host URLs use
  `https://<server-label>--<port>.omnyo.link`; machine-host URLs use
  `https://<machine-label>--<port>.omnyo.link` and proxy directly through that
  machine's daemon. Access is owner-session-gated — only viewers signed into
  the owner's omnyo.link account can open the URL; it is not a public internet
  link. Agents should run expose from the thread that started the server, share
  the returned URL, and unexpose from the same thread when it stops.
  `omnyo connect status` shows all shares with host + URL. `shares --json` returns
  the resolved `host` and rows with `hostId`, `hostName`, `port`, and `url`.

  The Omnyo mobile app pairs with a paired Omnyo through Omnyo connect.
  Settings → Mobile → Add mobile device shows a QR code plus the code as text.
  `omnyo connect machine-code` prints the same code, server URL, apex, and expiry
  (`--json` for `{code, serverUrl, apex, expiresAt}`). The phone scans or
  types the code and enrolls as a connect machine on the account with its own
  revocable credential (it appears in the omnyo.link dashboard machine list).
  Codes last 10 minutes and work once; an account-machine-limit failure says
  so and points at the dashboard to revoke an unused device.

  Remote access is owned by the builtin "connect" plugin (Plugins → connect
  shows the URL, QR code, mobile pairing, and shared ports). `omnyo connect off`
  sets its `remoteAccess` setting and keeps the account signed in;
  `omnyo account logout` forgets the pairing. Disabling the plugin
  (`omnyo plugin disable connect`) cuts off all remote access; re-enable with
  `omnyo plugin enable connect`.

Core owns environment retirement and teardown. After the last live thread is archived or deleted, the provider policy sets the retirement deadline. `omnyo environment show <id>` reports lifecycle phase and teardown status, attempt and failure message. Failed teardown retries automatically; checkout environments do not retire.

`omnyo environment cleanup <id> [--hook-stopped] [--json]` is an explicit override for removing an
unused provider-managed environment before its policy would do so. Normal
retirement and cleanup retries are automatic; this command is not a routine
end-of-task step. It overrides retention/keep policy and backoff, rejects live
threads and unmanaged environments, and succeeds if already removed. The request
is asynchronous; `omnyo environment show <id>` reports completion. Add
`--hook-stopped` only after inspecting a workspace whose teardown stopped on an
unknown hook outcome and confirming no hook process is still running; Omnyo then
marks that hook abandoned and removes the workspace without rerunning it.

Explicit environment or project deletion bypasses the retirement grace, including the never-retire policy. Provider cleanup retains the host, path and resource until removal completes; inspect progress with `omnyo environment show <id>`.

`omnyo environment providers --json` includes each choice’s `description` and `icon`, as well as its label, inputs, and availability.

`omnyo environment providers --project <id>` omits providers whose declared requirements are unmet on every persistent machine, and reports each provider's `machineAvailability` per machine in `--json`. Add `--machine <id>` to scope structural eligibility to that machine and print its availability: `available`, `setup-required`, `unavailable` with the plugin's reason, or `unknown` while the background probe has not answered. Listing never waits on a machine; probes run in the background, are cached for ten minutes per project and machine, and are checked afresh for the selected provider and machine during thread creation.

Omnyo source checkout startup

  In the Omnyo repository, `pnpm start:worktree` prepares and serves production
  artifacts using stable checkout-specific dev data and ports (no Vite).
  Add `--dryrun` to `pnpm start` or `pnpm start:worktree` to prepare through
  Turbo, print resolved paths/ports, and exit. It does not launch services,
  migrate instance data or require ports to be free. It still writes artifacts
  and may repair native modules. Install dependencies beforehand when needed.
  Both normal and dry-run startup preserve their runtime policy and use the same
  dotenv settings. Preparation writes the
  checkout's build files; warm a separate staging checkout's cache if the live
  instance still serves those paths. Keep the serving checkout path stable to
  preserve its data and ports. See `docs/debugging-and-qa.md` for the restart
  sequence and source programmatic helpers. These are repository maintenance
  commands, not environment lifecycle hooks or installed `omnyo` commands.
