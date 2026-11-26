# RF-070 — One per-host job runner for the four exclusive Storage & Retention cleanup starters

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplicated job lifecycle is real, but the sweep overstated both its extent and the gain. Four starters share the exclusive per-machine lifecycle, not five: `startEntryCleanup` has a different shape and keeps its own code. The expected net reduction is about 15 to 30 handwritten production lines, not the 70 to 100 the sweep estimated.
- **Potential:** low. One maintained mechanism disappears: four hand-copied versions of the queued, running and failed transitions, together with the "reserve before the first await" ordering rule and the abort rule. Nine copies of the jobs-set bookkeeping also become one. The line saving is small.
- **Confidence:** high that the duplication exists as described below. Medium for the line estimate, which is a projection from a sketch and was not measured after a real edit.
- **Readiness:** ready. No product decision is needed, and the wire schemas and RPC contract stay unchanged.
- **Effort:** small, about 2 to 3 hours including the targeted test run.
- **Risk:** low. The realistic regressions are a lost first-in, first-out (FIFO) order if `acquire` moves after an `await`, a changed failure state after plugin disposal, and a different number of `changed` realtime publishes. Only the first two are user-visible, and existing tests cover queue order and failure states.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-124 ("One reconnect-recovery service helper in Storage & Retention") touches the same plugin, but in `src/server.ts` service wiring rather than these starters, so the two do not conflict. RF-065 (worktree deletion-safety rules shared with git-worktree) touches `externalWorktreeReasons` near `startRemoveExternalWorktree`. Land RF-065 and RF-070 in separate commits, rebasing whichever lands second. RF-033 (a serial job-queue core for plugin install and update jobs) is a similar pattern in a different package. Do not share code across the two: plugins must stay independently forkable (`docs/forkable-plugins.md`).
- **Why this deserves its place:** the per-machine FIFO rule is subtle. `acquire(hostId)` must be called synchronously, before the starter's first `await` after the dedupe check, or two clicks can run out of order. Today that rule is restated in four places. A fifth starter written by copy-paste is the likely way the order breaks. The item ranks low because the saving is modest and the current code works.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The read-only snapshot worktree named in the task was no longer present. The files were therefore read from `git archive` of that commit, extracted to a temporary directory.

The Storage & Retention plugin (`plugins/storage-retention`) inspects and cleans machine storage. Cleanup on a machine is exclusive: `createStorage` in `plugins/storage-retention/src/storage.ts` keeps a per-host lock, `acquire(hostId, started?)` at lines 441-473. That function uses `busy` and `waiters` (lines 332-334): it resolves at once when the host is idle, otherwise it queues a resolver. It returns a `release` function, and when the last release runs it may kick `cleanDevelopmentStorage`. Because the app must return quickly from remote requests, the page starts long cleanups through "start" RPCs that return immediately and run in the background. Those RPCs report status through in-memory maps that `host`/`hosts` reports read (lines 813-822). Each status change publishes the `changed` realtime event (`changed`, lines 357-359). The page refetches on that event (`plugins/storage-retention/app.tsx:407`, `useRealtime("changed", refresh)`).

Observed facts (Proven by inspection), all in `plugins/storage-retention/src/storage.ts`:

| Starter | Lines | Lifecycle skeleton (from `acquire` to the `jobs` bookkeeping) | Status store | Publishing today |
|---|---|---|---|---|
| `startClearArchivedFiles` | 1320-1380 | 1328-1377 (50 lines) | `archivedFileCleanups` | queued, running and final, through explicit `changed()` calls. Progress updates the map without publishing; `discard` → `forget` → `store` publishes per batch. |
| `startClearLargeFiles` | 1524-1592 | 1553-1586 (34 lines), inside a per-target loop | `largeFileCleanups` | Queued does not publish per target; one `changed()` runs after the loop (line 1589). Running and final publish per target. |
| `startRemoveExternalWorktree` | 2033-2129 | 2073-2126 (54 lines) | `worktreeRemovals`, through `setWorktreeRemoval` (2023-2031, which calls `changed()`) | queued, running and final, through `setWorktreeRemoval`. There is no `finally`. |
| `startCleanup` | 2205-2268 | 2219-2265 (47 lines) | `maintenanceJobs` and `maintenance`, through `setMaintenance` (476-485, which calls `changed()`) | Queued publishes twice (`setMaintenance`, then line 2221). Running publishes once. The final step publishes twice (`setMaintenance`, then `finally changed()` at 2260). |
| `startEntryCleanup` | 2282-2325 | n/a | `entryJobs`, `pendingEntries` (2270-2271) | It never publishes. `app.tsx:604-615` `runEntryCleanup` polls `entryCleanup({id})` every 500 ms. |

The four exclusive starters all repeat the same skeleton:

1. A dedupe check on the `queued` or `running` state.
2. `const reservation = acquire(hostId)`, called before any later `await`.
3. A status write for `queued`.
4. An async IIFE that runs `const release = await reservation`, writes `running`, and hands `release` to a worker function. That worker releases the lock in its own `finally`: `clearArchivedFilesOn` 1382-1407, `clearLargeFilesOn` 1250-1312, `removeExternalWorktrees` 2131-2203, and `removeOrphans`, `removeDevInstances` and `retryWorktreeCleanup`.
5. `catch (error) { if (!lifecycle.signal.aborted) <write failed with error.message> }`.
6. In three of the four starters, `finally { changed(); }`.
7. `jobs.add(job); void job.finally(() => jobs.delete(job));`.

The jobs-set pair from step 7 appears at nine sites: lines 1160-1161 (`startScan`), 1376-1377, 1585-1586, 1650-1651 (`cleanDevelopmentStorage`), 1729-1730 (`reconcileDevelopmentStorage`), 2125-2126, 2264-2265 and 2321-2322. `clearPendingArchives` at 1861-1865 uses the variant `void job.then(() => jobs.delete(job), () => jobs.delete(job))`, which does not create an unhandled rejection when the job rejects. The `.finally` form does.

Corrections to the sweep report:

- **`startEntryCleanup` does not share the reservation lifecycle.** It never calls `acquire` itself. It passes a `started` callback into `clearThreadStorage` (the `acquire` call is at line 1789, after host resolution and `requireHost`) or into `removeDevInstances`. For thread entries, the host is unknown until `clearThreadStorage` resolves it. Its statuses are keyed by a random id rather than by host, and it records `failed` without the abort check. Forcing it into the runner would need caller-specific switches, which is the anti-goal the sweep itself named. It should only use `track`.
- **`startScan` is not exclusive.** It never reserves the host, so it also only uses `track`.
- **The changed-timing differences are mostly redundant publishes, not divergent semantics.** No test counts the `changed` publishes from cleanup jobs. `src/storage.test.ts:2905` "refreshes the storage page only for host changes it shows" counts `changed` signals for host events only.
- **Line counts.** The five starters occupy 335 physical lines (61 + 69 + 97 + 64 + 44, from the ranges above). Only the four skeleton blocks, 185 lines in total, are rewritten. The sketch in the next section yields about 25 to 45 fewer lines at the call sites, against about 35 new lines for the two helpers.

Consumers checked. Command: `rg -n "startEntryCleanup|startCleanup|startClearLargeFiles|startClearArchivedFiles|startRemoveExternalWorktree|entryCleanup\b" -g '!src/storage.ts'` over `plugins/storage-retention`.

- RPC registration in `src/server.ts:216-232`.
- Contract schemas in `src/contract.ts:54-127`.
- The CLI call at `src/cli.ts:142` (`storage.startCleanup`).
- App calls in `app.tsx` at 605, 608, 740, 759, 1185, 1242, 1266, 1339 and 1391.
- Mocks in `app.test.tsx:148-201`.
- Tests in `src/storage.test.ts`: 48 (queue order and continuing after a failure), 290-320 (maintenance running, dedupe and failed), 342-398 (archived cleanup), 864-1000 (large files), 1293, 1691, 1799 and 1913 (worktree removal, including "rechecks external worktree ownership after waiting for storage cleanup" at 1811), and 3304.
- Documentation in `README.md:111,149,152` and `skills/storage-retention/SKILL.md:267,276,284,300,315-317`.

All of these address the RPCs by name, and none depends on the internal helper shape. The status schemas live in `src/storage-types.ts:141-207` and 367 and stay unchanged. These statuses are not persisted: they live in in-memory maps that reset on restart, as `SKILL.md:267` documents ("until the server restarts"). No migration is involved.

Maintenance cost today: any change to how a cleanup job reports failure, observes disposal or publishes has to be made four times. The copies have already drifted, as the duplicate publishes in `startCleanup`, the missing per-target queued publish in `startClearLargeFiles` and the missing `finally` in `startRemoveExternalWorktree` show.

**Proposed end state and preservation argument**

Two local helpers live inside `createStorage`, next to `changed` and `acquire`. They are not exported.

```ts
const jobs = new Set<Promise<unknown>>();

function track<T>(job: Promise<T>) {
  jobs.add(job);
  void job.then(
    () => jobs.delete(job),
    () => jobs.delete(job),
  );
  return job;
}

// Exclusive per-machine background job. acquire() runs synchronously here,
// before any await, so jobs on one machine start in click order.
function runHostJob(
  hostId: string,
  job: {
    queued: () => void;
    running: () => void;
    run: (release: () => void) => Promise<void>; // run must hand release to a worker that releases in finally
    failed: (message: string) => void;
  },
) {
  const reservation = acquire(hostId);
  job.queued();
  changed();
  track(
    (async () => {
      try {
        const release = await reservation;
        job.running();
        changed();
        await job.run(release);
      } catch (error) {
        if (!lifecycle.signal.aborted)
          job.failed(error instanceof Error ? error.message : String(error));
      } finally {
        changed();
      }
    })(),
  );
}
```

What disappears: the four inline IIFEs with their try/catch/finally, the four `const reservation`/`await reservation` pairs, the four abort checks and error-message extractions, the `changed()` calls inside `setMaintenance` and `setWorktreeRemoval`, the redundant `changed()` at line 2221, and the nine hand-written jobs-set pairs.

What remains in each starter: its pre-checks, its dedupe key, its status shape (through `queued`, `running` and `failed` closures) and its `run` body, including how it maps a result to a `completed` (or, for worktrees, `skipped`/`failed`) status. `startEntryCleanup`, `startScan`, `cleanDevelopmentStorage`, `reconcileDevelopmentStorage` and `clearPendingArchives` keep their bodies and only switch to `track`.

How current semantics survive:

- **FIFO per machine.** `acquire` is still called synchronously inside each starter, after its last pre-check `await`. `runHostJob` calls `acquire` before it does anything else, so call order equals reservation order. This holds only if every starter calls `runHostJob` without an `await` between its final dedupe check and the call. The `latest` re-check in `startRemoveExternalWorktree` (2069-2072) stays directly before the call.
- **Release ownership.** This is unchanged: `run` hands `release` to the existing worker functions, which release in `finally`. The early "no longer in the scan" path in `startRemoveExternalWorktree` (2081-2092) still calls `release()` itself inside `run`.
- **Disposal.** This is unchanged: failures are not recorded after `lifecycle.abort()`, and `changed()` is still a no-op after abort. `api.onDispose` still awaits every tracked job (lines 352-355).
- **Status shapes and wire schemas.** These are unchanged. The archived cleanup keeps its counters in the queued, running and failed states by closing over `clearedThreads`/`clearedBytes`. Large-file cleanup keeps `startedAt`.
- **Publishing.** This is now uniform: one publish each for queued, running and final.
  - `startCleanup` drops from five publishes to three. Only redundant publishes go.
  - `startRemoveExternalWorktree` keeps three. Its early-completed path at 2052-2058, which does not run a job, gains an explicit `changed()` because `setWorktreeRemoval` no longer publishes.
  - `startClearLargeFiles` publishes queued once per target instead of once after the loop. This is a small, intentional change: N machines produce N refetch triggers in the same tick instead of one. Keep the trailing `changed()` at line 1589 only when the loop queued nothing. This preserves today's single publish when no target qualifies. Hypothesis: nothing depends on that publish, but keeping it costs one line.
  - The archived per-batch progress stays unpublished, as today.

Non-goals: changing `startEntryCleanup`'s id-keyed polling contract, making scans exclusive, adding cancellation, or changing any RPC, CLI or schema. The helpers stay local to the plugin, with no SDK addition.

Why this is the simplest sufficient option: a class or generic job-queue module would add a layer for four callers. Two closures inside the existing factory remove the duplication without changing ownership. The fallback, if the `runHostJob` call sites need caller-specific options, is to land only `track`, which is still a correctness-neutral consolidation.

**Expected gain and cost**

- **Mechanisms.** Before, there were four copies of the exclusive job lifecycle and nine copies of the jobs-set bookkeeping in two variants. After, there is one `runHostJob` and one `track`.
- **Handwritten production lines.** Projection, not a measurement: a net reduction of about 15 to 30 lines in `plugins/storage-retention/src/storage.ts`. The basis is the 185-line skeleton blocks becoming about 140 to 160 lines of call sites, plus about 35 helper lines, minus about 13 lines from the nine jobs-set pairs. Recount after the edit with `git diff --stat` and `rg -c "jobs.add" plugins/storage-retention/src/storage.ts`, where the expected count is 1.
- **Tests, generated code and docs.** No changes are expected. `README.md` and `SKILL.md` describe RPC behavior only.
- **Maintenance link.** A future change to failure reporting, disposal or publishing for exclusive cleanups becomes one edit. The FIFO rule is stated once, in a comment beside `runHostJob`. A new exclusive starter cannot forget the abort check or the jobs-set registration.
- **Cost and tradeoffs.** The `queued`, `running` and `failed` closures read slightly less linearly than the inline IIFEs. Publish counts change as described above.
- **Performance.** Hypothesis: neutral or slightly better, because fewer redundant `changed` publishes and refetches happen in `startCleanup`. No benchmark exists, and none is warranted for in-memory status writes.

**Execution steps**

1. **Reconfirm the baseline.** Open `plugins/storage-retention/src/storage.ts` at the current main.
   - Confirm that `acquire`, `changed`, `jobs`, the four starters and the nine jobs-set sites still match the table above. Use `rg -n "jobs.add|const reservation = acquire|function start" plugins/storage-retention/src/storage.ts`.
   - Re-plan if any of the following holds: a starter now awaits between its dedupe check and `acquire`; a worker function no longer releases in `finally`; `setMaintenance` or `setWorktreeRemoval` gained a caller outside the starters; or a test now asserts a specific number of `changed` publishes for a cleanup job.
2. **Add the helpers.** In `createStorage`, change `const jobs = new Set<Promise<void>>()` (line 351) to `Set<Promise<unknown>>`, then add `track` directly after the `api.onDispose` block. Add `runHostJob` directly after `acquire` (after line 473), with a two-line comment stating the reserve-before-await rule and the release-handoff rule. Use the signatures from the end-state sketch.
3. **Checkpoint A, a mechanical step.** Replace the nine `jobs.add(job); void job.finally(...)` pairs and the `clearPendingArchives` `.then` variant with `track(job)`. Where a function returns `job`, `return track(job)` is fine. Run the targeted tests from the verification section.
4. **Convert `startCleanup`** (2205-2268). Remove the `changed()` from `setMaintenance` (line 484), because `runHostJob` now publishes; the only callers are in `startCleanup` (2220, 2226, 2251, 2254). Replace the reservation through the `jobs` block with a `runHostJob` call:
   - `queued: () => setMaintenance(hostId, { state: "queued", kind })`
   - `running: () => setMaintenance(hostId, { state: "running", kind })`
   - `run`: the existing `kind` branch body, ending with the `completed` `setMaintenance`
   - `failed: (message) => setMaintenance(hostId, { state: "failed", kind, message })`

   Delete line 2221.
5. **Convert `startClearArchivedFiles`** (1320-1380). Keep the `clearedThreads`/`clearedBytes` locals. Add a local `set = (state: "queued" | "running") => archivedFileCleanups.set(hostId, { state, clearedThreads, clearedBytes })`. Then:
   - `queued: () => set("queued")` and `running: () => set("running")`
   - `run`: call `clearArchivedFilesOn(hostId, release, progress)`. The progress callback updates the locals and calls `set("running")`. Finish by writing `completed`.
   - `failed`: writes the failed status with the counters.
6. **Convert `startClearLargeFiles`** (1553-1586, inside the loop). Pass `target` as the host:
   - `queued` and `running` write `{ state, startedAt: Date.now() }`.
   - `run`: calls `clearLargeFilesOn(target, release)` and writes `completed`.
   - `failed`: writes `{ state: "failed", message }`.

   Track whether the loop queued anything, and keep line 1589's `changed()` only when it did not.
7. **Convert `startRemoveExternalWorktree`** (2073-2126). Remove the `changed()` inside `setWorktreeRemoval` (line 2030). Add an explicit `changed()` after the early-completed write at 2054-2058. Then:
   - `queued` and `running` call `setWorktreeRemoval` with the matching state.
   - `run` contains the existing `remains` check, which keeps its own `release()` call on the early path, and the result mapping to `skipped`, `failed` or `completed`.
   - `failed` writes the failed removal.

   Keep the `latest` re-check immediately before `runHostJob`.
8. **Checkpoint B.** Run the targeted tests, typecheck and lint. Inspect the diff to confirm that no starter awaits between its last check and `runHostJob`, and that `rg -n "lifecycle.signal.aborted\)\s*$" plugins/storage-retention/src/storage.ts` no longer lists the four removed catch sites.
9. **Clean up.** Delete no other code. `setMaintenance` and `setWorktreeRemoval` stay as status writers. Update no docs, because the RPC behavior is unchanged. Recount lines with `git diff --stat -- plugins/storage-retention/src/storage.ts`.

**Verification and acceptance criteria**

Not run: the snapshot has no `node_modules`. The scripts below exist in `plugins/storage-retention/package.json` (`"test": "vitest run --config vitest.config.ts"`, `"typecheck": "tsc --noEmit"`, `"lint": "oxlint ..."`). The plugin is a pnpm workspace member through `plugins/*` in `pnpm-workspace.yaml`. The package name is `omnyo-plugin-omnyo--storage-retention`.

- From the repository root:
  - `pnpm --filter omnyo-plugin-omnyo--storage-retention test -- src/storage.test.ts app.test.tsx`. Expected outcome: all tests pass, with no assertion edited. The ones that matter most are `storage.test.ts:48` (queue order, continuing after a failure), 290-320 (maintenance running, dedupe returning `null`, failed with the message), 342-398 (archived cleanup counters), 864-1000 (large-file statuses across `hostId: null`), and 1811 (the worktree ownership recheck after waiting for the lock).
  - `pnpm --filter omnyo-plugin-omnyo--storage-retention typecheck`
  - `pnpm --filter omnyo-plugin-omnyo--storage-retention lint`
  - `pnpm exec oxfmt plugins/storage-retention/src/storage.ts`, then `pnpm exec oxlint --deny-warnings --format=agent plugins/storage-retention/src/storage.ts`
- **Behavior checks to confirm in the diff, or with a new focused test if a reviewer wants proof.** Add a test only if the existing ones do not already fail when `acquire` is moved after an `await`.
  - Two `startCleanup` calls on one host with different kinds run in call order.
  - After `api.onDispose`, a rejected job leaves no `failed` status, and dispose resolves.
  - `startRemoveExternalWorktree` on a path that is gone from the scan returns `{state: "started"}`, records `completed` with `removedBytes: 0`, and publishes.
- **UI.** No visual change is expected. Alex tests UI himself. The relevant page states are the queued, running, completed and failed badges for maintenance, archived files, large files and worktree removal in the Storage page's Clean up section.
- **Structural completion.**
  - `rg -c "jobs.add" plugins/storage-retention/src/storage.ts` returns 1.
  - `rg -c "const reservation = acquire" plugins/storage-retention/src/storage.ts` returns 1, inside `runHostJob`.
  - `setMaintenance` and `setWorktreeRemoval` no longer call `changed()`.
  - The net production line change is negative.

**Rollback and stop conditions**

The change is confined to one file, `plugins/storage-retention/src/storage.ts`, and touches no persisted data or wire format. Revert it by reverting its commit. Checkpoint A (`track` only) can land and stay on its own if the second half is abandoned.

Stop, and land only Checkpoint A, if any of the following holds:

- A starter needs an option inside `runHostJob`, such as a flag to skip a publish, to keep a status per target or to skip the abort check. That is the caller-specific switch this card rules out.
- A test depends on today's exact publish count.
- The net line count of the `runHostJob` conversion is zero or positive after formatting.

Stop and re-plan if a newer commit has made scans exclusive or has added a fifth exclusive starter. The fifth starter would strengthen the case, but its shape must be checked first.
