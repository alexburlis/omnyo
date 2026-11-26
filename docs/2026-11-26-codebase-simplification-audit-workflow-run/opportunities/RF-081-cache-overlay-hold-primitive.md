# RF-081 — One "server fetch landed for thread data" predicate and one per-QueryClient hold registry for the optimistic thread overlays

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real (Proven by inspection), but the sweep's proposed end state needs three corrections, listed below, to keep today's behavior.
- **Potential:** low. About 35 to 55 handwritten production lines disappear. Three copies of one predicate become one, and two copies of a per-QueryClient registry lifecycle become one.
- **Confidence:** high that the duplication exists as described. The line gain is a projection with medium confidence.
- **Readiness:** ready once the characterization test in step 2 exists. No owner decision is needed, because no feature, API or persisted format changes.
- **Effort:** about half a day to one day, including the missing characterization test.
- **Risk:** medium. This code protects optimistic pin, rename, shelve, archive, unarchive and answer state against server fetches that started before the mutation. A slip shows up as a flicker or as a revived stale archive or restore.
- **Prerequisites:** none. Step 2 adds one missing regression test before any edit.
- **Related or overlapping:** RF-080 ("Merge the two identity-map thread-list projection and rollback helpers") edits `projectCachedThreadListEntries` and `restoreCachedThreadListEntries` in the same file as `holdThreadListProjection`. The two changes touch disjoint symbols, so they can land in either order. Land them as separate commits so each one can be reverted alone. RF-052 ("Define the composer optimistic thread-status protocol once") is a likely future consumer of the same predicate, but it is not a prerequisite.
- **Corrections to the sweep proposal:**
  1. Do not share one QueryCache subscription across the three overlays. Sharing would impose a new fixed order between patch, membership and answer re-application. Keep one subscription per overlay, as today.
  2. The membership registry is not a plain set of holds. A newer hold for a thread supersedes the older hold for that thread, and releasing the newer hold does not revive the older one. Two existing tests encode this rule. A generic "set of holds" registry must keep it explicitly.
  3. Keep the answer projection's per-hold subscription. Only its copy of the predicate moves to the shared module.
- **Why it deserves its place:** a small but real state-coordination consolidation. The knowledge "which server fetches can overwrite thread-list or thread-detail overlays" lives in three places today. It belongs once, beside the write-side helpers that already define where `ThreadListEntry` data is cached. It ranks low because the net reduction is small and the code is race-sensitive.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The three files have no diff between that commit and the local `HEAD` checked during this audit. They were last changed on 2026-11-25 in commit `be3756d84` ("Make sidebar chat state update immediately"), which created `pending-thread-membership.ts` from the former `pending-thread-archives.ts`.

The web app (`apps/app`) uses TanStack Query (`@tanstack/react-query` ^5.62.0). When the user pins, renames, shelves, archives, unarchives or answers a question, the app writes the predicted result into cached queries at once. A server fetch that started before the mutation can then land and overwrite that prediction. Each optimistic owner therefore "holds" its overlay. It listens to the QueryCache and re-applies the overlay whenever a non-manual successful fetch lands for a query that holds thread data. `setQueryData` dispatches `success` with `manual: true`, so an overlay's own re-application does not trigger itself again.

There are three copies of this mechanism (Proven by inspection):

1. `apps/app/src/hooks/cache-owners/pending-thread-patches.ts`
   - Lines 31-40: `PendingThreadPatchHold`, `PendingThreadPatchRegistry` and `const registries = new WeakMap<QueryClient, PendingThreadPatchRegistry>()`.
   - Lines 108-116: `isFetchedQueryData(event)`, which checks `type === "updated"`, `action.type === "success"` and `!action.manual`.
   - Lines 118-126: `holdsThreadData(query, patches)`, which matches the `threadsQueryKey()` prefix, the exact `sidebarNavigationQueryKey()`, or the exact `threadQueryKey(id)` of any held id.
   - Lines 128-162: `holdPendingThreadPatches`. It creates the registry and one QueryCache subscription lazily. On each fetch it calls `mergeHeldPatches(holds)` (lines 94-106), which merges patch fields from every hold, and then `applyThreadPatches`. It unsubscribes when the last hold is released.
   - Semantics: holds are additive. Two holds on the same thread contribute different fields, and releasing one keeps the other's fields held.
2. `apps/app/src/hooks/cache-owners/pending-thread-membership.ts`
   - Lines 20-30: `PendingMembershipOwner { token, membership }`, `PendingMembershipRegistry` and a second `WeakMap<QueryClient, …>`.
   - Lines 106-164: `holdPendingThreadMembership`. Lines 118-137 inline a copy of the same predicate. Lines 148-149 store memberships in `Map<threadId, { token, membership }>`, so the newest hold for a thread overwrites the older one. Lines 152-155 make release delete only the entries whose token matches. Lines 157-162 unsubscribe when the map is empty.
   - Semantics: the newest hold wins for each thread, and the superseded hold is never revived. The tests in `apps/app/src/hooks/cache-owners/pending-thread-archives.test.ts` lines 458-564 ("overlapping thread membership": "keeps Undo newer than an archive without reviving the superseded archive hold" and "keeps a new archive newer than an unarchive without reviving the superseded restore hold") encode this rule.
   - Exports: `holdPendingThreadArchives` (line 166) and `holdPendingThreadUnarchives` (line 183).
3. `apps/app/src/hooks/cache-owners/thread-answer-cache-owner.ts`
   - Lines 181-194: `isFetchedThreadListData(event)`, a third copy of the predicate. It watches the thread lists and the sidebar navigation only, without thread detail. This narrower scope is correct, because the answer projection never writes `threadQueryKey` data.
   - Lines 270-303: `holdThreadListProjection`. It opens one QueryCache subscription per hold (lines 281-284) and keeps per-hold `originals` for `rollback` (lines 296-301).
   - Callers: `beginResolvedThreadQuestionTransaction` (line 318) and `beginResolvedThreadInteractionTransaction` (line 382), both in the same file.

Callers of the first two overlays are all in `apps/app/src/hooks/cache-owners/thread-state-cache-owner.ts`:

- `holdPendingThreadPatches` at lines 350 (`beginHeldThreadPatchTransaction`, used by pin, rename, shelve and the other single-thread metadata transactions) and 669 (`beginThreadMetadataBatchTransaction`).
- `holdPendingThreadUnarchives` at line 869 (`beginUnarchiveThreadTransaction`).
- `holdPendingThreadArchives` at line 987 (the archive-family transaction).

Search for consumers: `git grep -n -E 'holdPendingThreadPatches|holdPendingThreadArchives|holdPendingThreadUnarchives|holdThreadListProjection|applyThreadPatches|pending-thread-patches|pending-thread-membership' e9e1b74c3 -- .`. It found only the files above and `pending-thread-archives.test.ts`. All these symbols are internal to `apps/app`. No SDK, plugin SDK, plugin, CLI, desktop, mobile or persisted-data consumer exists, because these are in-memory query-cache overlays.

Other QueryCache subscribers exist (search: `git grep -n -E 'action\.manual|getQueryCache\(\)\.subscribe' e9e1b74c3 -- apps packages plugins`). Each was inspected and none is a thread-data overlay hold, so none is in scope:

- `inbox-snapshot-cache-owner.ts:137` retires Inbox predictions on the Inbox snapshot hash.
- `thread-open-snapshots.ts:353` schedules snapshot writes for timeline and bootstrap queries.
- `sidebar-navigation-query.ts:73`, `useSenderThreadMetadataById.ts:213`, `thread-open-cache-owner.ts:284`, `realtime-cache-registry.ts:281`, `snapshot-invalidation.ts:64`, `useActiveThreadPreloading.ts:350`, `usePredictedSendWait.ts:21`, `system-queries.ts:270`, `ThreadTitleMentions.tsx:926` and `web-error-reporting.ts:478` serve other purposes.

Measured lines of machinery, Reproduced with `git show e9e1b74c3:<path> | sed -n '<ranges>p' | wc -l`:

| File | Ranges | Lines |
|---|---|---|
| `pending-thread-patches.ts` | 31-40, 108-162 | 65 |
| `pending-thread-membership.ts` | 20-30, 106-164 | 70 |
| `thread-answer-cache-owner.ts` | 181-194, 281-292 | 26 |
| Total | | 161 |

Test coverage today (Proven by inspection; the snapshot has no `node_modules`, so no test was run):

- Membership: `pending-thread-archives.test.ts` (564 lines) covers stale list and detail fetches, independent holds, settlement refetches, rejected restores and the supersession rule.
- Answer projection: `thread-answer-cache-owner.test.ts` lines 128-196 cover "re-applies to stale fetched sidebar data until released" and rollback after a stale refetch. Lines 391-449 cover interaction resolution.
- Patches: **no test re-applies a held metadata patch across a stale server fetch.** The search covered every `apps/app` test file that both calls a patch transaction (`beginPinThreadTransaction`, `beginThreadMetadataBatchTransaction`, `beginThreadShelfTransaction`, `releasePendingPatches`) and triggers a fetch (`fetchQuery`, `refetchQueries`, `invalidateQueries`). Only `thread-lifecycle-cache.test.ts` matched, and its patch cases (lines 288-420) test rollback without a refetch. A test in another style or another directory would show otherwise, and that broader check did not run.

Maintenance cost today: an overlay that should also react to a new query holding `ThreadListEntry` data must change three predicates. Another hold owner, for example a future composer status overlay, would copy the registry lifecycle a third time. The write side already has one owner for "where thread list data lives": `applyToCachedThreadListsAndSidebarNavigation` in `apps/app/src/hooks/cache-owners/query-cache.ts` line 325 covers the `threadsQueryKey()` prefix and the sidebar navigation. The read-side predicate is the duplicated half.

**Proposed end state and preservation argument**

Add one module, `apps/app/src/hooks/cache-owners/thread-cache-holds.ts`, with two exports:

```ts
// True for a non-manual successful fetch of a thread list, the sidebar
// navigation, or (when listed) the exact thread detail of one of detailThreadIds.
export function isServerThreadDataFetch(
  event: QueryCacheNotifyEvent,
  detailThreadIds: Iterable<string> = [],
): boolean;

// One lazily created QueryCache subscription per QueryClient for this overlay.
// The subscription is removed when the last hold is released.
export function createThreadCacheHoldRegistry<Hold>(overlay: {
  detailThreadIds?: (holds: ReadonlySet<Hold>) => Iterable<string>;
  reapply: (queryClient: QueryClient, holds: ReadonlySet<Hold>) => void;
  onHold?: (hold: Hold, holds: ReadonlySet<Hold>) => void;
}): (queryClient: QueryClient, hold: Hold) => () => void;
```

The overlays then use it as follows:

- **Patches.** `pending-thread-patches.ts` keeps `ThreadMetadataPatch`, `isPatchApplied`, `patchThreadList`, `applyThreadPatches` and `mergeHeldPatches`. `holdPendingThreadPatches(queryClient, patches)` becomes a call to a module-level `createThreadCacheHoldRegistry<ThreadPatches>` instance:
  - `detailThreadIds` yields the keys of every held map.
  - `reapply` calls `applyThreadPatches(queryClient, mergeHeldPatches(holds))`.
  - The registry wraps each `patches` value in a fresh object (for example `{ patches }`), so the same Map can be held twice, as today.
  - `isFetchedQueryData`, `holdsThreadData`, `PendingThreadPatchRegistry` and the `registries` WeakMap disappear.
- **Membership.** `pending-thread-membership.ts` represents each hold as `{ claims: Map<threadId, PendingMembership> }`.
  - `onHold` keeps the supersession rule: when a new hold is added, it deletes the new hold's thread ids from every older hold's `claims`. This matches today's `pending.set(threadId, { token, membership })` override and the token-checked release.
  - `reapply` builds the merged view by iterating holds in insertion order and passes it to the existing `applyPendingMembership` body. Only the body's input type changes from `Map<string, PendingMembershipOwner>` to the merged claims.
  - `detailThreadIds` yields the remaining claim keys.
  - `PendingMembershipOwner`, `PendingMembershipRegistry`, the WeakMap, the inline predicate and the token handling disappear.
  - The early return `if (memberships.length === 0) return () => {}` stays.
- **Answer projection.** `thread-answer-cache-owner.ts` deletes `isFetchedThreadListData`. `holdThreadListProjection` keeps its own per-hold subscription and its `originals` and `rollback`, but its listener calls `isServerThreadDataFetch(event)` with no detail ids. That keeps today's narrower scope.

Why this preserves behavior:

- The predicate is the same expression in all three places. The only parameter is the detail thread ids, which the answer projection omits and the other two supply.
- Each overlay keeps its own subscription, so the relative order of patch, membership and answer re-application stays the QueryCache listener insertion order, exactly as today.
- Additive patch merging, newest-wins membership with no revival, and per-hold answer rollback all stay with their owners. Only the shared lifecycle moves.
- Release stays idempotent. A second release call, or a release after the registry was torn down and recreated, does nothing.
- One small, harmless difference remains. With the `onHold` approach, a membership hold whose claims were all superseded stays in the registry set until it is released, so the subscription can outlive its last effective claim by that hold's lifetime. Its `reapply` then has nothing to apply. To avoid even that, `onHold` can drop a superseded hold whose `claims` became empty, but the release function must still be safe to call afterwards.

Non-goals:

- Merging the three overlays into one overlay or one subscription.
- Changing which queries are cancelled before a hold (`cancelThreadListReads`, and the `cancelQueries` calls in `thread-state-cache-owner.ts`).
- Changing the Inbox prediction (`predictInboxSnapshot`) or `settlingWith`.
- The identity-map projection helpers, which RF-080 owns.

**Expected gain and cost**

- Before: 161 lines of hold machinery across three files, with three predicate copies and two registry lifecycles (Reproduced count).
- After (projection): about 15 lines left in patches, 25 to 30 in membership and 12 in the answer projection, plus a new module of about 45 to 55 lines. Net reduction of about 35 to 55 handwritten production lines.
- The new characterization test adds about 40 to 60 test lines. That is intended coverage, not a cost to minimise.
- Mechanisms: the predicate goes from 3 copies to 1, and the per-QueryClient registry lifecycle goes from 2 copies to 1.
- Maintenance link: a new query that holds thread-list data, or a new overlay owner, changes one predicate or reuses one registry instead of editing two or three files in step.
- Performance: neutral to slightly positive (Hypothesis, unmeasured). Patches would stop calling `mergeHeldPatches` on every non-manual success event for any query and would merge only when the event matches. The number of listeners stays the same, because each overlay keeps one subscription.

**Execution steps**

1. **Reconfirm the snapshot.** In the working checkout, run `git diff e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- apps/app/src/hooks/cache-owners/pending-thread-patches.ts apps/app/src/hooks/cache-owners/pending-thread-membership.ts apps/app/src/hooks/cache-owners/thread-answer-cache-owner.ts apps/app/src/hooks/cache-owners/thread-state-cache-owner.ts`. Re-run the consumer `git grep` from Context. Re-plan if any of these hold:
   - A new overlay already shares or replaces one of these registries.
   - The supersession tests changed meaning.
   - RF-080 moved `holdThreadListProjection`. In that case, apply the answer-projection edit wherever it now lives.
2. **Add the missing patch characterization test before any refactor.** In `apps/app/src/hooks/cache-owners/thread-lifecycle-cache.test.ts`, or in a new `pending-thread-patches.test.ts` beside it, add these cases:
   - (a) Begin `beginPinThreadTransaction` (or a rename through `beginHeldThreadPatchTransaction`'s public entry), then finish a `fetchQuery` on `sidebarNavigationQueryKey()` that returns the unpinned entry. Expect `pinnedAt` and `pinSortKey` still applied. Call `releasePendingPatches()`, refetch, and expect the server value.
   - (b) The same with a `threadQueryKey(id)` fetch. Expect the detail `title` (or another non-sort-key field) held. Also confirm that `pinSortKey` and `shelfSortKey` are not written to detail, because `applyThreadPatches` strips them at lines 76-79.
   - (c) Two overlapping holds on one thread with different fields. Release one and expect the other's field still held after a stale fetch.
   - Run it against the unchanged code and confirm it passes. That run is the baseline.
3. **Add `thread-cache-holds.ts`** with `isServerThreadDataFetch` and `createThreadCacheHoldRegistry`, using the signatures above.
   - Copy the predicate exactly: `event.type === "updated" && event.action.type === "success" && !event.action.manual`, followed by `matchQuery({ queryKey: threadsQueryKey() }, query) || matchQuery({ queryKey: sidebarNavigationQueryKey(), exact: true }, query) || <exact threadQueryKey(id) for any id>`.
   - Registry: hold a `WeakMap<QueryClient, { holds: Set<Hold>; unsubscribe }>` inside the closure. On the first hold, subscribe with `if (isServerThreadDataFetch(event, overlay.detailThreadIds?.(holds) ?? [])) overlay.reapply(queryClient, holds)`. On add, call `onHold`, then `holds.add`. Release deletes the hold. When `holds.size === 0`, it unsubscribes and deletes the WeakMap entry only if the entry is still this registry, mirroring `pending-thread-membership.ts` lines 157-162.
   - Checkpoint: run `typecheck` for `@omnyo/app`.
4. **Convert `pending-thread-patches.ts`.** Replace lines 31-40 and 108-162 with the registry instance and a `holdPendingThreadPatches` wrapper that keeps its exported signature `(queryClient, patches: ReadonlyMap<string, ThreadMetadataPatch>) => () => void`. Callers in `thread-state-cache-owner.ts` do not change. Checkpoint: the step 2 test and `thread-lifecycle-cache.test.ts` pass.
5. **Convert `pending-thread-membership.ts`.** Change `holdPendingThreadMembership` to build a `{ claims }` hold and use the registry with `onHold` supersession. Adapt `applyPendingMembership` to take the merged claims. Keep `holdPendingThreadArchives` and `holdPendingThreadUnarchives` signatures unchanged. Checkpoint: all of `pending-thread-archives.test.ts` passes, especially lines 458-564, plus `thread-status-races.test.ts` and `palette-archive-cache.test.ts`.
6. **Convert `thread-answer-cache-owner.ts`.** Delete `isFetchedThreadListData` (lines 181-194) and call `isServerThreadDataFetch(event)` at line 282. Remove the now-unused `Query` and `QueryCacheNotifyEvent` imports only if nothing else in the file uses them. `QueryCacheNotifyEvent` is still used at line 414. Checkpoint: `thread-answer-cache-owner.test.ts` passes.
7. **Clean up.** Remove unused imports (`matchQuery`, `Query`, `QueryCacheNotifyEvent`, the query-key imports) from the converted files. Inspect the full diff for leftover registries or predicates: `git grep -n -E 'action\.manual' -- apps/app/src/hooks/cache-owners` should list only `thread-cache-holds.ts`, `inbox-snapshot-cache-owner.ts`, `thread-open-snapshots.ts` and the interaction watcher at `thread-answer-cache-owner.ts` around line 428, which checks a different query and stays. Recount with `wc -l` against the 161-line baseline.

**Verification and acceptance criteria**

Commands (scripts confirmed in `apps/app/package.json` at the snapshot: `test` is `vitest run --config vitest.config.ts`, `typecheck` is `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`, `lint` is `oxlint src …`; the package name is `@omnyo/app`; the root `package.json` has `format:check` as `oxfmt . --check`). None of these were run during this audit, because the snapshot has no `node_modules`.

- From the repository root:
  `pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/hooks/cache-owners/pending-thread-archives.test.ts src/hooks/cache-owners/thread-answer-cache-owner.test.ts src/hooks/cache-owners/thread-lifecycle-cache.test.ts src/hooks/cache-owners/thread-status-races.test.ts src/hooks/cache-owners/palette-archive-cache.test.ts src/hooks/cache-owners/thread-state-cache-owner.test.ts`, plus the new patch test file if step 2 created one.
  Expected result: all pass, with no assertion edited except the new test added in step 2.
- From the repository root: `pnpm --filter @omnyo/app typecheck` and `pnpm --filter @omnyo/app lint`.
- Format the changed files with `pnpm exec oxfmt <changed files>` and check them with `pnpm exec oxfmt --check <changed files>`.

Behavior that must hold:

- A held pin, rename or shelve patch survives stale fetches of the thread lists, the sidebar navigation and the held thread's detail. Releasing the hold lets the next fetch win.
- An archive hold keeps a family hidden through stale list and detail reads. An unarchive hold keeps the restored row visible.
- A newer membership hold supersedes an older one for the same thread. Releasing the newer hold does not revive the older hold.
- The answer projection re-applies only on list and sidebar fetches. Rollback restores the original entries even after a stale refetch.
- The step 2 test passes before and after the change. It is the independent baseline; do not rewrite it to match the new code.

Visual and interaction checks:

- These overlays have no UI of their own. Alex tests UI changes himself; a quick manual check is optional and is not a completion gate. To run one, pin a chat, rename a chat, archive and Undo, and answer a question while the sidebar refetches; no row should flicker.

Performance:

- No credible baseline exists, and none is needed for a change that keeps the number of listeners and the work per matching event the same. Do not claim a speedup.

Structural completion:

- Exactly one copy of the thread-data fetch predicate exists, in `thread-cache-holds.ts`.
- Exactly one `WeakMap<QueryClient, …>` hold registry implementation exists.
- `pending-thread-patches.ts` and `pending-thread-membership.ts` contain only their overlay logic.

**Rollback and stop conditions**

- Rollback: each converted file is an independent commit-sized change with no persisted data or API impact. Reverting the commit restores the old behavior. The new test from step 2 stays either way.
- Stop if `pending-thread-archives.test.ts` lines 458-564 cannot pass without special-casing supersession inside the generic registry beyond `onHold`. In that case, convert only the predicate (`isServerThreadDataFetch`) in all three files and the registry in patches only. That smaller change still removes the duplicated predicate knowledge, for about 25 to 30 net lines.
- Stop if a test shows the overlays depend on a specific relative order of re-application between patches and membership on the same event. For example, an unarchive re-inserting an entry that a held patch must then decorate. Record the order as a separate issue rather than fixing it inside this refactor, because today's order already depends on which registry was created first.
- Stop if a new consumer outside `apps/app/src/hooks/cache-owners` imports these hold functions by the time of execution. Re-plan its signature needs first.
