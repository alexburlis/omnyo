# RF-054 — Replace the three copies of the "discard a created but unstarted thread" recipe with one helper beside `requestThreadStorageDeletion`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The sweep report claimed that five sites write out the same deleted-thread effect sequence and should share one `runDeletedThreadEffects(..., { storage })` helper. Verification found that only the three failed-start discards are real duplicates. Two of them are identical apart from indentation and the third differs only by one pair of braces. The delete route and the two project-deletion steps run deliberately different sequences, so a five-site helper would need several flags and would not remove a mechanism. That part is rejected below.
- **Potential:** low. One duplicated multi-step recipe disappears: emit the plugin `thread.deleted` event, tombstone the lifecycle tree, then request storage deletion on the thread's host. The net reduction is about 30 to 40 handwritten production lines.
- **Confidence:** high. Every fact below is Proven by inspection of the snapshot.
- **Readiness:** ready. The sweep made the item conditional on whether the discard paths should also cancel provider creations, close terminals and purge the history cache. Inspection answers that question (see Context). No failed-start discard can run after provisioning has been scheduled, and the periodic sweep already closes terminals and purges history for every deleted thread. The helper therefore keeps today's narrow behaviour, and no owner decision is needed.
- **Effort:** one to two hours, including the focused tests.
- **Risk:** low. The helper is a pure extraction with the same call order. The main hazard is an import cycle if the helper is placed in the wrong module (see step 3).
- **Prerequisites:** none.
- **Related and overlapping:** RF-024 (one thread-storage retention rule) edits `requestThreadStorageDeletion` internals in the same file, `apps/server/src/services/threads/thread-lifecycle.ts`. This card adds a caller next to that function and does not change its signature. Either order works, but rebase carefully. No other RF item touches these three discards.
- **Why it earns its place:** it is a small, ready, behaviour-preserving removal of duplicated knowledge in thread creation. It also records why the wider five-site consolidation is not worth doing, so later agents do not repeat it.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree had already been removed when this card was written, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`. No tests were run, because the snapshot has no `node_modules`.

*How a thread is deleted.* `markThreadDeleted` (`packages/db/src/data/threads.ts:3195`) sets `deletedAt` on the thread's whole lifecycle tree, notifies `thread-deleted` and `threads-changed`, and returns the target row. The host-side work lives in `requestThreadStorageDeletion` (`apps/server/src/services/threads/thread-lifecycle.ts:1459`). It interrupts pending interactions, aborts plugin tool calls, and then either marks storage deleted directly (when the thread has no environment or its host was destroyed) or sends `thread.storage.delete` to the host. Every deletion site already calls it, so it is the single owner of the effects that must happen on every path. The periodic sweep `runThreadProvisioningOrphanCleanupSweep` (`apps/server/src/services/system/periodic-sweeps.ts:413`) reconciles the rest: lines 466-500 close terminals for every deleted thread, purge the history cache once `storageDeletedAt` is set, and re-request storage deletion when it is still unfinished.

*The three duplicate discards (Proven by inspection).* A thread that was inserted but failed before it started is discarded with this recipe: emit `emitPluginThreadDeleted` with a copy of the thread carrying `deletedAt: Date.now()`, call `markThreadDeleted`, and, if a row came back, call `requestThreadStorageDeletion` with the row's environment.

| Site | Symbol | Lines | Notes |
|---|---|---|---|
| `apps/server/src/services/threads/thread-create.ts:619-641` | `discardFailedCreate` | 23 | Called once, from `createIdleThread` at line 709. |
| `apps/server/src/services/threads/thread-create.ts:792-809` | inline in the `catch` of `createPendingThreadAndAttemptFirstDispatch` | 18 | The same statements as `discardFailedCreate`, not a call to it. |
| `apps/server/src/services/threads/native-import.ts:67-88` | `discardFailedImport` | 22 | Runs `deleteNativeThreadImport` first, then the same recipe. Called at line 325. |

Comparison method: a `python3 -I -c` script read the three ranges from `git show` and compared them after stripping each line's surrounding whitespace. `thread-create.ts:623-640` and `thread-create.ts:792-809` are identical. `native-import.ts:69-86` differs only in `if (deleted) {` against `if (deleted)`. That result is Reproduced.

*Why the discards do not need the extra effects (Proven by inspection).* The sweep report asked whether a failed create can already have started provider environment creation, which would make the missing `cancelAbandonedProviderCreations` a bug.

- `createIdleThread` (`thread-create.ts:643-721`): the `try` block covers session options, `buildExecutionOptions`, `setThreadExecutionOverride` and the `run.preparing` transaction. `scheduleThreadProvisioningAdvance` runs at line 718, after the `catch`.
- `importNativeThread` (`native-import.ts:316-329`): `seedImportedThread` is inside the `try`. `scheduleThreadProvisioningAdvance` runs at line 329, after the `catch`. The seeding transaction and its notifications are synchronous, so no timer-driven sweep can run between the commit and the discard.
- `createPendingThreadAndAttemptFirstDispatch` (`thread-create.ts:723-821`): the only provisioning start inside `attemptDispatch` is `launchAdmittedThread` (`apps/server/src/services/threads/dispatch-attempt.ts:1125-1136`). It settles the claimed queue row and fires `scheduleThreadProvisioningAdvance`, which catches its own errors. `runDispatchAttempt` then returns `{ kind: "dispatched" }` (line 826), and nothing after `await attemptDispatch(...)` in the `try` can throw. `admitPendingThread` (lines 1003-1123) only writes the provision context and the `client/turn/requested` events inside its transaction (`requestThreadProvision`, `apps/server/src/services/threads/thread-provisioning.ts:346`).
- `cancelAbandonedProviderCreations` (`apps/server/src/services/threads/thread-environment-providers.ts:71-82`) clears the in-memory provision schedule and cancels a preparing environment or creating machine. None of these exist before provisioning has been advanced.
- Terminals and the history cache are reconciled for every deleted thread by `periodic-sweeps.ts:479-492`.

Residual uncertainty (Hypothesis): between `admitPendingThread` committing and `launchAdmittedThread` running, the dispatch-hook pass (`apps/server/src/services/threads/dispatch-hooks.ts:363-376`) returns through a `finally` block and an evaluation lock. If that code ever threw, the discard would tombstone a `starting` thread that the provisioning sweep (`periodic-sweeps.ts:417-434`, `status = 'starting'`) might already have advanced. No such throw was found. This is not a reason to change behaviour in this card.

*Why the wider five-site helper is rejected (Proven by inspection).* The delete route and project deletion are not copies of each other:

- `apps/server/src/routes/threads/base.ts:700-736` (`routes.delete`) marks the tree once, then for each dependent re-reads the row, emits only for threads that were not deleted before, cancels provider creations, closes terminals and requests storage deletion unconditionally. It yields with `setImmediate` between dependents (covered by `apps/server/test/threads/deleted-thread-history-purge.test.ts:46`) and purges the history cache in a second loop after the effects.
- `apps/server/src/services/projects/project-deletion.ts:72-110` (`tombstoneProjectThreadsForDeletion`) marks threads inside one transaction with a `NotificationBuffer`, flushes it, and then only emits and cancels. `beginProjectDeletion` (lines 124-150) requests storage deletion only when `storageDeletedAt` is still null, through `requestUnfinishedThreadStorageDeletion` (lines 152-159). Terminal closure and history purge are left to `advanceProjectDeletion`.
- `advanceProjectDeletion` (`project-deletion.ts:180-240`) marks and emits when needed, awaits the history purge before cancelling, closes terminals and requests unfinished storage deletion. It runs repeatedly until no project threads remain.

The common part of those three sequences is two calls, `cancelAbandonedProviderCreations` and `closeDeletedThreadTerminals`. Their differences in emission rule, storage gating, purge timing, yielding and transaction buffering all have current reasons. A shared helper would need about three options and would save fewer than ten lines. The sweep report's maintenance example ("a new per-thread deletion effect needs five edits") is also overstated: effects that must apply on every path already belong in `requestThreadStorageDeletion`, which all sites call.

*Tests that encode the contract.*

- `apps/server/test/services/plugins/plugin-thread-events.test.ts:401` "delivers thread.deleted when thread creation rolls back after insert" covers a failed pending create through `POST /api/v1/threads`.
- `apps/server/test/threads/native-import.test.ts:618` "removes the import record when seeding fails so a retry imports" covers `discardFailedImport`.
- `apps/server/test/threads/thread-create-session-options.test.ts:253` expects a 400 when the named model cannot run with the chosen options. That error comes from `buildExecutionOptions` inside the pending create's `try`.
- No test found specifically targets the `createIdleThread` discard. Search: `git grep -n -i -E 'it\(".*(fail|reject|invalid).*(creat|start)' e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- apps/server/test`, and the same search for `discard|seedWithoutRun` in the thread-create tests. A search with no hits does not prove there is no coverage.

*Consumers.* `discardFailedCreate` and `discardFailedImport` are module-private, so no SDK, plugin-SDK, CLI or persisted-format consumer can depend on them. The plugin-visible contract is the `thread.deleted` event payload, which this card keeps unchanged.

**Proposed end state and preservation argument**

`thread-lifecycle.ts` gains one exported function next to `requestThreadStorageDeletion`:

```ts
/** Undoes a thread that was inserted but never started: tells plugins it is gone,
 *  tombstones it, and removes its host storage. */
export function discardUnstartedThread(
  deps: CommandResultSideEffectsDeps,
  thread: Thread,
): void {
  emitPluginThreadDeleted({ ...thread, deletedAt: Date.now(), updatedAt: Date.now() });
  const deleted = markThreadDeleted(deps.db, deps.hub, { threadId: thread.id });
  if (deleted)
    requestThreadStorageDeletion(
      deps,
      deleted,
      deleted.environmentId ? getEnvironment(deps.db, deleted.environmentId) : null,
    );
}
```

- `discardFailedCreate` and the inline copy in `createPendingThreadAndAttemptFirstDispatch` disappear. Both `catch` blocks call `discardUnstartedThread(deps, thread)`.
- `discardFailedImport` either keeps its name as a two-statement function (`deleteNativeThreadImport` then `discardUnstartedThread`) or is inlined at its single call site. Inlining is preferred because the function would only rename two calls.
- What survives: the exact order (plugin event before tombstone, tombstone before storage request), the synthesized `deletedAt`/`updatedAt` on the plugin payload, the "only if a row came back" guard, and the import-record removal before everything else in the import path.
- Why this place: both callers already import `requestThreadStorageDeletion` from `./thread-lifecycle.js`. `thread-lifecycle.ts` already imports `getEnvironment` and `CommandResultSideEffectsDeps`. It needs two new imports: `markThreadDeleted` from `@omnyo/db` and `emitPluginThreadDeleted` from `../plugins/plugin-thread-events.js`, which imports only types and the emitter. `ThreadCreateDeps` (`thread-create.ts:102`) is `LoggedPendingInteractionWorkSessionDeps`, which is the same type as `CommandResultSideEffectsDeps` (`apps/server/src/internal/command-result-side-effects.ts:10`). `AppDeps` in `native-import.ts` satisfies it, because that file already passes `deps` to `requestThreadStorageDeletion`.
- Non-goals: no change to the delete route, project deletion or the periodic sweep. The discards do not gain provider cancellation, terminal closure or an immediate history purge. `requestThreadStorageDeletion` keeps its signature and behaviour, which leaves it to RF-024.

**Expected gain and cost**

These figures are projections from the snapshot ranges, not measurements.

- Removed: `discardFailedCreate` (23 lines), the inline copy (18 lines, replaced by 1) and the body of `discardFailedImport` (22 lines, replaced by about 2 at the call site). Import lines that become unused: `markThreadDeleted` and `emitPluginThreadDeleted` in both callers. `getEnvironment` stays in both files, because it is used at `thread-create.ts:315,342,511` and `native-import.ts:246`.
- Added: the helper with its comment (about 20 lines) and two imports in `thread-lifecycle.ts`.
- Net: about 30 to 40 fewer handwritten production lines. Tests, generated code and docs do not change.
- Mechanisms: three copies of the discard recipe become one. A future change to what "discard an unstarted thread" means, such as a new plugin event field or a guard, becomes one edit. Today the native-import copy has already drifted in form.
- Performance: neutral. The calls are the same.

**Execution steps**

1. **Reconfirm the anchors.** On current `main`, check that `discardFailedCreate`, the inline `catch` copy in `createPendingThreadAndAttemptFirstDispatch` and `discardFailedImport` still match the recipe above. Check that `scheduleThreadProvisioningAdvance` is still outside the `try` in `createIdleThread` and `importNativeThread`, and that `launchAdmittedThread` is still the last step of a successful first dispatch. **Stop and re-plan** if any discard now runs after provisioning is scheduled, or if a copy has gained an extra effect. Either change means the copies have diverged on purpose, or that a real cancellation bug now exists and needs a separate fix first.
2. **Baseline.** In `apps/server`, run the three focused tests listed under Verification and record that they pass.
3. **Add the helper.** In `apps/server/src/services/threads/thread-lifecycle.ts`, add `discardUnstartedThread` directly below `requestThreadStorageDeletion`, with the signature above and `Thread` typed from `@omnyo/domain` (check that the file already imports that type). Add `markThreadDeleted` to the existing `@omnyo/db` import block, which ends at line 50, and add `import { emitPluginThreadDeleted } from "../plugins/plugin-thread-events.js";`. Do not put the helper in `thread-create-helpers.ts`: that module does not import `thread-lifecycle.ts` today, and the new edge would risk an import cycle.
4. **Switch thread creation.** In `apps/server/src/services/threads/thread-create.ts`, delete `discardFailedCreate` (lines 619-641). Replace the call at line 709 and the inline block at lines 792-809 with `discardUnstartedThread(deps, thread);`, keeping `throw error;` after each call. Change the line 1 import to `discardUnstartedThread`. Remove `markThreadDeleted` from the `@omnyo/db` import and remove the `emitPluginThreadDeleted` import (line 57) if nothing else uses them. Confirm with `rg -n "markThreadDeleted|emitPluginThreadDeleted|requestThreadStorageDeletion" apps/server/src/services/threads/thread-create.ts`.
5. **Switch native import.** In `apps/server/src/services/threads/native-import.ts`, replace `discardFailedImport` and its call at line 325 with these lines:
   ```ts
   } catch (error) {
     deleteNativeThreadImport(deps.db, thread.id);
     discardUnstartedThread(deps, getThread(deps.db, thread.id) ?? thread);
     throw error;
   }
   ```
   Keep the existing order: the import-record deletion runs first, and the thread is re-read before the discard. Remove the now-unused `markThreadDeleted`, `emitPluginThreadDeleted` and `requestThreadStorageDeletion` imports. Keep `getEnvironment`.
6. **Checkpoint.** Typecheck `apps/server` and run the focused tests again (see Verification).
7. **Inspect the diff.** `git diff --stat` should show only the three source files. `rg -n "emitPluginThreadDeleted\(\{" apps/server/src` should report only the helper. Recount the removed and added lines against step 2's baseline.

**Verification and acceptance criteria**

Run these in `apps/server` (package `@omnyo/server`). The scripts come from `apps/server/package.json` at the snapshot: `"test": "vitest run --config vitest.config.ts"` and `"typecheck": "tsc --noEmit"`.

- `pnpm typecheck` passes.
- `pnpm exec vitest run --config vitest.config.ts test/services/plugins/plugin-thread-events.test.ts test/threads/native-import.test.ts test/threads/thread-create-session-options.test.ts` passes. Those tests are "delivers thread.deleted when thread creation rolls back after insert", "removes the import record when seeding fails so a retry imports" and the 400 refusal for a model that cannot run with the chosen options. This form of the command was not executed at the snapshot, because there is no `node_modules`.
- Optional regression guard for the `createIdleThread` discard, which had no specific test found: drive an idle create (`seedWithoutRun`) to fail in `buildExecutionOptions`, the same way `thread-create-session-options.test.ts:253` does, and assert that the thread row has `deletedAt` set and that one `thread.deleted` plugin event was delivered. Add it only if the existing tests do not already reach that path.
- Lint and format, from the repository root (`$OMNYO_CHECKOUT`): `pnpm exec oxfmt <changed files>` and `pnpm exec oxlint --deny-warnings --format=agent`. The root `package.json` defines `format`, `format:check` (`oxfmt . --check`) and `lint` (`turbo run lint`). `apps/server` has no `lint` script of its own, so `pnpm lint` may not cover it. This was not confirmed.
- Structural completion: no `discardFailedCreate` or `discardFailedImport` remains, `emitPluginThreadDeleted({` with a synthesized `deletedAt` appears once in `apps/server/src`, and the delete route, project deletion and periodic sweep are byte-for-byte unchanged.
- No UI, persisted-format or performance check applies. The plugin `thread.deleted` payload is unchanged.

**Rollback and stop conditions**

- The change is three files in one commit with no data or protocol effect, so reverting that commit restores the old state completely.
- Stop if step 1 shows that one discard copy has gained a different effect, or that provisioning can start before a discard. Then decide first, as a separate behaviour fix, whether `discardUnstartedThread` should also call `cancelAbandonedProviderCreations`.
- Stop if adding the imports to `thread-lifecycle.ts` creates a circular-import warning or a test-time initialization error. The fallback is a small new module `apps/server/src/services/threads/thread-discard.ts` that imports `requestThreadStorageDeletion` from `thread-lifecycle.ts`.
- Do not extend the helper to the delete route or project deletion as part of this card. That consolidation was evaluated and rejected under Context.
