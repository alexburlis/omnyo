---
name: storage-retention
description: Inspect machine storage, manage owner-released temporary scratch, and configure automatic thread archive or deletion.
---

# Storage & retention

The bundled plugin is enabled by default. If disabled, enable it with
`omnyo plugin enable omnyo--storage-retention`. Open its sidebar panel for machine
reports, Managed cleanup, and thread retention. Thread archive and deletion
thresholds default to Never, and their settings save immediately in the panel.
Managed policy changes require a preview and confirmation.
All commands return JSON. Use the owning server's normal SDK/plugin RPC transport.

## Managed scratch

Use the native `ManagedScratch` tool to allocate a new empty payload. The tool
derives the owner, project, and machine from the current chat. Existing paths
cannot be enrolled. Allocation requires a stable `requestKey`, a `purpose`, a
`storage` declaration, and one explicit disposition:

- `disposable-when-owner-ends` grants release after an authoritative owner archive or deletion and settled work.
- `keep-until-released` retains the allocation until the native owner explicitly releases it.

For example, call `ManagedScratch` with:

```json
{
  "request": {
    "action": "allocate",
    "requestKey": "verification-output",
    "purpose": "Temporary compiler output",
    "disposition": "keep-until-released",
    "storage": {
      "role": "verification",
      "budgetBytes": 1073741824,
      "minimumFreeBytes": 1073741824,
      "restoreInputs": []
    }
  }
}
```

Native `list` and `inspect` return the current allocation. Before `keep`, `reuse`,
or `release`, inspect and send the returned `id`, `revision`, and `snapshot.digest`
as `snapshotDigest`, plus a reason. `consumer-register` records another chat that uses the allocation;
`consumer-release` releases the current consumer's hold. Copy retained final
outputs elsewhere before release, or keep the entire allocation. Release records
a decision and removes nothing. Keep, reuse, new consumers, changed snapshots, and
owner unarchive invalidate prior removal approval. Restore and changed data cannot
reuse the same owner-end permission. A fresh native release or a genuinely new
authoritative owner end is required.

The storage role is `build`, `verification`, `render`, `source-snapshot`, or
`temporary`. Each restore input records an immutable `reference` and `sha256`.
An explicit empty list means the producer declares no restore inputs. Admission
measures the destination before the allocation request is written. This budget
is not an operating-system quota. Inspection holds an exceeded budget and never
evicts files. Use native `budget-extend` with the exact allocation fields, a
larger `budgetBytes`, and a reason before more production. The extension checks
space and revokes prior removal approval. Legacy allocations without a storage
declaration stay protected without an inferred budget or grant.

Native `release` also requires `closeout` with an `outcome` of `success`, `failure`,
or `cancelled`, plus `retainedOutputs`. Each keeper names its absolute `path`,
`reason`, and `removalCondition`. Keepers must already be outside the disposable
allocation. An empty list records that no keepers are needed. The panel and CLI
show this closeout for the existing owner review.

The panel and CLI provide administrative review, restore, purge, and policy
changes. They cannot allocate scratch or manufacture a native owner grant.
Confirmations and `--yes` use ordinary account authority, without proof of human
presence. Administrative approval cannot override a missing grant or safety hold.

```sh
omnyo storage managed list
omnyo storage managed inspect --machine HOST_ID --id ALLOCATION_ID
omnyo storage managed review --machine HOST_ID --id ALLOCATION_ID --revision REVISION --snapshot-digest SNAPSHOT_DIGEST --yes
omnyo storage managed restore --machine HOST_ID --id ALLOCATION_ID --revision REVISION --snapshot-digest SNAPSHOT_DIGEST --yes
omnyo storage managed purge --machine HOST_ID --id ALLOCATION_ID --revision REVISION --snapshot-digest SNAPSHOT_DIGEST --yes
omnyo storage managed purge-preview --items JSON_ITEMS
omnyo storage managed purge-batch --items JSON_ITEMS --preview-digest PREVIEW_DIGEST --yes
omnyo storage managed-policy
omnyo storage managed-policy --mode review --automatic-expiry false --budget-bytes 10737418240
omnyo storage managed-policy --mode review --automatic-expiry false --budget-bytes 10737418240 --expected-revision POLICY_REVISION --preview-digest PREVIEW_DIGEST --save --yes
```

Use exact revisions and snapshot digests from inspect. `JSON_ITEMS` is an array of
1 to 100 objects with `hostId`, `id`, `revision`, and `snapshotDigest`. Batch purge
must repeat the exact previewed array and its digest. Policy changes without
`--save` return a preview. Save the same policy with the returned policy revision
and preview digest. Unspecified policy fields preserve their saved values.

Managed policy is separate from thread retention. It defaults to `mode: review`,
`automaticExpiry: false`, and a 10 GiB quarantine budget. `owner-approved` mode
admits existing native grants without a separate administrative review. Both
modes require a settled owner with a current grant, no preservation or recovery
holds, an unchanged snapshot, and complete native process inspection. A declared
consumer keeps its hold while idle. Each consumer must release natively or end
authoritatively before physical cleanup. Pinned and shelved chats remain protected.
After a plugin reload, a grant without a provable current owner-end generation
requires a fresh native release. The plugin keeps these files without waking a
model. Grants bound to the same proven owner end survive reload. A full quarantine
holds new cleanup and never evicts existing files. Windows supports allocation
and owner decisions, with a visible hold for unavailable directory-entry
power-loss durability. Windows physical cleanup remains held because complete
native process inspection is unsupported.

Changed quarantined contents start a fresh seven-day window. Recovery uses the
time it proves the quarantine location when the original move time is uncertain.
Unchanged scans never shorten or restart that window.

Quarantine is a recoverable move with a fixed seven-day minimum before permanent
removal. Restore uses the original path only when that path is absent and never
overwrites files. Explicit per-item or previewed batch purge works after the floor
even with automatic expiry off. Each off-to-on expiry change starts a fresh
seven-day minimum after the later of quarantine and enablement. Neither the CLI
nor the panel can shorten this period. Quarantined and removed sizes are logical
bytes. A quarantine rename does not free SSD space, and removed logical bytes do
not measure physical space reclaimed.

`managedState(null)` lists manifests without a payload scan. A host list exceeding
2,000 tickets, 4 MiB, or two seconds fails visibly instead of returning a partial
list. Exact-ID administrative inspect remains available. `managedRequest` accepts
the same administrative actions through plugin RPC. Inspect performs a bounded
fresh check. The panel refreshes on managed-change events. Reconciliation visits
up to 100 allocations per pass within 20 seconds, using a durable rotating cursor.
Hourly, startup, and reconnect runs never wake a model or reopen an owner chat.

## Durable housekeeping

Use `omnyo storage housekeeping status` to inspect per-host runs and stage
results. `preview --machine HOST_ID` starts inspection; `run --machine HOST_ID --yes`
starts the same durable runner as scheduled maintenance. A caller disconnect
leaves the native child owned by its run. An uncertain operation keeps its UUID
and reservation until its receipt is reconciled. Do not replay it as a new run.
Unknown native counts and sizes remain unknown.

Known process-private temporary outputs have native producer ownership. Provider
stdin EOF starts draining and does not release their files. Child closeout checks
native consumers after the child stops. Self-owned workers check once during
`beforeExit`. Explicit exits and uncertain consumers leave the durable journal
for existing recovery. Recovery requires a marked fresh
allocation, stopped-generation proof and complete activity admission. It never
adopts arbitrary legacy temporary directories. Windows crash recovery is held.
Thread ManagedScratch remains a separate class with unchanged review, expiry
and seven-day quarantine settings.

For your fresh intermediates, choose ManagedScratch disposition explicitly,
register consumers, move final keepers out, then record native keep or release
at closeout. Release only after the actual consumers stop. Do not fabricate
thread identity for a system producer or use account administration as a native
owner grant.

New installations have no external cleanup policy. To register an approved
local Mac policy, use `adapter-preview --machine HOST_ID --source-directory DIRECTORY --python PYTHON --policy POLICY`.
For the separately approved Kasten cache profile, also pass
`--docker-kasten-policy /Users/developer/.agents/skills/safe-mac-cleanup/policy-docker-kasten.toml`.
This named policy has a separate exact path/hash binding and `docker-kasten` stage.
Inspect the exact bindings and stage list, then use
`adapter-adopt --machine HOST_ID --revision REVISION --preview-digest DIGEST --yes`.
`adapter-remove` requires the same exact preview fields and does not delete
source, observations or recovery journals. Hash drift requires another explicit
preview/adoption. Native owner tools cannot register adapters or change policy.
The adapter imports existing policy roots, disabled classes and transaction
state; it does not run an old personal automation.

`--max-items` and `--max-bytes` bound process/plugin and cold-file work.
Registered native package, Docker and Apple utilities retain their own approved
policy accounting. `--budget-seconds` allows a soft admission window up to 900
seconds. It is not a kill timer for a destructive operation. Held stages and
unknown measurements are visible in the panel and CLI.

The read-only runtime stage inspects bounded known Colima and Cua disk metadata.
It never contacts or starts an engine. Unregistered engines, Cua placement and
existing inventory findings appear as protected owner review proposals with
exact paths, available size measurements, preservation limits and a next action.
These proposals grant no deletion or policy adoption. VM disks, guest data,
containers, volumes, models, histories and credentials remain protected. This
repository does not intercept external Cua creation routes. Before a future Cua
allocation, verify the required external SSD and every effective path through
the existing Cua storage preflight. An unverified route remains blocked.

SDK callers use `housekeepingRpc` through the existing typed plugin RPC path:
`housekeepingStatus`, `housekeepingRun`, `housekeepingPreview`,
`housekeepingAdapterPreview`, `housekeepingAdapterAdopt` and
`housekeepingAdapterRemove`. The panel, CLI and scheduler share this service.
A bounded plugin-cache stage requires the core's exact budget acknowledgement;
an older coordinator holds that stage until the required runtime is installed.

## Thread retention and machine cleanup

```sh
omnyo storage retention
omnyo storage retention --archive-after 30 --delete-after 90
omnyo storage retention --archive-after 30 --delete-after 90 --save --yes
omnyo storage retention --archive-after never --delete-after never --save --yes
omnyo storage retention --delete-storage-on-archive true --save --yes
omnyo storage retention --delete-storage-on-archive false --save --yes
omnyo storage retention --delete-dev-data-on-checkout-removal true --save --yes
omnyo storage usage
omnyo storage usage --rescan
omnyo storage usage --machine HOST_ID --rescan
omnyo storage usage --machine HOST_ID
omnyo storage remove-orphans --machine HOST_ID --yes
omnyo storage clear-large-files --yes
omnyo storage clear-large-files --machine HOST_ID --yes
omnyo storage retry-worktree-cleanup --machine HOST_ID
omnyo storage clear-thread --thread THREAD_ID --yes
omnyo storage clear-archived-files --machine HOST_ID --yes
omnyo storage remove-dev-instances --machine HOST_ID --yes
omnyo storage remove-dev-instances --machine HOST_ID --instance NAME --yes
omnyo storage remove-external-worktrees --machine HOST_ID --yes
omnyo storage remove-external-worktrees --machine HOST_ID --path WORKTREE_PATH --yes
omnyo storage worktrees status
omnyo storage worktrees rescan
omnyo storage worktrees clean SCAN_ID --yes
```

Without `--save`, retention thresholds only preview affected thread counts.
Days must be whole numbers from 1 to 3650, or `never`. Unspecified settings
preserve their saved values. Saved policies apply across all projects. The
hourly run processes up to 50 trees per action and skips groups with pinned
or shelved members. Archiving can remove worktrees including uncommitted changes. Deleting
removes history and thread storage. Preview first and save only when authorized.

Any `storage-retention.json` entry protects its whole storage owner, including
malformed receipts and dangling links. Cleanup skips protected owners before
stopping processes or removing files; manual clear-thread reports the hold.
Automatic thread deletion excludes a whole group when any member has a receipt.
An unavailable storage inspection stops deletion visibly. Cleanup counts include
only entries the host actually removed.

Delete thread storage on archive defaults to off. Set `--delete-storage-on-archive`
to `true` or `false`, or use the switch in the retention panel, which saves immediately.
Cleanup clears threads archived at least 3 hours. It applies to future manual and automatic archives, including each cascaded child,
while the plugin is enabled; it does not clear previously archived threads.
Conversations and uploaded attachments are kept. Pinned threads are skipped.
Cleanup waits for stopped threads and online persistent machines. Pending cleanup
survives reloads. An hourly check starts cleanup at most once every 24 hours;
younger archives and failures wait for a later daily run. Unarchiving or deleting cancels it, and
turning the setting off discards pending work on the next cleanup pass. Failures
are logged. Bulk archived-file cleanup also respects the core 30-second undo
grace and rechecks eligibility before each batch. Grace expiry does not prove
that environment teardown has completed. Threads without an environment need a completed scan to
identify their storage machine, just like clear-thread.

Delete development data when its checkout is removed defaults to off and is
independent of archive cleanup. Set `--delete-dev-data-on-checkout-removal` to
`true` or `false`, or use its switch in the retention panel, which saves immediately. When enabled, the
plugin scans online persistent machines hourly and removes missing-checkout
`~/.omnyo-dev` entries after successful scans, including manual scans. Existing
missing-checkout data is eligible too; retention previews count threads, not
these folders. The host rechecks checkout absence before removal, stops servers
working inside missing checkouts, and preserves entries whose source exists or
cannot be identified. An environment-removal event re-measures only that machine's `~/.omnyo-dev`, after any running cleanup there finishes. Startup,
machine reconnect (which rescans only the reconnected machine), and hourly scans recover missed events from filesystem state.
Offline/busy machines and failed cleanup retry on later
hourly scans. Disabling the setting prevents cleanup after subsequent scans.

Scans run in the background; rerun usage to read completion, progress, or failure.
`--rescan` without `--machine` scans every online machine that is not already scanning.
A completed report includes `disk` (total and free bytes of the volume holding thread storage).
Empty thread-storage folders are left out of thread counts, orphans and archived-file cleanup; scans cached before the machine reported folder emptiness count them until the next rescan.
Reports include `projectWorktrees`: counts of distinct managed worktree paths per project on the selected machine, including zero-count projects with a local source there; destroyed and removed environments are excluded, and `cleanupPendingCount` is a subset of the worktree count. Counts reflect current environment records, not filesystem measurements. Each project row also has `externalCount` and `externalBytes` for worktrees created outside Omnyo.
Scans run `git worktree list` in every project source on the machine and report `externalWorktrees`: linked worktrees of those repositories that are not a project source or the path of a live Omnyo environment, such as ones agents or other tools added with `git worktree add`. Each entry has `projectId`, `repositoryPath`, `path`, `branch` (null when detached), `locked`, `changedFileCount` (uncommitted and untracked files) and `unsavedCommitCount` (commits on no branch or tag when detached), both null when git could not inspect the worktree, `lastActivityAt` (latest change to the worktree's HEAD, index or HEAD reflog), measured `sizeBytes`, and `threads` linked through the path's encoded thread ID. Worktrees whose directory is missing, and bare entries, are left out. Worktrees inside thread storage are also counted in that thread's storage.
Remove-external-worktrees (page: Remove worktrees in the Clean up section, or a row's trash button) removes worktrees from the last scan with `git worktree remove`, which deletes the checkout, including ignored files such as dependencies, build output and local env files, and keeps its branch. Each worktree is rechecked on the machine first and kept when it is locked, has uncommitted or untracked changes, is detached with commits on no branch or tag, or is no longer a worktree; worktrees an Omnyo environment now uses are kept too. Running processes are not stopped. `--path` removes one worktree and fails if the last scan did not list it. To remove a kept worktree, add `--force` to `--path` (page: the row's trash button, which asks "Remove anyway?" and lists what is lost): it runs `git worktree remove --force`, twice for a locked worktree, discarding uncommitted changes and leaving detached commits unreachable for git to delete later; the branch is kept. `--force` requires `--path`, and bulk removal never forces. RPC `removeExternalWorktrees({hostId, paths: null})` removes every worktree from the last scan, and `removeExternalWorktrees({hostId, paths, force})` removes chosen ones. Both return `removedCount`, `removedBytes`, `skipped` (`path`, `reasons`: notWorktree, locked, uncommittedChanges, unsavedCommits or inUseByOmnyo) and `failed` (`path`, `message`). The page's trash button calls `startRemoveExternalWorktree({hostId, path, force})` instead, because deleting a large checkout can outlast a remote request: it rechecks the worktree and returns `{state: "skipped", reasons}` or `{state: "started"}`, then removes it in the background. `host` and `hosts` report each started removal in `externalWorktreeRemovals` (`path`, `state`: queued, running, completed with `removedBytes`, skipped with `reasons`, or failed with `message`) until the server restarts. `git worktree remove` has no time limit of its own, so a slow deletion is not cut off half-way.
Scans also measure `~/.omnyo-dev` on that machine. `developerStorage` is null when absent; otherwise it contains the path, total allocated bytes, and immediate folder/file sizes. Each entry includes `sourcePath`, `sourcePathState` (exists, missing, or unknown), and `threads` linked through host environment paths or a managed checkout’s thread ID. Matches cover threads known to this Omnyo server, including archived and hidden threads. Sources are recovered from saved launch metadata or hash-verified known/conventional checkout paths; unresolved sources remain null. Missing checkouts are cleanup candidates, not proof their development data is disposable. Each entry has `current`, true for the instance this Omnyo server runs from (its data directory); that entry is never removed, by name or by missing-checkout cleanup. The UI offers missing-checkout, archived-threads-only (every linked thread archived), other-instance and unidentified-source filters. Rows have checkboxes and each group has a select-all checkbox covering its filtered entries; "Remove selected" confirms once and calls `removeDevInstances({hostId, names, stopRunning: true})`, stopping dev servers running from the selection. The developer section initially shows the five largest entries, grouped into linked threads, other development instances and unidentified sources, each group with its own Show N more control inside the card. Paths are hidden from rows and available through the three-dot menu’s Copy source checkout path and Copy dev data path actions. When `developerStorage` is present, the machine list totals thread and development storage with a per-kind split, and the machine page's first card adds an Omnyo development row (instance count and size) to its category table under one total; the entry list stays in its own section.
Remove-dev-instances (page: Remove instances in the Clean up section) removes `~/.omnyo-dev` entries the last scan marked missing. `--instance NAME` (page: the trash button on any development row, which removes immediately; different rows queue in request order) removes only that entry, whatever its checkout state, and fails if the last scan did not list it. An entry counts as running when its daemon lock (`daemon.lock.lock`) was refreshed in the last 15 seconds; scans report this as `running`. RPC `removeDevInstances({hostId, names, stopRunning})` with `stopRunning: false` leaves a running entry whose checkout still exists in place and lists it in `running` (the page then asks "Stop and remove?"); with `stopRunning: true`, as the CLI does, it sends SIGTERM to the launcher PID recorded in that instance's `app-runtime.json` (SIGKILL after 15 seconds) and removes it. Processes in an existing checkout are otherwise left alone. The machine re-checks each source at removal time and skips entries whose checkout exists again or cannot be resolved. Before removal it stops every process whose working directory is inside a removed checkout (SIGTERM, then SIGKILL after 2 seconds), because servers keep running after their checkout is deleted. Process stopping is not available on Windows. A symlinked `~/.omnyo-dev` entry is removed as a link; the folder it points to is kept. It returns `removedCount`, `removedBytes`, `skippedCount` and `stoppedProcessCount`, and also deletes leftover `.omnyo-trash-*` folders in `~/.omnyo-dev`.
The largest-thread list initially shows five rows; Show N more reveals the remaining ranked threads in the report (up to 20), and Show fewer collapses it.
Reads never start scans. Remove-orphans requires a completed scan and only removes
storage the plugin identifies as orphaned from current SDK thread rows. Clear-large-files deletes
individual files of 10 MB or more from the thread storage of archived threads found in the last scan,
keeping smaller files and skipping pinned and running threads; reports show the matching totals as
`archivedLargeFiles`. Without `--machine` it covers every online machine with a completed scan.
The page uses `startClearLargeFiles({hostId})` to start background cleanup and
returns immediately; pass null for all scanned online machines. Read
`largeFileCleanup` in usage/host reports for queued, running, completed (file and byte
totals), or failed status. The synchronous CLI command and `clearLargeFiles` RPC
still wait for completion. Duplicate pending background jobs share the existing job; rescanning a machine that is already scanning returns the running scan.
Conversation history is never affected. The Storage page suggests it once archived threads hold 1 GB
or more of large files.
Clear-archived-files removes whole storage folders, including small files, from archived, stopped, unpinned threads found in the last scan on the selected machine. Conversations and uploaded attachments are kept.
The page starts this with `startClearArchivedFiles({hostId})`, which returns immediately. Read `archivedFileCleanup` in usage/host reports for queued, running, completed, or failed status with cleared thread and byte totals. Progress is reported after each batch; failed jobs can be retried for the remaining files. The CLI and `clearArchivedFiles` RPC still wait for completion. Cleanup is exclusive per machine; opening a confirmation does not block other actions.
Clear-thread, clear-archived-files and remove-orphans first stop processes whose working directory is inside each removed thread folder, matching worktree removal, so dev servers started there don't outlive their files.
Clear-thread requires a stopped thread and an online machine. When the thread no longer has an environment, a completed scan must identify its storage on exactly one machine. Thread clears and bulk cleanup run sequentially through the same per-machine FIFO queue. Other machines run independently. Every cleanup action stays available during a scan, and a finished scan leaves out entries cleared while it ran. Reports are cached
snapshots; rescan to see external filesystem changes.

Plugin RPC methods: `state(null)`, `preview({archiveAfterDays, deleteAfterDays, deleteStorageOnArchive, deleteDevDataOnCheckoutRemoval})`,
and `configure({archiveAfterDays, deleteAfterDays, deleteStorageOnArchive, deleteDevDataOnCheckoutRemoval})`; use null for Never and booleans for storage cleanup (both default to false for older policies). Storage
RPC methods are `hosts(null)`, `host({hostId})`, `scanHost({hostId})`,
`removeOrphans({hostId})`, `retryWorktreeCleanup({hostId})`, and
`clearThread({threadId})`, `clearArchivedFiles({hostId})` and `removeDevInstances({hostId, names: null})` for every missing instance or `removeDevInstances({hostId, names, stopRunning})` for chosen ones, `removeExternalWorktrees({hostId, paths: null})` or `removeExternalWorktrees({hostId, paths, force})`, and `startRemoveExternalWorktree({hostId, path, force})`. The plugin owns its host worker and scan database.

Cross-plugin protection is deferred. Pin automation target threads to keep them.
Disabling the plugin stops scheduled retention and removes its storage actions. Core's idle orphan sweep remains independent.

The page uses app toasts for setting saves, cleanup results, and action failures. Each cleanup control and row action shows a spinner and stays disabled while its own job is queued or running; other controls stay available, so additional actions queue instead of failing with a maintenance conflict. Successes within five seconds combine into one updating toast; failures stay separate. Running scans stay beside their controls. Completed cleanup messages are not retained inline or replayed on page open. Initial loading failures retain an inline retry action. Settings and unrelated machines remain usable during cleanup; report refreshes do not extend action locks.

`omnyo storage cleanup --machine HOST_ID --kind orphans|development|worktrees|externalWorktrees --yes` starts a background job and returns immediately. RPC: `startCleanup({hostId, kind})`. Read `maintenance` in usage/host reports for queued, running, completed or failed status. Retry failures with the same command; remaining candidates are re-read. The page uses this for bulk orphan removal, missing-checkout development data, worktree retries and removing worktrees created outside Omnyo. Existing synchronous commands remain available.

Action toasts appear when work completes or fails; progress shows on the control itself. They use a short title and a subtitle identifying the machine, thread, setting, or development-data folder; identifiers and byte totals belong in the subtitle. Development-data deletion reads “Development data deleted” when finished, and several deletions within five seconds read as one instance count with the bytes freed.

Background maintenance reports preserve `kind` in queued, running, completed, and failed states so action-specific notification titles do not depend on observing the running update.

The existing RPC result schema imports the original V1 `inUseByBb` reason as `inUseByOmnyo` in memory. It rejects mixed ownership reasons and unknown values; raw old responses and cleanup requests are never rewritten or replayed. Fresh results use only `inUseByOmnyo`.

Cleanup requests share a FIFO queue per machine. UI actions return immediately;
existing synchronous CLI/RPC commands wait for their turn and completion. Jobs
recheck safety at execution time; an entry already removed by Omnyo is handled
without error. Queueing does not grant force-removal or stop-process permission.
The in-memory queue is canceled on server shutdown or plugin reload.
`maintenanceJobs` in host reports contains the latest status for each maintenance
kind; `maintenance` remains the most recently updated kind for existing callers.
Thread/development rows use `startEntryCleanup({kind: "thread", threadId})` or
`startEntryCleanup({kind: "development", hostId, names, stopRunning})`, returning
`{id}`. Poll `entryCleanup({id})` for `queued`, `running`, `failed` with `message`,
or `completed` with `result` (the kind and the existing synchronous result fields).
Duplicate pending requests with the same parameters return the same id. Callers
must still confirm `stopRunning: true`; a non-stopping job reports running entries
in its result so the UI can ask for confirmation.
