# RF-202 — Remove the superseded primary-database history cache APIs

## Rank and disposition

- **Potential** Moderate, small and unusually well bounded. Server-lane impact rank 4, execution order 1.
- **Confidence/readiness** High. Verified removable within the inspected private-workspace support scope, subject to the caller recheck below.
- **Effort/risk** Small, approximately 0.25–0.5 day including focused checks. Low risk if schema/migration history and independent contention coverage remain.
- **Dependencies** None. Does not overlap current separate-history-cache implementation or provider plans.

## Context and evidence

Snapshot `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. Two private `@omnyo/db` repositories remain: `src/data/timeline-derived-cache.ts` (82 physical lines) exposes `getThreadTimelineRecord`/`putThreadTimelineRecord`. `src/data/thread-conversation-outlines.ts` (40 lines) exposes `getThreadConversationOutlineRecord`/`upsertThreadConversationOutlineRecord`. `src/data/index.ts` exports their functions/types through the DB entry point.

The decisive symbol search was:

```sh
rg -n 'getThreadTimelineRecord|putThreadTimelineRecord|getThreadConversationOutlineRecord|upsertThreadConversationOutlineRecord' apps packages plugins scripts
```

Hits are declarations, barrel exports, `packages/db/test/data/timeline-derived-cache.test.ts`, `timeline-history-storage.test.ts`, and the unrelated-write fixture in `apps/server/test/services/threads/timeline-page-builder.test.ts`. No production caller was found in that scope. A separate table-name/schema search found the historical migrations and declarations, which are not deletion candidates.

The supported implementation is different: `packages/db/src/history-cache.ts::openHistoryCache/historyCachePath`. `apps/server/src/services/threads/timeline-worker.ts` opens it beside the primary DB. `history-cache-access.ts::attachHistoryCacheReader/readHistoryCache` binds it to a reader. `timeline-root-cache.ts::loadCompletedRootProjection` consumes that binding. It has a separate persistence owner and storage contract.

Counterevidence: `timeline-history-storage.test.ts` tests epoch/history persistence as well as an old-cache fixture, and `timeline-page-builder.test.ts` deliberately changes the primary database during history reads. Keep those distinct obligations. The SQL tables, `schema.ts` declarations and applied migrations must remain: removing unused access APIs does not prove that table removal or migration-history rewriting is safe. `@omnyo/db` is private in its manifest. No published external DB API was established. Recheck supported downstream private consumers before removal.

## Proposed end state and preservation argument

Delete only the two repository implementations and their barrel exports/types. Keep current `HistoryCache`, its worker/read bindings, all SQL schema/migration declarations and persisted content. Replace tests that use the old cache only as an unrelated primary write with a harmless real write to an existing primary table owned by that fixture. Preserve actual primary-database contention/read-only/invalidation tests. Delete tests whose sole subject is the removed API. Do not move them to test an unrelated implementation with different semantics.

Reachability proof: both files have no top-level registration side effect. They export explicit functions/types. Package exports expose the private DB entry point, which has no dynamic discovery mechanism. The symbol and table searches cover first-party apps/packages/plugins/scripts. Production history consumers reach the separate cache. Stop if that support boundary changes. No user-visible response, timeline cursor/epoch semantics, cache expiry, data migration or UI change is intended.

## Expected gain and cost

Measured baseline is **122 physical production lines in the two files**, plus small barrel lists. Projected removal: 122–130 production lines. Projected additions: 0 production lines. **122–130 net lines removed**. Test fixture replacements may add 5–15 lines. Count dedicated old-API test deletion separately from production savings. No schema/config/generated code savings are claimed. Maintained persistence APIs fall from two obsolete repository modules plus the current cache to the current cache alone. No runtime speedup is expected: the removed functions are not on the inspected production path.

## Execution steps

1. Re-run function/type and table-name searches across tracked files, package exports, scripts and relevant hidden configuration. Inspect any new caller or dynamic path before removal. Reconfirm the private support boundary.
2. Read `timeline-history-storage.test.ts` and `timeline-page-builder.test.ts` assertions around the old writes. Choose a fixture-owned primary row update already independent of timeline content. Capture the intended lock/invalidation behavior before replacing it. Do not make primary DB writes disappear from those cases.
3. Replace only those fixtures. Delete the old repository-only test and remove its imports. Preserve unrelated epoch/history assertions.
4. Remove the two source modules and their function/type exports in `packages/db/src/data/index.ts`. Remove comments/doc references that imply the primary API is current. Keep historical SQL/schema symbols untouched.
5. Run the targeted checks below, repeat both symbol searches and inspect the full diff. Report production/test changes separately and confirm no migration generated.

## Verification and acceptance

From the repository root with the existing dependency setup:

```sh
pnpm --filter @omnyo/db test test/data/timeline-history-storage.test.ts test/history-cache.test.ts test/data/timeline-history-epoch.test.ts
pnpm --filter @omnyo/server test test/services/threads/timeline-page-builder.test.ts test/services/threads/timeline-root-cache.test.ts test/services/threads/history-worker.test.ts test/services/threads/history-stall-regression.test.ts
pnpm --filter @omnyo/db typecheck
pnpm --filter @omnyo/server typecheck
```

Supported commands and named test files were inspected. **None ran** because audit dependencies are absent and installation is excluded. Existing tests must still prove primary read-only history, primary writes during projection, current separate-cache expiry/budget/identity behavior and epoch/rewrite invalidation. Broad performance/real transcript benchmarks are not a prerequisite for deleting an unreachable API. Run an existing contention fixture only if fixture replacement changes what it establishes. No screenshot work is necessary for this source/API removal. Timeline response assertions are the affected observable contract.

Structural acceptance: no old function/type export or caller remains, SQL tables and migration history remain unchanged, the separate cache remains the sole production history persistence API, and actual production deletion meets the estimate basis.

## Rollback and stop conditions

The change is source/test only and requires no data conversion. Restore only its removed files/exports and fixture edits if needed. Stop for a supported external/private consumer, a discovered runtime string/dynamic import, or a test with an essential dependency on old API semantics. Retain that proven consumer until a separately scoped migration exists. Do not delete tables to force this plan through.
