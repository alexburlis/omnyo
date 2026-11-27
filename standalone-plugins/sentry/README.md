# Omnyo Sentry

Investigate Sentry errors in local Omnyo chats and deliver verified, independently reviewed fixes
as pull requests. You choose the model for single issues, for project-wide Solve all and for the
review; the defaults are GPT-6.1 Sol Max, Ultra and Max.

The plugin watches explicitly selected Sentry routes every five minutes. The issue inbox and icon badge
show open error and fatal issues. Solvers start manually by default, with one visible Omnyo
investigation at a time in the route's exact project and repository. Each investigation receives a
linked Git worktree, existing repository instructions and a structured completion tool. The tool
checks the committed change and runs the configured verifier before any enabled publication.

Routes start paused and use local delivery. The first scan imports an existing backlog without
launching it. Watching issues never enables solving. Start a solver from an issue or opt into auto solve
for its Omnyo project. The configurable limit defaults to 10 automatic starts per UTC day; manual starts
remain available at the cap. Enabling auto solve does not start the existing backlog.

The panel uses the shared SDK resource cache within the current account and coordinator session.
The first screen waits for issue status and project names together; warm visits retain their last
complete screen while fresh data loads. Previously viewed filters retain their rows and totals during
refresh. The rail also warms the inbox shortly after Omnyo starts. This integration requires SDK
0.6.57 or newer. Controls respond immediately, with pending state only on the action you
started. Settings update optimistically and restore their previous value if saving fails. Sync is
acknowledged before the scan; queued solver startup continues in the background. Cached counts are
labelled while refreshing, and scan/startup errors remain visible.

## Inbox and project controls

Choose a project from the inbox navigation, then filter its repositories. Search, severity and sort
controls help narrow the visible issues. Expand an issue for its release, first/last seen and exact
repository mapping, or open it in Sentry. Clear filters to return to the full inbox.

Investigations and project reports follow the same project selection. Projects keeps repository
watching separate from solver automation; repository details and advanced settings expand when needed.
Setup and editing use nonmodal panels, preserving the surrounding app and keyboard focus.
If a route's Omnyo project is deleted, its card says so. Doctor, solver starts and Solve all refuse
that route until you pause it and choose Edit to move it to an existing project.

A shared Sentry project can map to several repositories with disjoint service, environment or release
scopes. Exact release scopes must be updated after future releases.

## Setup

1. Install the verified runtime on the existing Omnyo coordinator.
2. In Sentry plugin settings, choose the data region and paste an existing auth token with
   org:read, project:read and event:read. The Status line confirms the connection. No new account is required.
3. Click Add project. Choose a discovered Sentry project, Omnyo project and local repository. Confirm
   its environment and verification command, then Save and watch. Setup discovers Git children of
   umbrella workspaces. Fixes remain local and manual.
4. Inspect the inbox and icon count. Start one issue with Sol Max, or choose Solve all for the Omnyo
   project with Sol Ultra. Solve all inventories every watched repository and all Sentry pages,
   groups related causes through subagents, and queues isolated repository packages. Each package
   reports every assigned issue.
5. Later, enable Auto solve per Omnyo project and choose the daily automatic-start limit. Doctor checks the exact target before opt-in.
6. Choose PR delivery only when dedicated fix-branch pushes and draft PRs in that exact existing
   GitHub repository are authorized. Deployment and releases stay separate.
7. Pick the Solve, Solve all and Review models in the bar at the top of the panel, in Settings, or
   with `omnyo sentry models set`. They are saved as defaults; new solvers use the current choice.
8. Triage issues after solving is on by default. Each solver sets its issues' final Sentry state
   through its own Sentry tools: resolved in the next release after a merged fix, resolved when
   already fixed, archived until escalating when proven not actionable. An expected condition
   reported as an error gets a logging correction in the app instead. Unproven issues stay open.
   For a verified diagnostics-only change, Solve and Solve all can temporarily archive an eligible
   issue until its exact build deploys. The plugin resumes notifications when Sentry proves the
   release, source commit, single target project and deployment environment. Commit-addressed
   release IDs use runtime telemetry from the exact Sentry project and environment. The original issue
   stays unresolved. This requires `event:write` and a configured route check that runs the
   committed logging regression.
9. Optionally turn on Merge reviewed pull requests. On PR routes the solver then marks its draft PR
   ready and merges it after the independent reviewer approved the commit and required CI checks
   passed. It is off by default; without it the draft PR waits for you.

Every solver checks for a matching Omnyo goal before investigation. The goal covers verified
per-issue outcomes and authorized delivery and triage. The solver investigates the cause,
reproduces and repairs it where possible, obtains independent review for code changes, submits
the evidence and verifies the authorized follow-through.

For a mapping whose project spans several child repositories, select its exact child repository. Solve all gives its coordinator a separate plugin-owned workspace and creates fixes in the mapped children. The canonical project path and repository mappings remain available for inspection; the coordinator does not claim the Project checkout environment. Empty coordinator workspaces retire automatically; unexpected files are preserved.
The repo-aware environment provider does not reset the canonical checkout or its dirty files.

## Commands

Use `omnyo sentry --help` or the bundled sentry skill for commands. The main surfaces are:

- `omnyo sentry status --json`
- `omnyo sentry doctor [--route ID] --json`
- `omnyo sentry routes list|set|enable|pause`
- `omnyo sentry sync --dry-run --json`
- `omnyo sentry investigate ISSUE_URL --route ID --mode local --json`
- `omnyo sentry runs list|show|stop|retry`

The typed API also exposes projects.catalog, projects.repositories, projects.add, projects.solveAll and batches.stop/resume. Project coordinators receive actual-thread-bound context, package and completion tools. Native completion resumes the same coordinator for its TLDR; uncertain starts/summaries remain visible and never create replacement workers.

The plugin API exposes the same typed operations. A route file belongs to its explicitly selected
machine; the CLI does not read it from the coordinator's filesystem.

## Boundaries

The Sentry client performs read-only organization issue queries with explicit project/environment
filters, bounded full-scan pagination and rate-limit backoff. Completed scans retire resolved/no-longer-matching
issues from the local inbox. Partial or failed scans retain the last known count and show freshness.
The badge counts distinct issues across watched routes. The inbox filters and sorts issues before
splitting them into pages of 200. It stores only selected technical metadata, not event payloads,
user identities or credentials. Workers use Sentry tools already available in their chat for
read-only diagnostics when present.

Repeated events do not launch another worker. A changed provider regression state or an explicit
retry can create a new attempt. Polling cannot promise to observe transitions that occur and
disappear between successful checks. Failed or uncertain worker/publication outcomes stay visible;
they do not select another provider, host or model. A stopped solver chat pauses and keeps its place
in the queue; Stop run cancels it, and Stop is unavailable while its machine is offline or the
server is frozen for a move.

Deleting a solver, coordinator or State Machine step chat ends that work instead of holding the
execution slot. A run whose chat was deleted fails and frees the slot for the next queued issue; a
project investigation whose coordinator chat was deleted fails; a step whose chat was deleted
fails without an automatic retry, so its workflow blocks and its run needs evidence. Stop also
succeeds for a chat that no longer exists. Branches, worktrees and evidence stay in place. A chat
that cannot be read for any other reason keeps its slot and shows why.

Omnyo owns environment lifecycle. Cleanup refuses unknown or unpreserved contents, preserves branches,
and never force-removes a worktree. A paused route revokes further plugin publication; remote
writes already accepted before cancellation remain discoverable for recovery.

Normal completion uses visible-chat Omnyo notifications and existing preferences. Pre-worker notices
use the existing durable web/desktop notification API. A queued notice is not proof of receipt.

## Development and verification

Requires the matching installed private Omnyo CLI, Node 22+ and pnpm. All source remains in this
canonical repository.

Solve issue and Solve all receive the bundled `solve-sentry-issues` policy and the
`sentry` execution adapter. The package includes both skills and their metadata;
it does not need a global skill installation. The shared policy defines development
targets, diagnostics and version-aware dispositions. The adapter preserves exact
route permissions, isolated workers, independent review and completion tools.

To refresh the bundled policy from its shared source, run
`pnpm sync:solver-skill /path/to/solve-sentry-issues`, then repeat with `--check`.
Commit the updated skill and `source.json` together. The importer only replaces
machine-local reference links and the product-specific example with portable text;
`source.json` records the upstream and bundled hashes. Normal builds use the committed
copy, so another machine needs no access to the upstream directory.

Run `pnpm install`, `omnyo plugin types --check`, `pnpm test`, `pnpm run test:host`,
`pnpm run test:ui`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`,
and `omnyo plugin build`. Only better-sqlite3 and esbuild build scripts are allowed.
`omnyo plugin types` keeps the SDK pin in this plugin's `vendor/` folder.

The Mac coordinator runs a durable package, so edits and builds in this checkout do not change
the running plugin. After a verified build, run `pnpm run package:runtime`, then
`pnpm run install:runtime -- --machine MACHINE_ID --preserve-state` from an independent
context. The installer transfers the hashed package into `plugins/local-builds/sentry/<build>`,
verifies each file, and installs it in place of the previous package or checkout install. It
refuses another owner's Sentry installation or unsettled Sentry work, and checks that watched
routes and auto-solve policies are unchanged afterwards. Confirm the change with
`omnyo sentry doctor --json`.

An explicitly approved stalled-queue update can add `--recover-stalled-run RUN_ID` with
`--preserve-state`. This requires the exact verified local-ready owner to be idle with no
queued/background work, admits only unspawned queued successors and waiting batches, and rejects
active or uncertain execution.

An approved update can likewise add `--recover-stranded-run RUN_ID` with `--preserve-state` when
a State Machine run is blocked, all its steps are settled and its chat was deleted, so it still
holds the execution slot. The installer admits only unspawned queued successors and waiting
batches beside it. After installation, reconciliation moves the run to needs-evidence and frees
the slot; its branch, worktree and step evidence stay in place.

The State Machine retries repair workspace setup once when the worker has a recorded setup
failure, never accepted input or started a turn, and the original worktree is still available.
After upgrading the graph with `omnyo sentry workflow configure`, use
`omnyo sentry workflow recover-setup --run RUN_ID` to recover a matching blocked run from an
older graph version. The command keeps the original diagnosis and workspace, retires the old
instance, and starts the new version without rerunning the investigation.

The merge step merges the reviewed pull request once its required GitHub checks pass; a failed
check stops it and a pending one waits.

A merged runtime fix waits for the next requested release. The run checks for an offer
containing the fix without starting a release or asking the owner to confirm the wait.
Once offered, the run verifies the installed release before resolving or deferring the issue.
When GitHub reports no checks at all, it waits three
minutes after the pull request opened for checks to appear, then merges on the run's own
verification and approved review.

A step that is refused before its worker chat starts, for example because another run holds
the single execution slot or its configured model is unavailable, ends as a stopped step that
names the reason. Nothing ran, so it frees the shared environment for other runs and can be
retried once the cause clears. Only a failure after a worker may have started is recorded as an
unknown outcome that needs reconciliation.

## Controlled acceptance run

For a controlled acceptance run:

1. Run `pnpm run package:runtime` and `pnpm run package:runtime -- --acceptance`. The second snapshot is explicitly labelled and replaces only the external Sentry transport with synthetic issue data.
2. Install the acceptance pointer with `pnpm run install:runtime -- --machine MACHINE_ID --disabled --snapshot-file dist/runtime-acceptance.json`. It refuses an existing real connection or product routes.
3. Run `pnpm run test:journey -- --mode local --phase start --project PROJECT_ID --machine MACHINE_ID`. It creates a failing toy repo beneath a temporary umbrella and starts the real plugin-owned local model chat.
4. Bind that running chat to the existing Needs You completion callback. Inspect its result before `pnpm run test:journey -- --mode local --phase complete`. No second worker or polling loop is needed.
5. Completion verifies project/host/repository/model/Max/default-tier, the original failing test, independently rerun fixed test and dirty sentinels. It retains a Git bundle, patch and small receipts, stops and archives the fixture chat, cleans its environment through Omnyo, removes its exact temporary source and clears only fixture-owned rows/settings.
6. Install the production pointer with the normal install command. It contains no fixture RPCs, synthetic credential or transport. Leave real product routes paused until their exact scope is authorized.

`pnpm run test:browser` exercises the actual React component in local headless Chrome at desktop and narrow widths. Its receipt states the native runtime limits.

`pnpm run test:runtime-package` rebuilds an owned compiled-runtime clone through the real Omnyo CLI,
proving a path install retains the inbox and global badge styles. The runtime entry imports its
extracted CSS explicitly; no core change or runtime style injection is needed.
