# RF-023 — Delete the primary-database timeline-record and conversation-outline repositories that the history-cache database replaced

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** Adjusted. The central claim holds. The scope gains one production function, `getLatestStoredConversationOutlineSequence`, and one consumer the sweeps missed: the QA harness `tests/qa/instant-chat-history/service-proof.mts` hashes the deleted file by path and would crash with `ENOENT` if that path were not removed from its list.
- **Potential:** Low to medium. About 174 physical production lines go away, and with them a second, dead persistence API for timeline caching.
- **Confidence:** High. The search was a whole-tree symbol search at the snapshot, and the retirement commits are confirmed in the retired private Git store.
- **Readiness:** Ready.
- **Effort:** Small, about 1 to 2 hours. Most of the time goes into rewriting three test fixtures.
- **Risk:** Low. `@omnyo/db` is `"private": true`. It has no dynamic discovery or registration side effects. No table, migration or persisted format changes.
- **Prerequisites:** None.
- **Related or overlapping items:**
  - RF-019 (retire or register the `tests/qa` proof harnesses). If RF-019 deletes `tests/qa/instant-chat-history/` first, step 6 below becomes a no-op.
  - RF-051 (detect event rewrites with `rewrite_epoch`) and RF-025 (timeline response shaping). Both touch the same timeline worker area but not these files.
  - An earlier card from a separate numbering run, `docs/2026-11-26-codebase-simplification-audit/opportunities/RF-202-primary-history-cache-apis.md`, describes the same deletion with a narrower scope: it does not cover the outline-sequence reader or the QA harness. Execute only one of the two cards.
  - The separate decision ISS-S09-02 covers stale rows that older builds left in the dormant tables. This card does not change that behavior.
- **Why it deserves its place:** It removes verified dead machinery with no behavior change. Today, anyone working on history caching meets two cache persistence APIs and has to work out which one is live. After this change only `openHistoryCache` remains. The gain is modest, but the cost and the risk are both small.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The prepared read-only worktree for this snapshot no longer existed when this card was verified. Every read went through `git show`/`git grep` against that commit in `$OMNYO_CHECKOUT`. No tests were run, because the snapshot has no `node_modules`.

How the subsystem works today:

- Timeline pages, timeline roots and conversation outlines used to be cached in two tables in the primary SQLite database: `thread_timeline_records` (created by `packages/db/drizzle/0144_timeline_history_cache.sql`) and `thread_conversation_outlines` (created by `packages/db/drizzle/0110_many_kree.sql`).
- On 2026-10-20, commit `4fe384fc10` "Isolate history projection and cache writes from coordinator control work" moved those caches into a separate history-cache database. The commit is in the retired private store at `$ARCHIVED_OMNYO_CHECKOUT`, because the public repository history is squashed into `060950255 "Publish Omnyo source"`. Its server diff removes every server call to `getThreadTimelineRecord`, `putThreadTimelineRecord`, `getThreadConversationOutlineRecord` and `upsertThreadConversationOutlineRecord`. Proven by inspection with `git show 4fe384fc10 -- apps/server/src | grep`.
- On 2026-10-31, commit `4b33c68b22` "Reduce BB cache writes and bound VPS maintenance" removed the last two server calls to `getLatestStoredConversationOutlineSequence`. That function supplied the `outlineSequence` key of the old outline cache. Proven by inspection with the same method.
- The live owner of the cache is `packages/db/src/history-cache.ts`. It provides `openHistoryCache` (line 234), `historyCachePath` (line 222) and `historySourceIdentity` (line 73), and its own table, `history_cache_records` (line 102). The timeline worker and the root-cache reader in `apps/server/src/services/threads/` use it.

The dead code at the snapshot:

| Path and symbol | Lines (physical) |
|---|---|
| `packages/db/src/data/timeline-derived-cache.ts`: `ThreadTimelineRecordInput` (line 9), `ThreadTimelineRecordLimits` (line 18), `recordQuery` (line 24), `getThreadTimelineRecord` (line 41), `putThreadTimelineRecord` (line 48) | 82 (whole file) |
| `packages/db/src/data/thread-conversation-outlines.ts`: `ThreadConversationOutlineRecord` (line 5), `getThreadConversationOutlineRecord` (line 10), `upsertThreadConversationOutlineRecord` (line 26) | 40 (whole file) |
| `packages/db/src/data/events.ts:1884` `GetLatestStoredConversationOutlineSequenceArgs`, plus its trailing blank line | 4 |
| `packages/db/src/data/events.ts:4101-4135` `getLatestStoredConversationOutlineSequence`, plus its trailing blank line | 36 |
| `packages/db/src/data/index.ts:21-25` (outline export block), `:461-467` (timeline-record export block) and `:389` (the `getLatestStoredConversationOutlineSequence` line inside the events export list) | 12 |
| **Total** | **174** |

Counting method: `git show <commit>:<path> | wc -l` for the two files, and `cat -n` line ranges for the rest.

Consumer search (Reproduced):

```sh
git grep -n -E 'getThreadConversationOutlineRecord|upsertThreadConversationOutlineRecord|getThreadTimelineRecord|putThreadTimelineRecord|ThreadTimelineRecordInput|ThreadTimelineRecordLimits|ThreadConversationOutlineRecord|getLatestStoredConversationOutlineSequence|GetLatestStoredConversationOutlineSequenceArgs|timeline-derived-cache|thread-conversation-outlines' e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e
```

The search covered every tracked file, including docs, scripts, `.mjs` and `.mts`. Apart from the definitions and the barrel, it found only these hits:

- `apps/server/test/services/threads/timeline-page-builder.test.ts:20` (import) and `:795` (`putThreadTimelineRecord` used as an "unrelated write" in the test "retains incremental decode across coordinator and unrelated cache writes but rebuilds on a foreign rewrite", line 749).
- `packages/db/test/data/timeline-derived-cache.test.ts` (127 lines, testing only the removed API).
- `packages/db/test/data/timeline-history-storage.test.ts:17-20` (import), `:113-124` (seed write) and `:147-155` (expiry reads), in the test "enforces read-only connections and pure expiry reads without migrating, resizing or creating a database" (line 105).
- `packages/db/test/data/events.test.ts:35` (import) and `:3310-3314` (one assertion).
- `tests/qa/instant-chat-history/service-proof.mts:397`. This is the item the sweeps missed. The file path appears in the `sourcePaths` array. Line 412 and line 829 call `hashFile` (`tests/qa/instant-chat-history/fixture.mts:34`, `createReadStream`) on every path in the array. A deleted file would throw `ENOENT` and abort the proof. Proven by inspection.

Other non-obvious consumers checked:

- **Package surface.** `packages/db/package.json` has `"private": true` and exports only `.` and `./internal-environment-lifecycle`. `packages/db/src/index.ts:52` re-exports `./data/index.js`. No plugin may import `@omnyo/db`: `packages/plugin-sdk/src/testing/__tests__/public-sdk-only.test.ts` enforces that, and it is the only plugin or SDK file that mentions the package. Nothing discovers these files dynamically.
- **Helpers left behind.** The where-helpers `storedConversationOutlineLifecycleWhere`, `storedConversationOutlineCompletedWhere` and `storedConversationOutlineStructuralWhere` (`events.ts:4041-4064`) are still used at lines 4261, 4277 and 4293. The imports `max` (still used at line 3371), `unionAll` (line 4321) and `THREAD_CONTEXT_CLEAR_OPERATION` (lines 5139 and 5330) stay used. `prepareCachedQuery` has many other callers.
- **Raw-SQL users of the tables, which must stay.** These read the tables directly and do not use the API:
  - `apps/server/test/performance/history-stalls-peer.mjs:18`, a raw `INSERT INTO thread_timeline_records` lock-contention peer.
  - `apps/server/test/services/threads/history-worker.test.ts:260-265`, which asserts both tables have zero rows.
  - `apps/server/test/services/threads/timeline-root-cache.test.ts:77`, a zero-row count.
  - `apps/server/test/services/threads/conversation-outline-performance.test.ts:155,247-248`, which asserts no queries hit `thread_conversation_outlines`.
  - `packages/db/test/helpers/rewind.ts:21` and `packages/db/test/migrate.test.ts:301`, which drop the tables for migration replay.
  - `packages/db/src/schema.ts:850` `threadConversationOutlines` and `:870` `threadTimelineRecords`, the declarations drizzle-kit needs so that `db:generate` emits no `DROP TABLE`.

Maintenance cost today: the dead repositories look like a supported, bounded cache API, with eviction SQL, limits types and tests. Changes to timeline caching invite edits to the wrong store, and the dead test file keeps exercising eviction semantics that nothing in production relies on.

**Proposed end state and preservation argument**

What disappears:

- Both repository files.
- `getLatestStoredConversationOutlineSequence` and its Args interface.
- Their barrel exports.
- The test file dedicated to the removed API.
- The removed file's entry in the QA harness source list.

What remains:

- `packages/db/src/history-cache.ts`, the only cache persistence owner.
- Both tables and their schema declarations.
- Migrations 0110 and 0144 and the drizzle journal.
- Every raw-SQL test that asserts the tables stay unused or uses them for lock contention.

Preservation argument:

- **Unchanged behavior.** No production code path reaches the removed functions (Proven by inspection, from the search above). Therefore no HTTP response, timeline cursor, epoch, worker message or UI state changes.
- **Persisted data.** Nothing is migrated, dropped or rewritten. Older databases keep any stale rows they already hold, exactly as today, and thread deletion still cascades.
- **Deliberately kept.** Stale rows are never cleared. That is ISS-S09-02, a separate data decision.

Test obligations, kept distinct:

- **`timeline-page-builder.test.ts:749`.** The test proves that a primary-database write which does not touch events leaves the incremental decode intact, and that a foreign `UPDATE events` forces a rebuild. The replacement must still perform a real primary-database write on the same connection between appends. `upsertHost`, already imported at line 21, writes the `hosts` table and touches neither events nor the thread's history epoch. Retitle "unrelated cache writes" to "unrelated primary writes".
- **`timeline-history-storage.test.ts:105`.** The test proves that a read-only `createConnection` performs no writes, migrations or resizes, and refuses DML and DDL. The expiry-read assertions were the removed API's own contract and go away with it. The read-only obligations are kept by seeding an event with `insertEvents` (already imported at line 15) and reading it through the read-only connection.
- **`events.test.ts:3310-3314`.** This assertion only checks the removed function and is deleted. The surrounding test still asserts `getLatestCompletedThreadContextClearSequence`, which is live.

Non-goals:

- Dropping or clearing the two tables.
- Changing the history-cache database.
- Editing migrations.
- Changing the raw-SQL contention peer.

Remaining uncertainty (Hypothesis, low): an unpublished local branch or an out-of-tree private script that imports these symbols. No supported consumer exists in the tree, and the package is private.

**Expected gain and cost**

| Category | Before | After | Net |
|---|---|---|---|
| Handwritten production lines (`packages/db/src`) | 174 lines in scope | 0 | about -174 (measured baseline; the result is projected) |
| Test lines (`packages/db/test`, `apps/server/test`) | 127-line dedicated file plus about 40 fixture lines | about 20 rewritten fixture lines | about -150 (projected) |
| QA harness (`tests/qa`) | 1 path entry | 0 | -1 |
| Generated code, migrations, schema, docs | none touched | none touched | 0 |
| Cache persistence APIs | 2 (primary-database repositories, plus `openHistoryCache`) | 1 (`openHistoryCache`) | -1 mechanism |

- **No additions to production code.**
- **Performance:** neutral, because the removed code is not on any runtime path. Proven by inspection; nothing was measured.
- **Why maintenance gets easier:** the cache owner becomes unambiguous. Schema changes to timeline caching only need to consider `history-cache.ts`. No test keeps a dead eviction algorithm alive.

**Execution steps**

1. **Reconfirm the baseline.** In a worktree based on current `origin/main`, run the `git grep` search from "Context and evidence" with `HEAD` in place of the commit hash. Also run `rg -n 'thread_timeline_records|thread_conversation_outlines|threadTimelineRecords|threadConversationOutlines' apps packages plugins scripts tests tools`.
   - **Stop and re-plan** if any production file outside `packages/db/src/data/{timeline-derived-cache,thread-conversation-outlines,index,events}.ts` now calls a removed symbol.
   - **Stop and re-plan** if `@omnyo/db` stopped being private, or if a new non-test reader of either table appeared.
2. **Delete the repositories.**
   - Delete `packages/db/src/data/timeline-derived-cache.ts` and `packages/db/src/data/thread-conversation-outlines.ts`.
   - In `packages/db/src/data/index.ts`, remove the export block for `getThreadConversationOutlineRecord` and `upsertThreadConversationOutlineRecord` from `./thread-conversation-outlines.js`, together with its blank separator line.
   - In the same file, remove the export block for `getThreadTimelineRecord`, `putThreadTimelineRecord`, `type ThreadTimelineRecordInput` and `type ThreadTimelineRecordLimits` from `./timeline-derived-cache.js`.
3. **Delete the outline-sequence reader.**
   - In `packages/db/src/data/events.ts`, remove `export interface GetLatestStoredConversationOutlineSequenceArgs` (line 1884) and `export function getLatestStoredConversationOutlineSequence` (lines 4101-4135).
   - Keep the three `storedConversationOutline*Where` helpers and the `max`, `unionAll` and `THREAD_CONTEXT_CLEAR_OPERATION` imports, because each still has other uses.
   - Remove `getLatestStoredConversationOutlineSequence,` from the events export list in `packages/db/src/data/index.ts` (line 389).
   - **Checkpoint:** `pnpm --filter @omnyo/db typecheck` must report errors only in the test files that steps 4 and 5 fix.
4. **Rewrite the `packages/db` tests.**
   - Delete `packages/db/test/data/timeline-derived-cache.test.ts`.
   - In `packages/db/test/data/events.test.ts`, remove the import at line 35 and the `expect(getLatestStoredConversationOutlineSequence(...)).toBe(completedSequence)` assertion at lines 3310-3314. Keep the neighboring `getLatestCompletedThreadContextClearSequence` assertions.
   - In `packages/db/test/data/timeline-history-storage.test.ts`, remove the import at lines 17-20.
   - In the read-only test (line 105), replace the `putThreadTimelineRecord(seeded, ...)` seed (lines 113-124) with one `insertEvents(seeded, noopNotifier, [{ threadId: thread.id, sequence: 1, type: "system/manager/user_message", scope: threadScope(), itemId: null, itemKind: null, parentToolCallId: null, data: JSON.stringify({ text: "opaque redacted body" }) }])`. The shape mirrors the `append` helper at lines 56-68 of the same file.
   - Read `initialEpoch` after the seed, as the test does today.
   - Replace the three expiry reads (lines 147-155) with one read through the read-only connection: `SELECT count(*) AS count FROM events` (or `listEvents(reader, { threadId: thread.id })` imported from `../../src/data/events.js`) returning one row.
   - Change the `thread_timeline_records` count (lines 157-160) and the `DELETE FROM thread_timeline_records` refusal (line 165) to target `events`.
   - Keep every other assertion unchanged: `readonly`, `cache_size`, `mmap_size`, epoch equality, `total_changes() = 0`, `CREATE TABLE` refusal, missing-file refusal, digest equality and the size bound.
   - Retitle the test "enforces read-only connections without migrating, resizing or creating a database".
5. **Rewrite the server fixture.** In `apps/server/test/services/threads/timeline-page-builder.test.ts`:
   - Remove `putThreadTimelineRecord,` from the `@omnyo/db` import (line 20).
   - Replace the call at lines 795-806 with `upsertHost(db, noopNotifier, { name: \`unrelated-host-${index}\` });`.
   - Rename the test at line 749 from "…coordinator and unrelated cache writes…" to "…coordinator and unrelated primary writes…".
   - Leave the oracle comparison, the `decodedEventCount < 10` assertion and the foreign-rewrite half untouched.
6. **Update the QA harness.** In `tests/qa/instant-chat-history/service-proof.mts`, delete the `"packages/db/src/data/timeline-derived-cache.ts",` entry (line 397) from `sourcePaths`. Skip this step if RF-019 has already removed the directory.
7. **Final checks.**
   - Rerun the step 1 symbol search. Only zero hits for the removed symbol names count as passing.
   - Format and lint only the changed files (see Verification).
   - Inspect `git diff --stat` for unrelated changes.
   - Recount the removed lines with `git diff --numstat` against the baseline commit, reporting `packages/db/src`, the test files and `tests/qa` separately.

**Verification and acceptance criteria**

The `pnpm test --package` form comes from `scripts/test-modes.mjs` (usage text at lines 17-18). The `typecheck` and `test` scripts exist in `packages/db/package.json` and `apps/server/package.json`. None of these commands could be run at the snapshot, because it has no `node_modules`.

Run from the repository root:

```sh
pnpm --filter @omnyo/db typecheck
pnpm --filter @omnyo/server typecheck
pnpm test --package @omnyo/db -- test/data/timeline-history-storage.test.ts test/data/events.test.ts
pnpm test --package @omnyo/server -- test/services/threads/timeline-page-builder.test.ts test/services/threads/history-worker.test.ts test/services/threads/timeline-root-cache.test.ts test/services/threads/conversation-outline-performance.test.ts
pnpm exec oxfmt <changed files>
pnpm exec oxlint --deny-warnings --format=agent <changed files>
```

Acceptance criteria:

- **Behavior and contract:**
  - Both typechecks pass.
  - The read-only test still proves zero writes, refusal of DML and DDL, an unchanged file digest and no creation of a missing database.
  - The page-builder test still shows `decodedEventCount < 10` after the unrelated primary writes, matches the oracle response, and rebuilds (more than 100 decoded events) after the foreign rewrite.
  - The history-worker and root-cache tests still find zero rows in both dormant tables.
  - The outline-performance test still finds no queries against `thread_conversation_outlines`.
- **Schema:** `git diff` shows no change under `packages/db/drizzle/` and none in `packages/db/src/schema.ts`. Optionally, run `pnpm --dir packages/db db:generate` in a disposable worktree. It must report no schema changes and must not emit a new migration; delete any file it creates in that disposable worktree.
- **Structure:**
  - `git grep` for the nine removed symbol names and the two module names returns nothing.
  - `history-cache.ts` is the only cache persistence module.
  - `history-stalls-peer.mjs` and the raw-SQL table assertions are unchanged.
- **Performance:** no benchmark is required, because no runtime path changes.
- **UI:** not applicable.

**Rollback and stop conditions**

- **Rollback:** the change is one commit that touches only TypeScript source, tests and one QA path list. Reverting it restores everything, and there are no data or compatibility implications, because tables and migrations are untouched.
- **Stop conditions:**
  - A production or script caller of any removed symbol appears in step 1.
  - `@omnyo/db` gains an external or published consumer.
  - drizzle-kit reports schema drift after the change, which would mean something else was edited.
  - The page-builder test's incremental-decode assertion fails with `upsertHost` in place of the old write. That would mean the decode invalidation is sensitive to which table is written, which deserves its own investigation (see RF-051) before choosing another fixture. The fallback is a raw `db.$client.prepare("INSERT INTO thread_timeline_records ...")` matching `history-stalls-peer.mjs:18`, which keeps the old write's exact table without keeping the API.
- **Smaller alternative:** delete only the two repository files and their barrel exports, and leave `getLatestStoredConversationOutlineSequence` for a later pass.
