# RF-080 — Merge the two identity-map thread-list projection and rollback helpers into one pair in `thread-list-optimism.ts`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and the merge is safe, but the sweep's plan needed two corrections. First, the merged helper must keep recording unchanged entries (identity pairs), because two runtime-owner rollbacks apply a `project` function to every recorded entry. Second, the sweep's claim that the unchanged-list short-circuit avoids re-renders is wrong, because TanStack structural sharing already keeps unchanged references.
- **Potential:** medium. One of two parallel rollback mechanisms disappears from the optimistic-UI hot path. Today the two copies have already drifted in four small ways.
- **Confidence:** high. Every claim below is proven by inspection at the snapshot. No test was run.
- **Readiness:** ready. No product decision is needed.
- **Effort:** small, about two to four hours including the focused tests.
- **Risk:** low to medium. The code drives optimistic sidebar and thread-list state for sends, queueing, stopping, answers and continuation. A semantic slip would show up as a sidebar row that does not roll back, or one that rolls back over newer server data. Existing owner tests cover the main paths.
- **Prerequisites:** none.
- **Related and overlapping:** RF-081 ("One hold-and-reapply primitive for optimistic overlays across server refetches") would build on the merged helper: `holdThreadListProjection` is its natural core, and RF-080 should land first. RF-052 ("Define the composer optimistic thread-status protocol once") touches the same `thread-runtime-cache-owner.ts` call sites. Land RF-080 before RF-052 or rebase RF-052 onto it. The whole-list snapshot rollback in `thread-list-cache-data.ts` "restoreCachedThreadLists" is a third, different rollback style (it restores removed rows) and is out of scope.
- **Why it deserves its place:** owners pick one of the two helpers arbitrarily. `thread-continuation-cache-owner.ts` imports the answer owner's pair even though it never chains, while the outbox owner imports the other pair. Each future fix to identity rollback (duplicate rows, a new cached list surface, short-circuiting) currently has to be made twice or silently diverges.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The two helper files are unchanged between that commit and local `main` at `5f2d3f895` (checked with `git diff --stat e9e1b74c3 5f2d3f895 -- <file>`, which printed nothing).

*Subsystem.* The React app (`apps/app`) shows a chat's state in several TanStack Query caches: every cached thread list under `threadsQueryKey()`, including plain arrays and infinite pages, and the sidebar navigation bootstrap under `sidebarNavigationQueryKey()`. When the user sends, queues, stops, answers or continues, cache owners optimistically rewrite that thread's entry in all of those caches. If the request fails, they must undo only their own change and keep any newer server data. Both helpers solve this the same way. They apply a per-thread projection through `apps/app/src/hooks/cache-owners/query-cache.ts:325` "applyToCachedThreadListsAndSidebarNavigation", re-read the cache, and return a `Map<storedProjectedEntry, originalEntry>`. Rollback then maps every list entry through that map by object identity, so an entry the server has since replaced is no longer in the map and survives.

*Copy A* (Proven by inspection): `apps/app/src/hooks/cache-owners/thread-list-optimism.ts`, 76 lines (64 non-blank).
- `:13` "applyOptimisticThreadListState"(queryClient, threadId, update) snapshots the first matching entry per list (matched by `queryKey` reference) and the sidebar entry. It always remaps every list, then records `after → before` whenever both exist, including unchanged entries.
- `:64` "restoreOptimisticThreadLists"(queryClient, rollback, project = identity) remaps every list and replaces each recorded entry with `project(previous)`.
- Consumers: `thread-runtime-cache-owner.ts` has six apply sites (`:541`, `:859`, `:1043`, `:1101`, `:1809`, `:1946`) and eight restore sites (`:1373`, `:1396`, `:1460`, `:1575`, `:1996`, `:2058`, `:2314`, `:2497`). `outbox-thread-state-cache-owner.ts` has one of each (`:103`, `:202`). The restores at `:1373` (queued-message failure: recompute `queuedWork`) and `:1460` (an accepted turn that came back queued: set `queuedWork: "waiting"`) pass `project`.

*Copy B* (Proven by inspection): `apps/app/src/hooks/cache-owners/thread-answer-cache-owner.ts:196-268`, 73 lines (56 non-blank).
- `:196` "cachedThreadEntries" keys entries by `hashKey(queryKey)`. It keeps the last match per list and adds the sidebar under `hashKey(sidebarNavigationQueryKey())`.
- `:218` "projectCachedThreadListEntries"(queryClient, threadId, project, originals = new Map()) returns the unchanged list when the projection changes nothing. It records `stored → originals.get(previous) ?? previous` only when `previous !== stored`. That chaining lets a re-projection after a refetch still map back to the true original.
- `:250` "restoreCachedThreadListEntries"(queryClient, originals) has the same identity restore with a per-list short-circuit and no `project` argument.
- Consumers: `thread-answer-cache-owner.ts:270` "holdThreadListProjection" uses it at `:275`, `:283` (re-applies on every fetched thread-list or sidebar success, chaining `originals`) and `:299`. `thread-continuation-cache-owner.ts:32-33` imports it, using it at `:139` "listRollback" without chaining and at `:203`.

*Search for other consumers* (Proven by inspection; a search with no hits is not proof of absence): `git grep -n -E "applyOptimisticThreadListState|restoreOptimisticThreadLists|projectCachedThreadListEntries|restoreCachedThreadListEntries|cachedThreadEntries|thread-list-optimism" e9e1b74c3 -- .` finds only the files listed above. No test, plugin, SDK, `packages/*` export or script imports them. The same search excluding `apps/app/src` returns nothing. These are module-internal app helpers with no persisted data, string addressing or public surface. Plugins cannot reach them, because they live in `apps/app/src/hooks/cache-owners`, outside the plugin SDK.

*Drift between the copies* (Proven by inspection):

| Behaviour | Copy A (`thread-list-optimism.ts`) | Copy B (`thread-answer-cache-owner.ts`) |
|---|---|---|
| Unchanged entry (projection returns the same or a deep-equal object) | records `entry → entry` | not recorded |
| Restore with `project` | yes (`project(previous)`) | no |
| Re-projection chaining | no | yes (`originals` argument) |
| Per-list short-circuit | no (always remaps) | yes |
| Same thread id twice in one list | first occurrence recorded | last occurrence recorded |

*Counterevidence and current requirement.* The identity-pair row matters. `patchCachedQueryData` (`cache-effect-utils.ts:29`) calls `setQueryData`, and default TanStack structural sharing keeps a deep-equal entry's old reference. So when an optimistic projection is a no-op, for example `:1043` "withAcceptedTurnStatus" on a thread that is already running with the same `queuedWork`, Copy A still records the entry. The rollbacks at `:1373` and `:1460` then apply their `project` to it. Copy B's `previous !== stored` filter would skip that entry and change behaviour. The merged helper must therefore record every pair that exists before and after. That is a safe superset for Copy B: an identity pair restores an entry to itself, and the chaining expression `originals.get(previous) ?? previous` is unaffected. The short-circuit is an allocation saving only. The outer wrappers (`{ ...data, pages }` in `thread-list-cache-data.ts:58`, `{ ...currentNavigation }` in `query-cache.ts:311`) are rebuilt either way, and structural sharing restores unchanged references, so render behaviour does not depend on it. The requirement both copies serve is that an optimistic sidebar or list change must roll back only the entries its own transaction changed, and must survive or re-apply across stale refetches while an answer is held.

*Maintenance cost today.* There are two implementations of the same identity-rollback contract, with two key schemes and two matching rules. Owners choose between them by accident of import history: `thread-list-optimism.ts` was added in `be3756d84` on 2026-11-25, after Copy B already existed. Any change to which caches count as a thread list, or any duplicate-row fix, needs two edits and two mental models.

**Proposed end state and preservation argument**

What remains is one module, `apps/app/src/hooks/cache-owners/thread-list-optimism.ts`, which owns cached thread-list projection and identity rollback. It keeps the existing exported names, so the 16 runtime-owner and outbox call sites do not change:

```ts
export function applyOptimisticThreadListState(
  queryClient: QueryClient,
  threadId: string,
  update: (thread: ThreadListEntry) => ThreadListEntry,
  originals: Map<ThreadListEntry, ThreadListEntry> = new Map(),
): Map<ThreadListEntry, ThreadListEntry>;
// before = entries keyed by hashKey(queryKey) (+ sidebar key), last match per list (Copy B rule)
// apply update with per-list short-circuit (Copy B)
// for each key present before and after: originals.set(stored, originals.get(previous) ?? previous)
//   — NO `previous !== stored` filter (keeps Copy A identity pairs)

export function restoreOptimisticThreadLists(
  queryClient: QueryClient,
  rollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>,
  project: (thread: ThreadListEntry) => ThreadListEntry = (thread) => thread,
): void;
// per-list short-circuit; recorded entry → project(original)
```

The return type widens from `ReadonlyMap` to `Map`. Existing transaction fields typed `ReadonlyMap<ThreadListEntry, ThreadListEntry>` still accept it.

What disappears: `thread-answer-cache-owner.ts:196` "cachedThreadEntries", `:218` "projectCachedThreadListEntries" and `:250` "restoreCachedThreadListEntries". The old snapshot-then-rescan body of `thread-list-optimism.ts:13-62` goes too, along with the imports that only those helpers used: `getCachedThreadLists`, `iterateThreadListCacheEntries` and `applyToCachedThreadListsAndSidebarNavigation` in `thread-answer-cache-owner.ts`. Keep `hashKey`, `getCachedSidebarNavigationThreads` and `sidebarNavigationQueryKey` there, because `:192`, `:308`, `:334` and `:354` still use them.

How each behaviour survives:
- Identity rollback that keeps newer server data: unchanged. Both restore paths still look entries up by object identity.
- Runtime `project`-on-restore, including unchanged entries: preserved by recording identity pairs and keeping the `project` parameter.
- Answer-hold chaining across stale refetches (`holdThreadListProjection`): preserved by the `originals` parameter.
- Continuation rollback: it moves from Copy B to the merged helper. It gains identity pairs, which restore to themselves, so there is no observable change.
- Runtime and outbox callers gain the short-circuit (allocation only) and switch from the first to the last duplicate match in a list. This matters only if one cached list holds the same thread id twice. Both copies already leave one duplicate unrestored, which is recorded separately as a suspected P3 issue. Choosing one rule here is not a fix.

Non-goals: no change to `holdThreadListProjection`, its subscription or `cancelThreadListReads` (that is RF-081). No change to the whole-list snapshot rollback in `thread-list-cache-data.ts`. No positional duplicate pairing. No UI change.

This is the simplest sufficient option because it keeps one file and the existing names, needs no new abstraction, and changes only 5 call sites (3 in the answer owner, 2 in the continuation owner).

**Expected gain and cost**

Line counts below are physical lines from `git show e9e1b74c3:<path> | wc -l` and `awk 'NR>=196&&NR<=268'`. Non-blank counts come from `grep -c -v '^\s*$'`. All are handwritten production code; there are no generated, test or doc lines.

- Before: 76 lines in `thread-list-optimism.ts`, plus 73 helper lines and 4 helper-only import lines in `thread-answer-cache-owner.ts`, about 153 lines across two mechanisms.
- After (projection): `thread-list-optimism.ts` grows to about 85-90 lines, from the Copy B body plus the `project` parameter and the `hashKey` and `sidebarNavigationQueryKey` imports. `thread-answer-cache-owner.ts` loses about 77 lines and gains about 4 import lines. Net reduction: about 55-65 production lines, which is about 50 non-blank lines.
- Mechanisms: two identity-rollback implementations become one, and two key schemes become one.
- Test lines: no change is required. One optional new helper test is suggested below (about 60-90 lines).
- Performance: neutral. The short-circuit saves array allocation for lists that do not contain the thread. It does not change render identity, because structural sharing already does that. This is a projection, not a measurement.
- Cost: five call-site import and name edits, and one widened return type.

**Execution steps**

1. Reconfirm the anchors. In the target checkout, run `git grep -n -E "applyOptimisticThreadListState|restoreOptimisticThreadLists|projectCachedThreadListEntries|restoreCachedThreadListEntries|cachedThreadEntries" -- .` and confirm the consumer list matches the Context section. **Re-plan if:** a new consumer outside `apps/app/src/hooks/cache-owners` appears, a caller starts depending on the `previous !== stored` filter (for example, it reads `originals.size` to decide whether anything changed), or RF-081 has already moved `holdThreadListProjection`. In that last case, merge into RF-081's primitive instead.
2. Optional characterization test, written before the edit. Add `apps/app/src/hooks/cache-owners/thread-list-optimism.test.ts` using a real `QueryClient`, with one infinite thread list, one plain-array list and a sidebar bootstrap seeded. Cover four cases. (a) A no-op update followed by `restoreOptimisticThreadLists(qc, map, project)` applies `project` to the entry. (b) A list without the thread keeps its exact array reference after the update. (c) After an update, a server `setQueryData` replacing the entry, then restore, the server entry is kept. (d) Calling apply twice with the same `originals` restores to the very first original. Run it against the old code first: (a) and (c) must pass on Copy A, and (d) shows the gap Copy A has today. Adjust (d) to run only after step 3.
3. Edit `thread-list-optimism.ts`:
   - Add `import { hashKey } from "@tanstack/react-query"` (the `QueryClient` type import stays) and `sidebarNavigationQueryKey` to the existing `../queries/query-keys` import.
   - Move `cachedThreadEntries` here as a private function, unchanged.
   - Replace the body of `applyOptimisticThreadListState` with Copy B's `projectCachedThreadListEntries` body. Add the `originals` parameter with default `new Map()`. Change the record condition from `previous !== undefined && previous !== stored` to `previous !== undefined`. Return `Map<ThreadListEntry, ThreadListEntry>`.
   - Replace the body of `restoreOptimisticThreadLists` with Copy B's short-circuit loop, using `return project(original)` for a hit and keeping the `project` default.
   - Checkpoint: `thread-runtime-cache-owner.ts` and `outbox-thread-state-cache-owner.ts` compile unchanged.
4. Edit `thread-answer-cache-owner.ts`: delete `:196-268`, import `applyOptimisticThreadListState` and `restoreOptimisticThreadLists` from `./thread-list-optimism`, and replace the three uses at `:275`, `:283` and `:299` (the `:283` call keeps passing `originals`). Drop the now-unused imports `applyToCachedThreadListsAndSidebarNavigation`, `getCachedThreadLists` and `iterateThreadListCacheEntries`. Keep `hashKey`, `getCachedSidebarNavigationThreads` and `sidebarNavigationQueryKey`.
5. Edit `thread-continuation-cache-owner.ts`: replace the import at `:31-34` with `./thread-list-optimism`, and rename the uses at `:139` and `:203`. This also removes the continuation owner's import of the answer owner.
6. Clean up and recount. Run the `git grep` from step 1 again: the result must show zero hits for `projectCachedThreadListEntries`, `restoreCachedThreadListEntries` and `cachedThreadEntries`. Recount with `wc -l` on both files and compare against the 76 + 497 baseline. Inspect the full diff for unrelated changes.

**Verification and acceptance criteria**

The audit snapshot has no `node_modules`, so none of these commands were run during the audit. The script names come from `apps/app/package.json` ("test": `vitest run --config vitest.config.ts`, "typecheck", "lint") and the root `package.json` ("format:check": `oxfmt . --check`).

- Working directory `apps/app`: `pnpm exec vitest run --config vitest.config.ts src/hooks/cache-owners/thread-answer-cache-owner.test.ts src/hooks/cache-owners/thread-continuation-cache-owner.test.ts src/hooks/cache-owners/outbox-thread-state.test.ts src/hooks/cache-owners/thread-runtime-cache-owner.test.ts src/hooks/mutations/thread-runtime-mutations.test.tsx`, plus `src/hooks/cache-owners/thread-list-optimism.test.ts` if it was added in step 2. `apps/app/vitest.config.ts` accepts exact `src/**.test.ts(x)` paths as filters. All tests must pass with no edited assertions. The decisive existing cases are:
  - `thread-answer-cache-owner.test.ts`: "re-applies to stale fetched sidebar data until released" (`:128`), "puts the chat back to needs-you when the answer fails, even after a stale refetch" (`:151`) and "restores the card, the list entry and the Inbox when the answer fails" (`:421`).
  - `thread-continuation-cache-owner.test.ts`: "shows the retried chat running everywhere and survives a stale sidebar read" (`:166`) and "puts the chat back to paused when the request fails" (`:214`).
  - `thread-runtime-cache-owner.test.ts`: "preserves newer authoritative sidebar state when a readiness-clearing send fails" (`:554`), "re-projects queued work instead of clearing it when a failed queued create rolls back" (`:1499`) and "removes a deleted scheduled message's wait from the sidebar at once and restores it on failure" (`:1438`).
  - `outbox-thread-state.test.ts`: "removes only the failed submission when two sends overlap" (`:205`).
- Working directory `apps/app`: `pnpm run typecheck` must pass, and `pnpm exec oxlint --deny-warnings --format=agent src/hooks/cache-owners` must report no warnings.
- Repository root: `pnpm exec oxfmt --check apps/app/src/hooks/cache-owners/thread-list-optimism.ts apps/app/src/hooks/cache-owners/thread-answer-cache-owner.ts apps/app/src/hooks/cache-owners/thread-continuation-cache-owner.ts` must pass. Running `oxfmt` on explicit file paths in `--check` mode is unconfirmed; the root script `pnpm format:check` is the confirmed form.
- UI: there is no visual change, so screenshots are not needed. Optional manual check in the web app: send a message while offline or to a failing host, and confirm the sidebar row shows the optimistic state and then returns to its prior state. Answer a question and force a refetch; the row must stay answered until the request settles.
- Structural completion: exactly one definition of identity thread-list rollback exists (`thread-list-optimism.ts`), `thread-answer-cache-owner.ts` no longer exports list-projection helpers, and `thread-continuation-cache-owner.ts` no longer imports from `thread-answer-cache-owner.ts`.

**Rollback and stop conditions**

- Reversible boundary: one commit touching three production files (plus the optional test). There is no persisted data, API or SDK contract involved, so `git revert` of that commit fully restores the old state.
- Stop if any listed owner test fails in a way that needs an assertion change. That means a caller depends on one copy's drift (the identity filter, first-match or the always-remap behaviour). Record which one, keep both helpers, and narrow the change to moving the continuation owner onto Copy A, or re-plan inside RF-081.
- Stop if the characterization test in step 2 (a) shows that the merged helper drops an identity pair. The record condition must be `previous !== undefined` only.
- Stop if a consumer outside `apps/app/src/hooks/cache-owners` is found in step 1.
- Do not use this change to fix duplicate rows in one list (positional pairing). That fix is a separate issue with its own test.
