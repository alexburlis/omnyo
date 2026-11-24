# Storage & retention

A bundled, default-enabled plugin. If disabled, enable `omnyo--storage-retention`. Open Storage & retention in the sidebar.
Both retention policies default to Never. Pinned and shelved chats are excluded
from automatic archiving and deletion. Run the saved policy immediately with
`omnyo storage retention --run --yes`. The plugin owns policy, previews,
hourly scheduling, run summaries, UI, and CLI commands. It uses public SDK thread
rows to reconstruct archive/delete relationships and ordinary lifecycle actions.
The plugin also owns disk measurement in its host worker, scan caching in its own
SQLite database, report assembly, orphan classification, and file deletion.
Core supplies ordinary thread lifecycle actions, machine storage paths, and
environment cleanup retry. The existing core idle orphan sweep is unchanged.
Disabling the plugin stops retention; it does not stop core orphan maintenance.

Managed scratch records the volume UUID and directory inode on macOS, so a device
number change after remount does not change its identity. Existing records without
a volume UUID retain their strict device/inode check. If those records are held
after a remount, run `omnyo storage managed namespace-preview --machine HOST_ID`,
then `omnyo storage managed namespace-reanchor --machine HOST_ID --preview-digest DIGEST --yes`.
The explicit repair requires unchanged directory inodes, the original marker,
idle owners and consumers, and a complete unchanged tree. It preserves payloads
and revokes previous cleanup permission and snapshots. In-flight or quarantined
allocations cannot be reanchored. A changed preview must be inspected again.

## Housekeeping

The Housekeeping section shows durable maintenance runs and their per-stage
results. Preview inspects eligible work. Run housekeeping starts the same
background runner used by scheduled maintenance. An uncertain destructive stage
keeps its original receipt and any actual reservation. Later runs skip that stage
and can continue independent work. Read-only failures remain visible without
reserving cleanup bytes. Missing measurement stays unknown rather than becoming zero.

Core host and provider workers record ownership for newly created private
temporary directories. Actual worker exit owns normal closeout. Provider input
closing only begins draining and does not release temporary files. Maintenance
recovers only marked allocations with a proven stopped generation and complete
native activity checks. Existing unmarked temporary directories are not adopted.
Windows crash recovery remains held. A process-private recovery stage that fails
or stops before its receipt is held without replay: its allocation journals keep
any interrupted removal held, the run ends held, and local policy stages still
run in the same run and later runs. This process-private class is separate
from thread-owned ManagedScratch and does not change its seven-day floor or
review and expiry settings.

Use `omnyo storage housekeeping status`, `preview --machine HOST_ID`, or
`run --machine HOST_ID --yes`. Runs report current ownership, reservations,
completed stages and holds. `--max-items` and `--max-bytes` bound tracked
temporary/plugin entries and cold-file cleanup. Registered native utilities
retain their approved policy limits. `--budget-seconds` sets a soft admission
window up to 900 seconds; a request returns while the host owns its child.

An optional local Mac policy can reuse the existing safe-mac-cleanup helpers.
It is not configured on a fresh installation. First run
`adapter-preview --machine HOST_ID --source-directory DIRECTORY --python PYTHON --policy POLICY`.
Inspect its exact source/runtime/policy bindings, then use
`adapter-adopt --machine HOST_ID --revision REVISION --preview-digest DIGEST --yes`.
Adoption preserves the policy's existing roots, disabled classes, ledgers and
transactions. Changed source or policy hashes hold apply until explicit renewed
adoption. Removing a registration uses `adapter-remove` with the same exact
preview confirmation and does not delete its source or native recovery state.
Native agent tools cannot register policies or change housekeeping settings.

All controls use the typed `housekeepingRpc` contract. The owning CLI, panel and
schedule call the same service. Bounded plugin-cache cleanup requires a matching
core capability in its dry-run response; older coordinators show a held stage
until their offered runtime update is installed.

The machine page offers Clear archived files for whole storage folders, including
small files, from archived, stopped, unpinned threads in the scan. Bulk clearing
keeps conversations and uploaded attachments and requires confirmation. The
matching CLI command is `omnyo storage clear-archived-files --machine HOST_ID --yes`.

The Clean up section offers Remove instances for `~/.omnyo-dev` entries whose
source checkout no longer exists. The host re-verifies each checkout is missing,
stops processes whose working directory is inside it, then removes the entry. The
matching CLI command is `omnyo storage remove-dev-instances --machine HOST_ID --yes`.
Every development row's trash button removes that single entry immediately
(`--instance NAME`), like the thread rows' trash button clears a thread's files.
If the instance's dev server is running (fresh daemon lock), the row asks
"Stop and remove?" first; confirming stops that instance's launcher and
removes it. The CLI's `--yes` covers that confirmation.

## Worktrees & Branches

Use the Worktrees & Branches section of the Storage & retention dashboard to
inspect local branches, working folders, and diffs on the coordinator machine.
Project sidebar Git summaries use the same saved inventory. The scan runs every
three hours.
Use `omnyo storage worktrees status` to read it and
`omnyo storage worktrees rescan` to refresh it.

Storage machine reports use the same Git scanner for external working folders.
Folder removal requires a reviewed tip and a retained local branch. It
rechecks Omnyo ownership, open chats, Git operations, dirty and ignored
files, hidden index flags, and recovery history before removal. It keeps the
folder's branch. Existing machine reports without reviewed Git identity need
a fresh scan. Run
`omnyo storage remove-external-worktrees --machine HOST_ID [--path PATH] --yes`
for folder-only cleanup.

The Worktrees & Branches safe cleanup list can include local branch names.
Branch deletion requires confirmation and proof that a retained branch
preserves the commits. The batch checks each reviewed item again and removes
folders before branches. The matching command is
`omnyo storage worktrees clean SCAN_ID --yes`.

Large-file cleanup from the page starts a background job so slow folder walks
can finish after the remote HTTP request returns. Each machine reports queued, running,
completed, or failed status, including after navigation or reconnection. The
`startClearLargeFiles({hostId})` RPC starts the job; pass null for all scanned
online machines. `omnyo storage usage` exposes `largeFileCleanup` status. The
`clearLargeFiles` RPC and `omnyo storage clear-large-files` continue to wait for
completion and return deleted file/byte totals.

Cached reports are snapshots; rescan to see external filesystem changes. Cleanup requests run in FIFO order, one at a time per machine; different machines
run independently. Duplicate background requests share the pending job. Scans run
alongside cleanup; a finished scan leaves out entries cleared while it ran.
Each job rechecks safety when it starts. Targets already removed by an earlier
job are treated as handled, and force/stop permission never comes from queueing.
The queue lives in the server process and is canceled on shutdown or plugin reload.
The UI submits a clear immediately, shows a spinner on the affected control
while its job is queued or running, reports results and errors in toasts
(successes within five seconds combine into one), and keeps every other action available. Settings save immediately without
success toasts; failed saves restore the previous value. Concurrent core cleanup tolerates
missing entries. Disk measurement and deletion remain in the plugin host worker. Core emits an environment-removal notification; storage scans and cleanup stay
in the plugin.

The first version pages all nondeleted threads before acting. It intentionally
accepts changes between reading eligibility and applying an action. CLI previews count current candidates, not guaranteed future outcomes.

Two additional cleanup policies default to off. `deleteStorageOnArchive`
queues future archives and clears them at most once every 24 hours; an hourly
check catches up after downtime. Each run clears only threads archived at least 3
hours before it; younger archives and failed clears wait for the next daily run. Unarchiving cancels cleanup; pinned
threads are skipped. `deleteDevDataOnCheckoutRemoval` scans and removes development
folders whose checkout is missing, including existing folders, while keeping
existing and unidentified sources. Both are available through `omnyo storage retention`.

Development cleanup reconciles filesystem state on plugin startup, machine
reconnect (rescanning only the machine that reconnected), and hourly. `experimental_environment.removed` re-measures only the
removing machine's `~/.omnyo-dev`, queued behind any cleanup already
running there; missed events need no replay or removal-history tables.
Offline/busy machines and failed cleanup retry on subsequent scans. Provider
removal success does not prove the path was deleted; the host always checks
actual filesystem state.

Orphan, development, worktree, external-worktree, and archived-file bulk cleanup can also run as
background jobs. `startCleanup` and `startClearArchivedFiles` start them; `host`
and `hosts` report progress, with `maintenanceJobs` retaining a separate status per
maintenance kind. `maintenance` remains the latest maintenance status. Individual
thread/development cleanup uses `startEntryCleanup` and polls `entryCleanup` for
queued/running/result status so waiting never holds a remote HTTP request open. The CLI offers `omnyo storage cleanup` for maintenance
jobs and keeps synchronous cleanup commands for callers that need final totals.

## TODO

Define cross-plugin thread protection. Automation targets receive no special
exemption yet; pin threads that must be kept. No retention-hold API or Automations
integration ships with this plugin.

Consider general timestamp and lifecycle-owner filters if full enumeration
becomes expensive. No retention-specific query or mutation API is required.

Automatic archive storage cleanup persists retry deadlines across reloads. Failed
attempts back off from one minute to one hour, independently per thread. Detached
threads without a unique location in the saved machine scans remain queued and
recheck the inventory hourly without warning on every thread event. Scan the
relevant machine to make its storage discoverable; manual clearing still reports
an unresolved location rather than guessing a machine.
