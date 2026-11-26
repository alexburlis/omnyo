# RF-052 — Share the runtime owner's composer thread-status begin/settle helpers with the continuation and outbox owners

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but the sweep overstated it in two ways. First, `thread-runtime-cache-owner.ts` already has private begin and settle helpers that about 15 call sites use, so the work is to promote them, not to design new ones. Second, the outbox owner shares only the begin half. Its settle and discard paths correctly skip the restore step.
- **Potential:** medium. About 30 to 40 handwritten production lines go away. More importantly, one list of thread-status reads and one restore rule replace three hand-maintained copies in race-sensitive code.
- **Confidence:** high for the facts, which are proven by inspection. Medium for the line estimate, which is a projection.
- **Readiness:** conditional. One gate must be decided before merging: whether settling invalidates the thread-detail bootstrap query (`threadDetailBootstrapQueryKey`). The continuation copy invalidates it and the runtime copy does not. The recommended default is given below.
- **Effort:** small. About half a day, including one new characterization test.
- **Risk:** low to medium. Cancellation timing and invalidation sets decide whether status flickers after a send. The existing race tests cover most of this.
- **Prerequisites:** none.
- **Related and overlapping items:** RF-053 (whether every timeline follow-up runs through the send outbox) would move runtime follow-up paths onto the outbox owner. Those paths would keep calling the shared helper this card creates. RF-080 (merge the two identity-map thread-list projection and rollback helpers) edits the same two files (continuation uses `projectCachedThreadListEntries`, outbox uses `applyOptimisticThreadListState`) but touches different symbols. Do the two items in either order and rebase. RF-081 (one hold-and-reapply primitive for optimistic overlays) may later absorb `reconcileComposerThreadState`. This card does not depend on it.
- **Why it deserves its place:** the copies have already drifted. The invalidation sets differ, and so does whether reads are cancelled before settling. A new query that carries thread status, such as an inbox detail read, needs three cancel-list edits and two invalidation-list edits today. After this change it needs one edit of each.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The files were read with `git show <commit>:<path>` because the snapshot worktree had been removed. No tests were run: the snapshot has no `node_modules`.

How the subsystem works. When the user sends, continues or queues a message, the web app (`apps/app`) shows the thread as active or queued right away. Then it waits for the server to confirm. `apps/app/src/hooks/cache-owners/pending-composer-cache-owner.ts` holds the per-thread pending state:

- `retainPendingComposerThreadState` (line 91) records a token with kind `"active"` or `"queued"` and snapshots the last authoritative status.
- `settlePendingComposerThreadState` (line 112) accepts or drops that token. If no `"active"` token remains, it returns the authoritative status to restore. Otherwise it returns `null`.
- `reconcileComposerThreadState` (line 154) is called from `query-cache.ts` and keeps server reads from overwriting the optimistic state too early.

Each caller wraps these two calls in the same protocol:

1. Cancel the four reads that carry thread status: `sidebarNavigationQueryKey()`, `threadsQueryKey()`, `threadQueryKey(id)` and `threadDetailBootstrapQueryKey(id)`.
2. Retain the token, using `threadQueryKey` data or the matching sidebar entry as the previous status.
3. When the request finishes, settle the token. If a restore comes back, write it into every cached thread list, the sidebar and the thread detail, but only where the cached `updatedAt` is not newer.
4. Invalidate the status reads.

Observed copies (Proven by inspection):

| Owner | Cancel list | Waits for cancellation? | Retain | Settle and restore | Invalidated after settle |
|---|---|---|---|---|---|
| `apps/app/src/hooks/cache-owners/thread-runtime-cache-owner.ts` | `cancelComposerThreadStateReads` lines 552-563, 4 keys | No (`void`) | `beginComposerThreadState` lines 565-584 | `settleComposerThreadState` lines 586-623. It cancels again first, then restores (lines 601-614). | sidebar, threads, thread (lines 616-622). Not the bootstrap. |
| `apps/app/src/hooks/cache-owners/thread-continuation-cache-owner.ts` | `threadStatusReads` lines 66-73, same 4 keys | Yes: `await Promise.all(...)` at lines 115-119, before the previous status is read | inline at lines 128-137 | `settleComposerToken` lines 161-190. It does not cancel first on the `"sent"` path. Its restore block (lines 166-186) is identical to runtime lines 594-614 after whitespace trimming, checked with `python3 -I -c` over the two line ranges. The revert path cancels first (lines 200-201). | all 4 keys, including the bootstrap (lines 188-189) |
| `apps/app/src/hooks/cache-owners/outbox-thread-state-cache-owner.ts` | inline at lines 86-92, same 4 keys | No (`void`) | inline at lines 93-101, kind `"queued"`, passes `localWork` (`fact`) | `settle()` lines 190-196 and `discard()` lines 197-217 ignore the returned restore. `discard` rolls back through `restoreOptimisticThreadLists` and `withoutLocalWork`. | `refresh` lines 140-148: sidebar, threads, thread and `threadQueuedMessagesQueryKey` |

The runtime helpers are called at `thread-runtime-cache-owner.ts` lines 516, 1328, 1802, 1938 and 2442 (begin), lines 1382, 1410, 1485, 1543, 1582, 1655, 2019, 2146, 2505 and 2521 (settle), and line 2265 (cancel only, in the stop transaction).

Consumers, from `git grep` at the snapshot over `apps` and `packages`, excluding tests:

- `thread-runtime-cache-owner.ts` is imported by `hooks/mutations/thread-runtime-mutations.ts:85`, `hooks/useForkThreadFromMessage.ts:12`, `hooks/usePredictedSendWait.ts:5` and `thread-continuation-cache-owner.ts:30`.
- `thread-continuation-cache-owner.ts` is imported by `hooks/queries/thread-continuation-queries.ts:10`.
- `outbox-thread-state-cache-owner.ts` is imported by `lib/send-outbox/send-outbox.ts:2`.

None of the helpers is exported from a package, and nothing reaches them by string or dynamic import. Running `git grep -n retainPendingComposerThreadState` over the whole snapshot finds only the three owners, so mobile, desktop and plugins have no copy.

Constraints found while verifying:

- **Import cycle.** `pending-composer-cache-owner.ts` cannot host the restore step. The restore needs `applyToCachedThreadListsAndSidebarNavigation` and `updateCachedThread` from `query-cache.ts`, and `query-cache.ts` already imports `pending-composer-cache-owner.ts` at lines 15-20. The shared helpers therefore need their own module. The repository has no import-cycle lint rule: `.oxlintrc.json` has no cycle rule. The separate module is still the clean choice.
- **The runtime begin must stay synchronous.** `thread-status-races.test.ts` "shows Working on Enter, before pending reads finish cancelling" (around line 765) requires the optimistic state to appear before cancellation finishes.
- **The continuation begin waits for cancellation before reading the previous status.** Whether that ordering matters is unproven (Hypothesis). This card keeps it.
- **The outbox must keep ignoring the restore.** Its tokens are always `"queued"`, and its rollback is shaped differently (`restoreOptimisticThreadLists` plus `withoutLocalWork`).
- **The bootstrap query is expensive to invalidate.** `threadDetailBootstrapQueryOptions` (`apps/app/src/hooks/queries/thread-queries.ts` lines 853-892) uses `staleTime: Infinity`. It fetches `sdk.threads.get({ include: "environment,host" })`, writes `threadQueryKey` through `ingestThreadDetailBootstrap` (`thread-detail-cache-owner.ts:70`), and prefetches the timeline and the environment work status. `AppLayout.tsx` lines 798-801 keep it active on every thread view, with `timelinePrefetch` on. So each continuation settle sends a second GET for the same thread in parallel with the `threadQueryKey` refetch. No test asserts the bootstrap invalidation: searching the four related test files for `threadDetailBootstrapQueryKey` finds no assertion.

Maintenance cost today: three cancel lists, two copies of the restore block, and three invalidation sets, with no single place that states which reads carry thread status.

**Proposed end state and preservation argument**

What remains: one new module, `apps/app/src/hooks/cache-owners/composer-thread-state-cache-owner.ts`. It holds the runtime owner's three helpers, moved and exported, with two small signature extensions:

```ts
// One list of the reads that carry thread status.
function composerThreadStatusReads(threadId: string): QueryKey[];
// sidebarNavigationQueryKey(), threadsQueryKey(), threadQueryKey(id), threadDetailBootstrapQueryKey(id)

export function cancelComposerThreadStateReads(qc, threadId): Promise<void>;
// Fires every cancelQueries call synchronously (the same as today) and returns
// Promise.all of them. Callers that must not wait use `void`.

export function beginComposerThreadState(
  qc, threadId, token, kind: "active" | "queued",
  queuedMessage: LocalQueuedMessage | null = null,
  localWork: QueuedMessageWork | null = null,   // new: the outbox passes `fact`
): void;   // void cancel, then retain with (threadQueryKey data ?? sidebar entry)

export function settleComposerThreadState(qc, threadId, token, outcome): void;
// cancel, settle, apply restore with the updatedAt guard, invalidate the settle set

export function invalidateComposerThreadStateReads(qc, threadId): void;
// optional: the settle set, reused by the outbox `refresh`
```

What disappears:

- In the continuation owner: `threadStatusReads`, the inline retain and the whole `settleComposerToken`.
- In the outbox owner: the inline cancel list and the inline retain.
- In the runtime owner: the private copies, which move to the new module (moved code, not deleted complexity).

How each consumer changes:

- **Runtime owner:** imports the three helpers. Every call site stays the same.
- **Continuation owner:** `beginContinueThreadTransaction` runs `await cancelComposerThreadStateReads(...)`, reads `previousThread`, then calls `beginComposerThreadState(queryClient, threadId, token, "active")`. The begin cancels again, which is a no-op on already-cancelled reads. `revertContinueThreadTransaction` calls `void cancelComposerThreadStateReads(...)` before its rollbacks and `settleComposerThreadState(...)` at the end. The `"sent"` branch calls `settleComposerThreadState(...)`.
- **Outbox owner:** calls `beginComposerThreadState(queryClient, threadId, token, "queued", null, fact)` in place of lines 86-101. It keeps its direct calls to `settlePendingComposerThreadState` in `settle()` and `discard()`, so it still ignores the restore. If the helper is exported, `refresh` may call `invalidateComposerThreadStateReads` plus its queued-messages key.

Investigation gate: which reads are invalidated after settle. Decide this before Execution step 3.

- **Option A (recommended):** the runtime set, which is sidebar, threads and thread. The continuation path stops refetching the bootstrap. Reasons:
  - The bootstrap is a one-shot read (`staleTime: Infinity`).
  - Its refetch duplicates the `threadQueryKey` GET.
  - The runtime send path, the hot path, already omits it.
  - Choosing Option B would add one `include=environment,host` GET plus prefetches to every send.
- **Option B:** all four keys. The runtime and outbox paths would gain one bootstrap refetch per send while a thread view is open. Choose it only if the gate finds a reason the bootstrap must be refreshed.

What the gate checks:

1. Search for consumers that read `status`, `runtime` or `updatedAt` from `threadDetailBootstrapQueryKey` data rather than from `threadQueryKey`. Run `git grep -n "threadDetailBootstrapQuery\.\|threadDetailBootstrapQueryKey" apps/app/src`. At the snapshot, `AppLayout.tsx` reads only `projectId` and settled/refresh state. A consumer that reads status would favour Option B.
2. Check the suspected first-fetch case, recorded as an incidental issue and not part of this plan. Every owner cancels the bootstrap. If the bootstrap's first fetch is cancelled, TanStack Query v5 (`^5.62.0`) reverts it to `pending` with no data. Under Option A nothing refetches it. The continuation's extra invalidation would hide this case, so confirm or rule it out before dropping that invalidation. If it reproduces, fix it in its own change, for example by invalidating the bootstrap only when it has no data. Do not keep the 4-key set by accident.

Behaviour that intentionally changes:

- The continuation `"sent"` path now cancels in-flight status reads before settling, as the runtime path already does. Active queries are refetched by the following invalidation anyway (TanStack's default `cancelRefetch`), so only in-flight fetches of inactive queries are affected. This is Proven by inspection for the call sequence. Its effect on the UI is a Hypothesis and is checked by the existing continuation tests.
- Under Option A, the continuation path no longer refetches the bootstrap.

Everything else is preserved:

- the order of retain and settle calls;
- the `updatedAt` guard on the restore;
- the synchronous optimistic publish on Enter;
- the outbox's queued-messages refresh and rollback.

Non-goals:

- Do not change `pending-composer-cache-owner.ts` semantics.
- Do not merge the thread-list rollback helpers (that is RF-080).
- Do not move the runtime follow-up paths to the outbox (that is RF-053).

**Expected gain and cost**

- **Observed:** about 120 nonblank production lines currently belong to this protocol (counted with `sed -n <range>p <file> | grep -cv '^\s*$'`):
  - runtime lines 552-623: 67 lines;
  - continuation lines 66-73, 115-119, 128-137, 161-190 and 200-201: 53 lines;
  - outbox lines 86-101: 16 lines.
- **Projected:**
  - The continuation file loses about 38 to 45 lines, including the imports that are no longer needed.
  - The outbox file loses about 8 to 10 lines.
  - The new module adds about 15 lines of imports and exports on top of the 67 moved lines, and the runtime file sheds the matching imports.
  - Net: about 30 to 40 production lines.
  - Tests: about 20 to 30 added lines for the new characterization test.
- **Mechanisms:** three cancel lists become one, two restore blocks become one, and three ad hoc invalidation sets become one settle set plus one documented outbox extension.
- **Performance:** under Option A, the runtime and outbox paths are unchanged and the continuation path sends one fewer bootstrap request per continue. Under Option B, every send while a thread is open costs one extra bootstrap request. Neither option has been measured.

**Execution steps**

1. **Reconfirm the baseline.** In the working checkout, run `git log --oneline e9e1b74c3..HEAD -- apps/app/src/hooks/cache-owners/{thread-runtime,thread-continuation,outbox-thread-state,pending-composer}-cache-owner.ts`. Re-read the line ranges in the evidence table.
   - Re-plan if any of these is true:
     - `settlePendingComposerThreadState` no longer returns a restore;
     - a fourth owner now calls `retainPendingComposerThreadState`;
     - RF-053 has already moved runtime follow-ups to the outbox.
2. **Run the investigation gate** in "Proposed end state" and record the decision (A or B) in the commit message.
3. **Add one characterization test before editing.** In `apps/app/src/hooks/cache-owners/thread-continuation-cache-owner.test.ts`, spy on `queryClient.invalidateQueries` and `queryClient.cancelQueries` across `beginContinueThreadTransaction` and `settleContinueThreadTransaction(..., "sent")`. Assert the keys that the chosen option implies (Option A: no `threadDetailBootstrapQueryKey` invalidation). Watch it fail on the current code under Option A, then pass after the change. Under Option B, add the matching assertion to a runtime send test in `thread-runtime-cache-owner.test.ts` instead.
4. **Checkpoint 1, a mechanical move.** Create `composer-thread-state-cache-owner.ts` and move `cancelComposerThreadStateReads`, `beginComposerThreadState` and `settleComposerThreadState` verbatim from `thread-runtime-cache-owner.ts` lines 552-623. Factor the two inline key lists into `composerThreadStatusReads(threadId)`. Make `cancelComposerThreadStateReads` return `Promise.all(...)` of the synchronous `cancelQueries` calls. The existing `void` callers are unaffected. Import the helpers in the runtime owner and delete the private copies. Drop the runtime imports that are no longer needed: `retainPendingComposerThreadState` and `settlePendingComposerThreadState` from the import at lines 36-45, and `threadDetailBootstrapQueryKey` if it has no other use. Run the runtime and race tests (see Verification).
5. **Checkpoint 2, the continuation owner.**
   - In `beginContinueThreadTransaction`, replace lines 115-119 with `await cancelComposerThreadStateReads(queryClient, threadId);`. Replace lines 128-137 with `beginComposerThreadState(queryClient, threadId, token, "active");`. Keep `previousThread`, which the rollback still needs.
   - In `revertContinueThreadTransaction`, replace lines 200-201 with `void cancelComposerThreadStateReads(queryClient, threadId);`.
   - Delete `threadStatusReads` and `settleComposerToken`. Call `settleComposerThreadState(queryClient, transaction.threadId, transaction.token, outcome)` at the old call sites (lines 216 and 237).
   - Apply the gate decision to the settle set inside the shared helper, not in the continuation file.
   - Remove the imports that are no longer used: `sidebarNavigationQueryKey`, `threadsQueryKey`, `threadDetailBootstrapQueryKey`, `applyToCachedThreadListsAndSidebarNavigation`, `getCachedSidebarNavigationThreads`, `retainPendingComposerThreadState` and `settlePendingComposerThreadState`.
   - Run the continuation tests.
6. **Checkpoint 3, the outbox owner.** Add the `localWork` parameter to `beginComposerThreadState` and pass it through to `retainPendingComposerThreadState`. In `beginOutboxThreadMessageTransaction`, replace lines 86-101 with `beginComposerThreadState(queryClient, threadId, token, "queued", null, fact);`. The helper's own lookup is the same expression the outbox used for `thread`, which the outbox still needs for the inbox prediction and the rollback. Leave `settle()` and `discard()` calling `settlePendingComposerThreadState` directly. Add a one-line comment explaining why the outbox does not apply the restore: queued tokens never forced an active status, and the outbox rolls back through `restoreOptimisticThreadLists`. Optionally make `refresh` call `invalidateComposerThreadStateReads` plus `threadQueuedMessagesQueryKey`. Remove the `threadDetailBootstrapQueryKey` and `retainPendingComposerThreadState` imports. Run the outbox and send-outbox tests.
7. **Clean up and review.** Run `git grep -n "threadDetailBootstrapQueryKey(threadId),$" apps/app/src/hooks/cache-owners`: it should match only inside `composerThreadStatusReads`. Check that no file other than the new module both cancels and invalidates the status keys. Recount the reduction against the same line ranges. Inspect the full diff for unrelated edits.

**Verification and acceptance criteria**

The commands below were confirmed by reading `apps/app/package.json` (`test`, `typecheck` and `lint` scripts), `apps/app/vitest.config.ts` (which accepts explicit `src/...test.ts` file filters) and the root `package.json` (`format:check`). They were not run, because the snapshot has no dependencies installed.

- Run the focused tests from `apps/app`:
  `pnpm exec vitest run --config vitest.config.ts src/hooks/cache-owners/thread-runtime-cache-owner.test.ts src/hooks/cache-owners/thread-continuation-cache-owner.test.ts src/hooks/cache-owners/outbox-thread-state.test.ts src/hooks/cache-owners/thread-status-races.test.ts src/hooks/cache-owners/cache-owner-registry.test.ts src/lib/send-outbox/send-outbox.test.ts src/lib/send-outbox/send-outbox-state.test.ts src/lib/send-outbox/stage-timeline-follow-up.test.ts src/hooks/mutations/thread-runtime-mutations.test.tsx src/components/promptbox/banner/WaitingToSendCard.test.tsx`
  Expect every test to pass unchanged except the new characterization test. In particular, the race tests "shows Working on Enter, before pending reads finish cancelling", "cancels an older sidebar read before publishing the pending send" and "keeps the next pending send waiting when the first fails and clears after both fail" must pass without edits.
- Run the static checks from `apps/app`: `pnpm typecheck` and `pnpm lint`.
- Run the format check from the repository root: `pnpm exec oxfmt --check <changed files>`.
- Behaviour that must hold:
  - A send shows Working on Enter.
  - Continuing a paused chat shows it running in the sidebar, the list and the detail, and survives a stale sidebar read.
  - A failed continue returns the chat to paused.
  - An offline outbox follow-up keeps the queued state through stale reads.
  - Discarding one of two overlapping outbox sends removes only that send.
- No UI snapshots change. Alex tests the UI himself.
- Performance: under Option A, the continuation test's spy shows exactly three invalidations. No new request appears on the send path. Do not claim neutrality for Option B without counting requests.
- Structural completion:
  - `cancelQueries` calls on the four status keys exist only in the new module. The one exception is the stop transaction at runtime line 2265, which already calls the shared cancel.
  - `settleComposerToken` and `threadStatusReads` are gone.
  - The outbox no longer lists the status keys inline.

**Rollback and stop conditions**

- **Rollback:** each checkpoint is one revertable commit, and no persisted data or public API is involved.
- **Stop and re-plan if any of these happens:**
  - A race test fails after checkpoint 1. The move was not verbatim, so diff the moved helpers against the original lines.
  - The gate finds a consumer that reads status from bootstrap data. Choose Option B, and measure the extra send-path request before merging.
  - The first-fetch bootstrap case reproduces. Fix it separately first, so this refactor does not silently change whether it occurs.
  - Waiting for cancellation in the continuation path turns out to matter for a test, and the shared begin cannot keep the wait.
- **Smaller safe alternative:** if the shared settle cannot reconcile the continuation's revert ordering, share only `composerThreadStatusReads` and the begin half. That removes the three cancel lists and the outbox copy, and leaves `settleComposerToken` in place.
