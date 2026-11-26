# RF-038 — Reconcile terminal tabs with live sessions in `useThreadFileTabs` only

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: three mechanisms reconcile terminal tabs with terminal sessions for the New Thread (root compose) panel and the thread detail panel, and the hook's prune effect is a strict subset of the views' sync effect. The sweep undercounted the gain. Once the view-level effect goes, each view's own `useUpdateFixedPanelTabsState` call and the whole `terminalPanelTabs` import also become dead, so the net reduction is about 55-62 handwritten production lines, not 35-50. The verification also found two narrow ordering differences (described below) that the sweep did not mention. Neither one blocks the change.
- **Potential:** medium. The change removes one state-coordination path per host and leaves one owner for "which terminal tabs exist". It deletes roughly 60 lines in two of the largest app files.
- **Confidence:** high. The verdict is Proven by inspection of every cited path. No tests were run, because the snapshot has no `node_modules`.
- **Readiness:** ready.
- **Effort:** S, about 2-3 hours including the added hook test.
- **Risk:** low. The final tab state is identical by inspection for every well-formed state. The residual differences are limited to (a) a malformed open panel with no valid active tab and (b) the relative order of tabs appended in the same commit by an unrelated effect. Both are described under "Proposed end state".
- **Prerequisites:** none.
- **Related and overlapping:** RF-013 (build secondary-panel tab descriptors once for root compose, thread detail and the plugin page right panel) consumes the same `syncedOrderedSecondaryFileTabs`/`terminalsById` values at `RootComposeView.tsx:1272` and `ThreadDetailView.tsx:3434`. Do RF-038 first, because it makes both views read `orderedSecondaryFileTabs` straight from the hook, which simplifies RF-013. RF-021 (shared secondary-panel host commands) touches the same two views but different symbols, so it is compatible in either order. RF-022 (derive persisted fixed-panel tab types from zod) is independent.
- **Why it deserves its place:** this is a small, low-risk change that removes duplicated knowledge. Today two views each restate the same "gate on loaded sessions, derive a synced list, write synced state" wiring on top of a hook that already half-does it.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the task was no longer on disk, so every file was read with `git show <commit>:<path>` from `$OMNYO_CHECKOUT`.

The subsystem is the right-hand secondary panel. Its tabs are stored per panel id in a jotai atom, the fixed-panel tabs state. Thread panels also persist that state to the server through `scheduleThreadTabsPersistence`. Terminal sessions come from a React Query list. A terminal tab should exist exactly for each *visible* session: `isVisibleTerminalSession` at `apps/app/src/lib/terminal-session-visibility.ts:4` counts active sessions and `disconnected` sessions as visible. Tabs for sessions that end must disappear, and tabs for new sessions must appear on the first render.

Observed facts (Proven by inspection):

- `apps/app/src/components/secondary-panel/terminalPanelTabs.ts` owns the rules:
  - `pruneTerminalTabsInFixedPanelState` (line 56) closes terminal tabs whose session is not visible. It closes each one through `closeSecondaryPanelTabInState`, which also picks the next active tab.
  - `buildTerminalSyncedSecondaryFileTabs` (line 123) is the pure render-time version. It drops stale and duplicate terminal tabs and appends a tab for each visible session that has none.
  - `syncTerminalTabsInFixedPanelState` (line 133) first calls `pruneTerminalTabsInFixedPanelState` (line 137), then appends the missing tabs and nulls an active id that no longer exists. Sync is therefore a strict superset of prune.
- Mechanism 1 is the hook. In `apps/app/src/components/secondary-panel/useThreadFileTabs.ts:462-470` "useThreadFileTabs", an effect calls `pruneTerminalTabsInFixedPanelState` when `isPanelStateResolved && terminalSessions !== undefined`. The hook returns `orderedSecondaryFileTabs` (line 746 `buildOrderedSecondaryPanelFileTabs`, returned at line 823) without any terminal sync.
- Mechanisms 2 and 3 are in root compose, `apps/app/src/views/RootComposeView.tsx`:
  - Line 715 has `updateFixedPanelTabsState = useUpdateFixedPanelTabsState(ROOT_COMPOSE_FIXED_PANEL_STATE_ID, null)`. This is the same panel id and sync id the hook receives at lines 852-853. Its only use is the effect at line 896.
  - Lines 822-823 define `terminalSessions` and `terminalsListLoaded`.
  - Lines 880-889 define the `syncedOrderedSecondaryFileTabs` memo, which calls `buildTerminalSyncedSecondaryFileTabs`.
  - Lines 891-902 hold an effect that calls `syncTerminalTabsInFixedPanelState` when `terminalsListLoaded`.
  - The hook receives `terminalSessions: loadedTerminalSessions` at line 861, the same value.
  - `syncedOrderedSecondaryFileTabs` is read at lines 1209, 1272 and 1408. The raw `orderedSecondaryFileTabs` has no other reader.
- The thread detail view, `apps/app/src/views/thread-detail/ThreadDetailView.tsx`, repeats the same pattern:
  - Line 856 has `updateFixedPanelTabsState = useUpdateFixedPanelTabsState(threadId, threadId)`, which matches the hook's panel and sync ids at lines 956-957. Its only use is line 1185.
  - The hook receives `terminalSessions: terminalsListQuery.data?.sessions` at line 961.
  - Lines 1161-1162 define `loadedTerminalSessions` and `terminalSessions`.
  - Lines 1169-1178 hold the `syncedOrderedSecondaryFileTabs` memo.
  - Lines 1180-1191 hold the sync effect, gated on `terminalsListQuery.data === undefined`. That gate equals `sessions === undefined`, because `sessions` is a required array in `packages/server-contract/src/api/terminals.ts:45`.
  - The synced list is read at line 3434 and `terminalsById` at line 3474.
- Both views import `buildTerminalSyncedSecondaryFileTabs` and `syncTerminalTabsInFixedPanelState` in a 4-line block that has no other use: `RootComposeView.tsx:134-137` and `ThreadDetailView.tsx:298-301`. Each also imports `useUpdateFixedPanelTabsState` only for the dead updater: `RootComposeView.tsx:110` and `ThreadDetailView.tsx:323`. A search for `updateFixedPanelTabsState` returns only lines 715, 896 and 902 in root, and 856, 1185 and 1191 in thread detail.
- `useUpdateFixedPanelTabsState` in `apps/app/src/lib/fixed-panel-tabs.ts` (around lines 327-360) returns early for an unresolved panel id (`hasThreadId`). It applies `ensureOpenFixedPanelHasActiveTab(update(current))` and skips the write when `next === current`. Today, a terminal list change therefore causes up to two store writes in the same commit, prune then sync. It can also cause two `scheduleThreadTabsPersistence` calls for a thread.
- The other production caller is `apps/app/src/components/plugin/PluginPanelRightPanelHost.tsx:403-412`. It passes `terminalSessions: undefined` and closes stale terminal tabs itself at lines 432-451, so it is unaffected. The test caller `apps/app/src/components/plugin/plugin-detail-navigation.test.tsx:174` also passes `undefined`.

Search scope for consumers: `git grep -n "pruneTerminalTabsInFixedPanelState\|syncTerminalTabsInFixedPanelState\|buildTerminalSyncedSecondaryFileTabs\|pruneTerminalTabsForSessions" e9e1b74c3 -- apps packages plugins`. The only hits are `terminalPanelTabs.ts`, its test, `useThreadFileTabs.ts`, `fixed-panel-tabs-sync.test.ts:36,812`, and the two views. These are app-internal modules. They are not exported from the SDK or the plugin SDK, are not string-addressed, and no plugin imports them. Persisted data is unchanged, because the stored tab list shape is not touched.

Tests that encode the contract:

- `apps/app/src/components/secondary-panel/terminalPanelTabs.test.ts` covers the pure helpers.
- `apps/app/src/components/secondary-panel/useThreadFileTabs.test.ts:777-848` ("useThreadFileTabs terminal pruning", "drops terminal tabs whose sessions exited") asserts `orderedSecondaryFileTabs` equals `[runningTab.id]`. Sync gives the same answer, because the running session already has a tab.
- `apps/app/src/lib/fixed-panel-tabs-sync.test.ts:812` calls sync directly.
- No view-level test covers the terminal sync. `git grep -ln "useThreadTerminals\|useEnvironmentTerminals\|terminalsListQuery"` over app test files found no RootComposeView or ThreadDetailView test.

Maintenance cost today: any change to which sessions get tabs, or to when reconciliation runs, has to be mirrored in two views and checked against the hook's partial copy. A reader also cannot tell which of the three paths is authoritative.

Line count. Method: read the snapshot files with `git show` and count the lines that would be deleted. These are handwritten production lines:

- Root compose: 4 import lines, 1 `useUpdateFixedPanelTabsState` import line, 5 lines for the updater plus its blank line, 1 `terminalsListLoaded` line, 11 for the memo, and 13 for the effect. That is about 35 lines.
- Thread detail: 4 import lines, 1 import line, 5 updater lines, 1 line from collapsing `loadedTerminalSessions` into `terminalSessions`, 11 memo lines and 13 effect lines. That is about 35 lines.
- The hook gains about 8-11 lines for the synced list.

**Proposed end state and preservation argument**

End state:

- `useThreadFileTabs` is the single owner of terminal-tab reconciliation for every host that passes `terminalSessions`.
  - Its effect at lines 462-470 calls `syncTerminalTabsInFixedPanelState` instead of `pruneTerminalTabsInFixedPanelState`. The gate, `isPanelStateResolved && terminalSessions !== undefined`, and the dependencies stay the same.
  - Its returned `orderedSecondaryFileTabs` is the terminal-synced list whenever `terminalSessions !== undefined`, and the plain ordered list otherwise.
- Both views read `orderedSecondaryFileTabs` from the hook directly.
- Both views keep `terminalsById`, because rendering needs session details per tab, and keep `EMPTY_TERMINAL_SESSIONS` for it.
- `pruneTerminalTabsInFixedPanelState` remains an internal step of sync. Drop its `export`, because no other importer remains and the test file does not import it.
- `PluginPanelRightPanelHost` is unchanged.

Why the semantics survive (Proven by inspection):

- **Same inputs.** The views' gates and the hook's gate test the same value. Root passes `loadedTerminalSessions` to the hook and gates on `loadedTerminalSessions !== undefined`. Thread detail passes `terminalsListQuery.data?.sessions` and gates on `data === undefined`, where `sessions` is required. The view effect has no `isPanelStateResolved` gate, but the updater no-ops for an unresolved id, so adding that gate changes nothing.
- **Same derived list.** The view memo computed `buildTerminalSyncedSecondaryFileTabs({ orderedTabs: orderedSecondaryFileTabs, terminalSessions })` from the hook's output. Computing the same expression inside the hook yields the same array, including first-render terminal tabs that exist before the effect commits.
- **Same final state.** Today the store receives `ensure(sync(ensure(prune(s))))`. After the change it receives `ensure(sync(s))`, and `sync(s)` is `addMissing(prune(s))`. These are equal whenever `ensure(prune(s)) === prune(s)`. That holds for every state that already satisfies the invariant "open implies a valid active tab". `closeSecondaryPanelTabInState` (`packages/client-core/src/panel/secondaryPanelTabState.ts:436`) always either picks a valid next active tab or closes the panel when no tabs remain. Every write through the updater re-establishes the invariant through `ensureOpenFixedPanelHasActiveTab` (`packages/client-core/src/panel/fixed-panel-tabs-state.ts:703`).

Known residual differences, intentionally accepted (Proven by inspection; reachability is a Hypothesis, judged very low):

1. **Malformed open panel with no tabs left.** Suppose a hydrated state is open with an active id that matches no tab, and pruning leaves zero tabs, while the same session list also adds a new visible session.
   - Today, the intermediate `ensure` closes the panel, and the new terminal tab is added to the closed panel.
   - After the change, the new terminal tab becomes active and the panel stays open.
   - A state like this does not come out of the updater itself, because `ensure` normalizes every write.
2. **Tab order within one commit.** The add phase now runs at the hook's effect position instead of after the view's other effects. In root those are the effects inside `usePanelBrowser`. In thread detail they are the effects inside `usePanelBrowser`, `useThreadOpenFileSignal` and `usePanelFiles`. Those effects open tabs only in response to their own signals. If such a signal fired in the same commit as a terminal list change, an appended browser or file tab and an appended terminal tab could swap places.

If the owner wants zero difference, stop and keep the change. These deltas do not justify the current duplication.

Additional effect (Hypothesis, positive): there is one store write and at most one `scheduleThreadTabsPersistence` call per terminal list change instead of up to two. The intermediate pruned tab list is no longer sent to the server.

Non-goals:

- Do not change the terminal visibility rule.
- Do not change `PluginPanelRightPanelHost`'s own stale-tab closing. It uses tab-carried terminal targets and a different query, so merging it is a separate decision.
- Do not restructure the tab descriptor building at `RootComposeView.tsx:1272` and `ThreadDetailView.tsx:3434`. That is RF-013.

**Expected gain and cost**

- **Before:** three reconciliation paths per host (the hook's prune effect, the view's sync effect and the view's synced memo), duplicated in two views, plus two `useUpdateFixedPanelTabsState` subscriptions that exist only for terminal sync.
- **After:** one path, in the hook. The two views no longer know that terminal sync exists.
- **Projected net reduction:** about 55-62 handwritten production lines (about 70 removed across the two views, 8-11 added in the hook). This is a projection from the line count above, not a measurement.
- **Tests:** add one hook test, about 30-40 lines. No test is removed.
- **Performance:** one fewer store write and persistence schedule per terminal list change, and two fewer hook subscriptions per view. This is a Hypothesis and has not been measured. The app uses the React Compiler (`apps/app/vite-react-compiler.ts`), so render cost differences are expected to be negligible.
- **Causal maintenance gain:** a future rule change such as hiding background sessions, or reconciling tabs on a new host, touches `terminalPanelTabs.ts` and nothing else. A new host gets correct terminal tabs simply by passing `terminalSessions` to the hook.

**Execution steps**

1. **Reconfirm the baseline.** Check out a branch from current main. Confirm the anchors still match: `useThreadFileTabs.ts`, the prune effect and the `orderedSecondaryFileTabs` return; `RootComposeView.tsx`, `syncedOrderedSecondaryFileTabs` and the effect calling `syncTerminalTabsInFixedPanelState`; and `ThreadDetailView.tsx`, the same two symbols. Re-run `git grep -n "updateFixedPanelTabsState" apps/app/src/views/RootComposeView.tsx apps/app/src/views/thread-detail/ThreadDetailView.tsx` and confirm the only use is the terminal effect. **Re-plan** if either view has gained another use of its updater (then keep the updater), if a view now passes different sessions to the hook than it uses for sync, or if a new caller of `useThreadFileTabs` passes `terminalSessions` and expects prune-only behavior.
2. **Add the missing behavioral evidence first.** In `apps/app/src/components/secondary-panel/useThreadFileTabs.test.ts`, under "useThreadFileTabs terminal pruning", add a test named something like "adds tabs for visible sessions without tabs". Follow the "drops terminal tabs whose sessions exited" fixture:
   - Seed local storage with one running terminal tab.
   - Render the hook with sessions `[running, newVisible, exitedOther]`.
   - Assert that `orderedSecondaryFileTabs` ids equal `[runningTab.id, createTerminalFixedPanelTab({ terminalId: newVisible.id }).id]`. Assert this on the first render result as well as after `waitFor`, to pin first-render correctness.
   - Assert that the persisted state also contains the new tab after effects run.

   This test fails on the current hook, which only prunes. Watch it fail before changing the hook.
3. **Make the hook the owner** (`apps/app/src/components/secondary-panel/useThreadFileTabs.ts`).
   - Change the import at line 73 to `import { buildTerminalSyncedSecondaryFileTabs, syncTerminalTabsInFixedPanelState } from "./terminalPanelTabs";`.
   - In the effect at lines 462-470, replace `pruneTerminalTabsInFixedPanelState` with `syncTerminalTabsInFixedPanelState`. Keep the gate and the dependency list unchanged.
   - Replace the `orderedSecondaryFileTabs` block at line 746 with:
     ```ts
     const orderedTabs = buildOrderedSecondaryPanelFileTabs({
       includeWorkspaceTabsOutsideEnvironment: preserveWorkspaceTabsAcrossContexts,
       tabs: fixedPanelTabsState.secondary.tabs,
       resolvedEnvironmentId,
     });

     const orderedSecondaryFileTabs = useMemo(
       () =>
         terminalSessions === undefined
           ? orderedTabs
           : buildTerminalSyncedSecondaryFileTabs({ orderedTabs, terminalSessions }),
       [orderedTabs, terminalSessions],
     );
     ```
     Keep the returned property name `orderedSecondaryFileTabs`.
   - Checkpoint: run the hook test file. The new test and the existing terminal test pass.
4. **Remove the root compose copy** (`apps/app/src/views/RootComposeView.tsx`).
   - Delete the `terminalPanelTabs` import block (lines 134-137).
   - Delete `useUpdateFixedPanelTabsState` from the `@/lib/fixed-panel-tabs` import (line 110).
   - Delete the `updateFixedPanelTabsState` declaration (lines 715-718) and `terminalsListLoaded` (line 823).
   - Delete the `syncedOrderedSecondaryFileTabs` memo (lines 880-889) and the sync effect (lines 891-902).
   - Rename the readers at lines 1209, 1272 and 1408 to `orderedSecondaryFileTabs`.
   - Keep `terminalSessions`, `terminalsById` and `EMPTY_TERMINAL_SESSIONS`.
5. **Remove the thread detail copy** (`apps/app/src/views/thread-detail/ThreadDetailView.tsx`).
   - Delete the import block (lines 298-301) and `useUpdateFixedPanelTabsState` from the import at line 323.
   - Delete the updater (lines 856-859).
   - Collapse lines 1161-1162 into `const terminalSessions = terminalsListQuery.data?.sessions ?? EMPTY_TERMINAL_SESSIONS;`.
   - Delete the memo (lines 1169-1178) and the effect (lines 1180-1191).
   - Rename the reader at line 3434 to `orderedSecondaryFileTabs`.
   - Keep `terminalsById`.
6. **Remove superseded machinery.** In `terminalPanelTabs.ts`, drop `export` from `pruneTerminalTabsInFixedPanelState`. First confirm that `git grep -n pruneTerminalTabsInFixedPanelState apps` shows only that file. Leave `pruneTerminalTabsForSessions`, `buildTerminalSyncedSecondaryFileTabs` and `syncTerminalTabsInFixedPanelState` exported, because tests and the hook use them. Confirm whether `useEffect`, `useMemo` and the `TerminalSession` type are still used in each view. They are: root has 6 `useEffect` calls and thread detail has 10.
7. **Finish.** Format with the repository formatter and run the checks below. Inspect the full diff: only the four source files and the one test file should change. Recount the removed lines with `git diff --stat`.

**Verification and acceptance criteria**

The commands were taken from `apps/app/package.json` (`"test": "vitest run --config vitest.config.ts"`, `"typecheck"`, `"lint"`) and the root `package.json` (`"format"`, `"format:check"`). The scripts exist at the snapshot. Their invocation with file filters was not executed, because the snapshot has no `node_modules`.

- Focused tests, from `apps/app`:
  ```sh
  pnpm test src/components/secondary-panel/useThreadFileTabs.test.ts src/components/secondary-panel/terminalPanelTabs.test.ts src/lib/fixed-panel-tabs-sync.test.ts src/components/plugin/PluginPanelRightPanelHost.test.tsx src/components/plugin/plugin-detail-navigation.test.tsx
  ```
  Expected: all pass, including the new "adds tabs for visible sessions without tabs" test. `vitest.config.ts` accepts plain `src/...test.ts(x)` filter paths.
- Types, from `apps/app`: `pnpm typecheck`. Expected: clean. The renamed readers type-check, because `buildTerminalSyncedSecondaryFileTabs` returns `readonly SecondaryFileFixedPanelTab[]`, the same element type as before.
- Lint and format, from the repository root: `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed files>`. Expected: no unused-import or unused-variable warnings, which also proves the dead updater and imports are gone.
- Manual UI check, for Alex or a release pass. On both the New Thread panel and a thread's right panel:
  - (a) Create a terminal. Its tab appears immediately with no blank first frame.
  - (b) Exit the terminal. Its tab disappears and the next tab becomes active.
  - (c) Reload a thread with a running terminal. The tab persists unchanged and there is no duplicate.
  - (d) The plugin page right panel still closes a terminal tab whose session ended.
- Structural completion: `git grep -n "syncTerminalTabsInFixedPanelState\|buildTerminalSyncedSecondaryFileTabs" apps/app/src/views` returns nothing, and `useThreadFileTabs.ts` is the only production importer of `terminalPanelTabs`.
- No performance benchmark is required. The change removes work and adds none on the hot path.

**Rollback and stop conditions**

- **Rollback:** the change is one self-contained commit across `useThreadFileTabs.ts`, `terminalPanelTabs.ts`, `RootComposeView.tsx`, `ThreadDetailView.tsx` and one test file. Reverting it restores the old behavior. There is no data migration and no persisted-format change.
- **Stop if:**
  - A view gains a reason to sync with sessions that differ from what it passes to the hook, for example a filtered list.
  - A new `useThreadFileTabs` caller needs prune-only behavior. In that case, add an explicit hook option instead of keeping view copies.
  - The new hook test shows that first-render tabs differ from the old view memo's output.
  - Manual checks show a missing-for-one-frame or duplicated terminal tab.
  - The owner rejects the two residual differences described under "Proposed end state".
- **Smaller alternative:** keep the view memos and effects and delete only the hook's prune effect. This removes about 9 lines and one redundant write, but leaves the knowledge duplicated in both views.
