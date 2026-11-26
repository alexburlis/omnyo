# RF-051 — Replace the process-global event rewrite generation map with the trigger-maintained `rewrite_epoch`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: the database already records every event rewrite in `thread_history_epochs.rewrite_epoch`, and a second, hand-maintained signal duplicates it. The sweep report overstated two points, and this card corrects them. First, the timeline calls in `apps/server/src/services/threads/timeline.ts` bypass the cache, so they are not affected. Second, the 331-line test should be retargeted to the database stamp rather than replaced, so the test-line saving is small.
- **Potential:** medium. One duplicated state mechanism disappears, together with four manual call sites that every future rewrite path would otherwise have to remember.
- **Confidence:** high on correctness (Proven by inspection). Medium on performance neutrality: the change adds one primary-key query on the read path and removes one query on the write path, but nobody has measured either.
- **Readiness:** ready, with a before/after timing as an acceptance check (see Verification).
- **Effort:** about half a day, including the timing.
- **Risk:** low to medium. The affected code is a read cache on the thread-list prompt-banner path and the per-thread session-option reads. If the change is wrong, those reads serve a stale "latest state" row.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none directly. RF-023 (superseded timeline and outline cache repositories) and RF-025 (timeline response shaping) touch nearby timeline code but not this cache. Either order works.
- **Why it deserves its place:** it removes a correctness obligation that is easy to forget. Today, any new code that deletes, rewrites or backfills events must call `bumpThreadEventRewriteGeneration`, or the cache silently serves stale rows on the same connection. The SQLite triggers already handle every such write, from any connection, in any process.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit's read-only worktree for that commit no longer exists, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>` and searched with `git grep` at that commit. All findings are Proven by inspection unless labelled otherwise. No tests were run, because the snapshot has no `node_modules`.

*What the subsystem does.* `listLatestThreadStateEventRowsByThreadIds` (`packages/db/src/data/events.ts:2321`) returns, for each thread, the newest event of a given "thread state" kind (for example the Codex goal, session options or session speed). It keeps a per-connection incremental cache, `latestThreadStateCaches` (`events.ts:2161`), whose entries are `LatestThreadStateCacheEntry` (`events.ts:2124`): `{ dataVersion, generation, latestSequence, scannedThroughSequence }`. On a warm call, `readLatestThreadStates` (`events.ts:2259`) scans only events after `scannedThroughSequence`. It falls back to a full rescan in two cases: when the newest state-typed sequence shrinks (`events.ts:2279-2284`), or when the remembered row is gone (`events.ts:2296-2299`). An incremental scan is only correct if nothing at or below `scannedThroughSequence` was rewritten. The cache therefore validates each entry with two signals (`events.ts:2348-2361`):

1. `getDatabaseDataVersion(db)`: `PRAGMA data_version`, which changes only when **another connection** commits. Any such commit discards every cached entry on this connection, including commits that only append.
2. `getThreadEventRewriteGeneration(threadId)`: a process-global `Map` in `packages/db/src/data/event-rewrite-generation.ts` (24 lines; `wc -l` = 24). It catches rewrites made on the **same** connection, but only when the writer remembered to bump it.

*The manual bump sites* (`git grep -n "bumpThreadEventRewriteGeneration" e9e1b74c3 -- packages apps plugins`):

| Site | What it covers |
|---|---|
| `packages/db/src/data/events.ts:411` in `deleteThreadEventSuffixInTransaction` | the edit-message rewind (caller `apps/server/src/services/threads/thread-edit-message.ts:755`) |
| `packages/db/src/data/events.ts:787-791` in `insertEvents` | out-of-order inserts. This needs `getHighWaterMarks(tx, …)` at `events.ts:752-754`, an unprepared query over `events` inside every `insertEvents` transaction, used only for this check |
| `packages/db/src/data/thread-pruning.ts:472-473` at the end of `advanceThreadPruningTransaction` | every pruning policy: rate limits (`rate-limit-pruning.ts:25`), resolved items (`resolved-item-pruning.ts:248`), turn diffs (`thread-pruning.ts:337`) and usage snapshots (`events.ts:5772`) |
| `packages/db/src/data/sweeps.ts:726` in `migrateNextCompletedEventItemOutput` | the completed-output migration `UPDATE events SET data` |

`purgeThreadHistoryChunk` (`packages/db/src/data/threads.ts:3005`) deletes events without a bump. It is only safe because it deletes the newest rows first, which trips the shrink-rescan path, and because the thread is deleted afterwards.

*Readers of the generation* (same `git grep` for `getThreadEventRewriteGeneration`): the cache (`events.ts:2358`, `events.ts:2373`) and `pruneThreadEventHistoryBestEffort` (`apps/server/src/services/system/event-pruning.ts:87`, `:121-123`). The pruning function sends the `history-compacted` hub notification when the generation changed during the prune. `getDatabaseDataVersion` has one reader, at `events.ts:2348`. Both getters are re-exported from `packages/db/src/data/index.ts:451-454`. `@omnyo/db` is `"private": true` (`packages/db/package.json:3`). Searches for the three symbols and for `event-rewrite-generation` and `data_version` found no other consumer: `git grep` over the whole snapshot outside `packages/db` and `apps/server`, and `rg` over `$OMNYO_PLUGIN_CHECKOUT`, returned nothing.

*The database signal that already exists.* Migration `packages/db/drizzle/0147_lucky_madelyne_pryor.sql` defines triggers on `events` that set a fresh random `rewrite_epoch` on the thread's `thread_history_epochs` row in four cases:

- a native-ID replacement whose content differs (`timeline_history_event_replacement`, BEFORE INSERT);
- an insert at or below `high_water_sequence`, or any `provider.env-resolved` insert (`timeline_history_event_insert`);
- any update that changes a column (`timeline_history_event_update`, which covers both threads when an event moves);
- any delete (`timeline_history_event_delete`).

No migration from 0148 to 0177 drops these triggers or rebuilds the `events` table. A scan of every `00(14x-17x)_*.sql` file for `trigger`, `__new_events`, `DROP TABLE events` and `thread_history_epochs` found only 0144, 0145, 0147 and 0154, and 0145 and 0154 touch search triggers only. `thread_history_epochs.thread_id` is the primary key (`0144_timeline_history_cache.sql:1-6`), and the row is created by the `threads` insert trigger. Server code already relies on `rewrite_epoch` as the rewrite signal: `getThreadHistoryState` (`packages/db/src/data/timeline-history-epoch.ts:17`) is used by `conversation-outline-cache.ts:635`, `thread-history-redaction.ts:52`, `timeline-worker.ts:137/173/304` and `routes/threads/data.ts:465`. In the same file as the cache, `readThreadEventStamps` (`events.ts:3457`) and `refreshActiveBackgroundTaskMemo` (`events.ts:3604`) validate a per-connection memo by `(rewriteEpoch, highWaterSequence)`. That is the same pattern this card proposes.

*Every write path to `events` is covered by a trigger.* `git grep -E "delete\(events\)|update\(events\)|DELETE FROM \`?events|UPDATE \`?events|insert\(events\)|INTO \`?events\b"` over `packages apps plugins`, excluding tests, finds only the sites listed above, old migrations and the perf seed script `packages/scripts/src/lib/seed-perf-fixture.ts:1066`. Inserts go through `insertStoredEventRow` (`events.ts:660`) with a fresh `createEventId()`, so an ignored duplicate `(thread_id, sequence)` does not fire the replacement trigger, and its AFTER INSERT trigger does not run.

*Correction to the sweep report.* The four calls at `apps/server/src/services/threads/timeline.ts:1249-1264` (`listLatestTimelineHeadStateRows`) all pass `beforeSequence`. Such calls return through `listLatestThreadStateRowsBeforeSequence` at `events.ts:2329-2335` and never touch the cache. The cache's real callers are `apps/server/src/services/threads/thread-runtime-display.ts:449` (`listPromptBannerActivityCandidateRows`, one call over all listed threads) and `apps/server/src/services/threads/thread-session-options.ts:45` (`readLatestThreadState`) and `:219` (`readThreadServiceTier`).

*Tests that encode the contract.*

- `packages/db/test/data/event-rewrite-generation.test.ts` (331 lines) checks which operations count as a rewrite: suffix delete, usage prune, resolved-delta prune, background-progress prune and oversized output migration do; no-op prunes, a fitting output scan, appends, ignored duplicates, daemon appends and inserts into other threads do not.
- `packages/db/test/data/thread-pruning.test.ts:400-412` and `:698-710` check that a failed prune does not bump and a successful one bumps once.
- `apps/server/test/system/thread-pruning-sweep.test.ts:118-131` checks that a sweep that removed events bumped.
- The cache behaviour is covered by `packages/db/test/data/events.test.ts:2569-2726` ("repeated latest-state lookups": rewind, remembered row gone, rows removed below the scan, rolled-back transaction, bounded head lookups) and `packages/db/test/query-plans.test.ts` around `:2600-2648`. The latter asserts that a warm lookup after an append scans from `after_sequence = 64` with `events_thread_state_thread_sequence_idx`.
- `packages/db/test/data/timeline-history-epoch.test.ts` (540 lines) already tests the triggers, including appends, ignored duplicates, backfill, credential binding, foreign SQL updates and deletes, and rollback (`:372`, `:430`).

*Maintenance cost today.* There are two rewrite signals that must agree, plus a third, broad one (`data_version`). The `Map` is per JavaScript isolate and never forgets entries. It cannot see writes from other processes or worker threads, which is why `data_version` has to stay. Every new rewrite path needs a manual bump and a new row in the 331-line test.

**Proposed end state and preservation argument**

*What disappears:*

- `packages/db/src/data/event-rewrite-generation.ts` (whole file);
- its import at `events.ts:76-80`, `sweeps.ts:10` and `thread-pruning.ts:19`;
- the bump calls at `events.ts:411`, `sweeps.ts:726` and `thread-pruning.ts:472-473`;
- the `highWaterMarks` lookup and comparison in `insertEvents` (`events.ts:752-754`, `:787-791`). `getHighWaterMarks` itself stays, because it has other callers at `events.ts:1143/1317/1426/1519` and `thread-pruning.ts:248`;
- the `dataVersion` and `generation` fields of `LatestThreadStateCacheEntry`;
- the `getDatabaseDataVersion` and `getThreadEventRewriteGeneration` exports at `packages/db/src/data/index.ts:451-454`.

*What remains:* the incremental scan and both rescan fallbacks in `readLatestThreadStates`, unchanged. Only the validation of cached entries changes.

*Canonical owner:* the SQLite triggers in migration 0147, read through the existing private helper `readThreadEventStamps` (`events.ts:3457`).

*New cache validation* in `listLatestThreadStateEventRowsByThreadIds` (pseudocode):

```ts
interface LatestThreadStateCacheEntry {
  rewriteEpoch: string;
  latestSequence: number | null;
  scannedThroughSequence: number;
}

// Read the stamps BEFORE scanning. A rewrite that commits between this read and
// the scan leaves the old epoch stored, so the next call rescans. Reading the
// stamps after the scan could miss such a rewrite.
const stamps = readThreadEventStamps(db, new Set(threadIds));
for (const threadId of threadIds) {
  const entry = cache.get(cacheKey(threadId));
  const stamp = stamps.get(threadId);
  if (entry !== undefined && stamp !== undefined && entry.rewriteEpoch === stamp.rewriteEpoch)
    cached.set(threadId, entry);
}
const read = readLatestThreadStates(db, args.kind, threadIds, cached);
for (const [threadId, state] of read.states) {
  const key = cacheKey(threadId);
  const stamp = stamps.get(threadId);
  cache.delete(key);
  if (stamp !== undefined) cache.set(key, { ...state, rewriteEpoch: stamp.rewriteEpoch });
}
```

`readThreadEventStamps` takes a `DbQueryConnection`, and `DbConnection` satisfies it, as `listActiveBackgroundTaskCountsByThreadIds` (`events.ts:3659`) already shows.

*New `history-compacted` rule* in `apps/server/src/services/system/event-pruning.ts` `pruneThreadEventHistoryBestEffort`: notify when `result.totalRemoved > 0`, and drop the before/after generation comparison. This is exactly today's condition. The generation is bumped only at `thread-pruning.ts:472-473`, only after the transaction succeeds, and only when `result.removed > 0`. For a thread-scoped prune, `result.threadId` is the target thread (`thread-pruning.ts:207-211`, cursor scope = thread id at `:110`), and `totalRemoved` is `result.removed` (`event-pruning.ts:78`). better-sqlite3 is synchronous, so nothing else can bump this thread's generation during the call. This rule is better than comparing `rewrite_epoch` before and after, as the sweep report proposed: that would cost two extra reads, and a commit from another connection in between would produce a spurious notification. Keep the notification when logging throws after a successful prune, for example by setting a `compacted` flag after `pruneThreadEventHistory` returns and notifying in `finally` when it is set. No notification on error, as today.

*How semantics survive (Proven by inspection):*

| Case | Today | After |
|---|---|---|
| Same-connection append | entry kept, incremental scan | epoch unchanged, entry kept, incremental scan |
| Another connection's append (timeline worker is read-only; any other process) | `data_version` changed, whole cache discarded, full rescans | epoch unchanged, incremental scan, which already picks up sequences above `scannedThroughSequence` |
| Rewrite on any connection (delete, update, replacement, backfill) | generation bump if the writer remembered (same process only), or `data_version` (other connections) | trigger sets a new epoch, full rescan of that thread |
| `provider.env-resolved` append | entry kept | trigger sets a new epoch, one extra full rescan of that thread (conservative; this event is a per-session provider lifecycle event, emitted at `apps/server/src/internal/events.ts:395`) |
| Output-migration update whose data is unchanged | bump (unnecessary) | no column change, so no trigger and no invalidation (correct; no row changed) |
| Call inside a transaction | cache bypassed (`events.ts:2337`) | unchanged |
| Rolled-back rewrite | Map bump survives the rollback (harmless extra rescan) | epoch rolls back with the transaction |
| Thread without a `thread_history_epochs` row (thread missing) | entry cached | entry not cached |

`listLatestThreadStateEventRowsByThreadIds` keeps its contract and signature. No HTTP, SDK, plugin or persisted-format contract changes, and there is no UI change. The `history-compacted` hub notification keeps its exact trigger condition.

*Non-goals:* changing the scan SQL, the cache limit, `getHighWaterMarks`, the triggers themselves, or `purgeThreadHistoryChunk`.

**Expected gain and cost**

- **Handwritten production lines (projection from the cited ranges, to be recounted after the change):** about 50 lines removed and about 10 added, a net of roughly 35-45. The removed lines are the 24-line module, 5 import lines in `events.ts`, 1 each in `sweeps.ts` and `thread-pruning.ts`, the 4-line re-export, 4 bump lines, 8 lines of the `insertEvents` high-water check and about 3 lines of generation handling in `event-pruning.ts`.
- **Tests (projection):** the 331-line generation test is retargeted rather than deleted. Its `expectGenerationBump` reads `getThreadHistoryState(db, threadId).rewriteEpoch` instead of the Map. The three append and duplicate cases that repeat `timeline-history-epoch.test.ts:372` can be dropped, which saves about 40-60 lines. `thread-pruning.test.ts` (2 cases) and `thread-pruning-sweep.test.ts` (1 case) switch to comparing epochs, with roughly equal line counts.
- **Mechanisms:** before, three signals (Map, `data_version`, trigger epoch) served two readers. After, one database-owned signal serves every reader. Four manual obligations disappear. The test also gains value: it now checks the real owner, the triggers, through the repository's own write paths.
- **Performance (Hypothesis, unmeasured):**
  - Read path: one extra prepared primary-key lookup per non-transactional cached call (`json_each` over the requested ids against `thread_history_epochs`). This replaces a `PRAGMA data_version` call and Map lookups. Each warm call already runs a scan with two indexed subqueries per thread plus a row fetch, so the stamp read should be a small fraction of the call.
  - Cross-connection append commits no longer flush the cache. In the current single-writer server process this rarely happens, so the gain there is likely small.
  - Write path: every `insertEvents` transaction loses one unprepared `getHighWaterMarks` query over `events`. That is a probable small gain on the event-ingest hot path.

**Execution steps**

1. **Reconfirm the baseline.** On the working branch, rerun:
   - `git grep -n -E "EventRewriteGeneration|getDatabaseDataVersion|data_version" -- packages apps plugins`
   - the `events` write-path search from Context
   - `rg -n "getThreadEventRewriteGeneration|bumpThreadEventRewriteGeneration|getDatabaseDataVersion" $OMNYO_PLUGIN_CHECKOUT --glob '!node_modules'`
   - a check that no migration after 0147 drops `timeline_history_event_*` triggers or rebuilds `events`

   **Re-plan if** any of these holds: a new reader of the generation or of `data_version` exists; a new write path to `events` bypasses the triggers (for example a table rebuild migration, or `PRAGMA recursive_triggers`-dependent REPLACE deletes); or a caller of `listLatestThreadStateEventRowsByThreadIds` without `beforeSequence` has appeared on a different hot path.
2. **Baseline timing.** Before editing, record a timing that can catch a read-path regression; see the performance item under Verification for the setup.
3. **Checkpoint A: the cache.** In `packages/db/src/data/events.ts`:
   - change `LatestThreadStateCacheEntry` (`:2124`) to `{ rewriteEpoch: string; latestSequence: number | null; scannedThroughSequence: number }`. `LatestThreadStates` (`:2137`) still picks only `latestSequence | scannedThroughSequence`;
   - in `listLatestThreadStateEventRowsByThreadIds` (`:2348-2374`), replace the `dataVersion` and generation logic with the stamp logic from the pseudocode above. Keep the stamp read before `readLatestThreadStates`. `readThreadEventStamps` is defined later in the file as a function declaration, so it is hoisted and the call works;
   - remove `getDatabaseDataVersion` and `getThreadEventRewriteGeneration` from the import at `:76-80`.

   Run the `packages/db` tests named below. They must pass unchanged.
4. **Checkpoint B: the write-side bumps.**
   - Remove the bump at `events.ts:411` (keep `markThreadPruningWork` inside the `if`).
   - Remove `highWaterMarks` (`events.ts:752-754`) and the comparison (`:787-791`) from `insertEvents`.
   - Remove the bump and its import at `packages/db/src/data/sweeps.ts:10` and `:726`.
   - Remove the bump at `packages/db/src/data/thread-pruning.ts:472-473` and the import at `:19`. The function then returns `result` directly.
   - Delete `packages/db/src/data/event-rewrite-generation.ts` and its re-export block at `packages/db/src/data/index.ts:451-454`.
5. **Checkpoint C: pruning notification.** In `apps/server/src/services/system/event-pruning.ts`, drop the `getThreadEventRewriteGeneration` import (`:4`) and the `generation` capture (`:87`). Base the `history-compacted` notification on `result.totalRemoved > 0` for a successful prune, as described in the end state.
6. **Retarget the tests.**
   - `packages/db/test/data/event-rewrite-generation.test.ts`: change `expectGenerationBump(threadId, …)` to take `db` and compare `getThreadHistoryState(db, threadId).rewriteEpoch` before and after. Change the `otherBefore` checks the same way. Optionally rename the file to `event-rewrite-epoch.test.ts`, and drop the append and ignored-duplicate assertions that `timeline-history-epoch.test.ts:372` already covers. Keep the per-operation rewrite and no-op cases, because they are the unique obligation.
   - `packages/db/test/data/thread-pruning.test.ts:400-412` and `:698-710`: assert the epoch is unchanged after the injected failure and changed after the successful prune. A random epoch has no `+ 1`, so use `not.toBe(before)`.
   - `apps/server/test/system/thread-pruning-sweep.test.ts:118-131`: compare `getThreadHistoryState(harness.db, thread.id).rewriteEpoch` against the value captured before the sweep.
   - Add one cache regression case to `events.test.ts` "repeated latest-state lookups". Warm the cache, then delete a below-scan state row through a second connection to the same file database, then insert a newer state row, and assert the result. This covers the cross-connection case that `data_version` used to guard. A second connection is only possible with a file database; if the test helper only offers `:memory:`, use the `createConnection(path)` pattern that `timeline-history-epoch.test.ts:430` uses for "across reopen".
   - Add one case asserting that a cross-connection plain append keeps the warm scan incremental (the `after_sequence` parameter equals the previous through-sequence), mirroring `query-plans.test.ts` around `:2620-2631`.
7. **Clean up and recount.** Run `git grep -n -E "RewriteGeneration|getDatabaseDataVersion|data_version" -- packages apps` and expect no matches. Inspect the full diff for unrelated changes. Recount production lines with `git diff --stat -- packages/db/src apps/server/src` against the baseline commit.

**Verification and acceptance criteria**

Commands. The scripts exist in `packages/db/package.json` and `apps/server/package.json` at the snapshot, and the file filters are standard vitest arguments. They could not be run from the snapshot, which has no `node_modules`.

- `cd packages/db && pnpm test -- test/data/event-rewrite-generation.test.ts test/data/thread-pruning.test.ts test/data/events.test.ts test/query-plans.test.ts test/data/timeline-history-epoch.test.ts test/omnyo-thread-state.test.ts` (use the new file name if renamed). All must pass. The existing cache tests in `events.test.ts:2569-2726` and the warm-scan assertion in `query-plans.test.ts` must pass **without edits**. Editing them to make the change pass is a stop condition.
- `cd apps/server && pnpm test -- test/system/thread-pruning-sweep.test.ts`, plus any server test that matches `history-compacted` (find them with `git grep -l "history-compacted" -- apps/server/test`).
- `cd packages/db && pnpm typecheck` and `cd apps/server && pnpm typecheck`.
- From the repository root, run `pnpm exec oxlint --fix <changed files>`, then `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. These follow the repository's `.oxlintrc.json` and `.oxfmtrc.json` and the root `format:check` script.

Behaviour that must hold:

- No stale latest-state row after a rewind, prune, output migration, backfill or cross-connection delete.
- Appends keep the warm scan incremental.
- Rolled-back transactions leave no cached state.
- `history-compacted` is sent exactly when a prune removed rows, and not on failure.

Performance. No repository benchmark targets this cache: the existing ones are `apps/server/test/performance/history-stalls.bench.test.ts`, `ingress-lock-burst.bench.test.ts` and the scorecard. Before and after the change, time 1,000 warm calls of `listLatestThreadStateEventRowsByThreadIds` over 500 threads seeded with state rows, on a file database in WAL mode with the same build and machine, plus 1,000 `insertEvents` batches of 20 appends. A throwaway script under `~/scratch/omnyo/<owner-id>--rf-051/` that imports `@omnyo/db` from source is enough. Report the medians and spread.

Accept if the read-path median does not regress beyond the run-to-run spread. If the read path is slower beyond noise, try folding the stamp into the existing `scanLatestThreadStateSequences` statement before giving up: return `rewrite_epoch` as a column from a join on `thread_history_epochs`, and send mismatched threads to the existing `rescanThreadIds` path. That costs no extra statement. Do not claim neutrality without these numbers.

Structural completion: `event-rewrite-generation.ts` is gone, no production code calls a manual bump, `data_version` is no longer read anywhere in `packages/db/src`, and the triggers are the only rewrite signal.

**Rollback and stop conditions**

The change is confined to `packages/db/src/data/{events,sweeps,thread-pruning,index}.ts`, the deleted module, `apps/server/src/services/system/event-pruning.ts` and the tests. There is no migration, persisted-format or API change, so reverting the commit restores the old behaviour completely, and the caches are in-memory only.

Stop and re-plan in any of these cases:

- An existing cache test in `events.test.ts` or `query-plans.test.ts` fails and cannot be fixed without changing its expectation.
- A write path to `events` is found that the triggers do not cover.
- Another process or package reads `getThreadEventRewriteGeneration` or `getDatabaseDataVersion`.
- The timing shows a read-path regression beyond noise even after folding the stamp into the scan statement.

The safer smaller alternative is to keep `data_version` and replace only the Map with the per-thread `rewriteEpoch` comparison. That still removes the four manual bumps and the `insertEvents` high-water query.
