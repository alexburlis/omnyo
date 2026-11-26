# RF-004 — Delete client-core's orphaned copy of the sidebar thread-list model

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** confirmed. Three independent sweeps (S05, S17, X1) reported this finding, and this verification re-checked it at the snapshot. The line counts in this card are corrected and slightly lower than the S05 test estimate.
- **Potential:** medium. About 474 physical (390 non-blank) handwritten production lines disappear, together with a second, already diverged definition of the sidebar's section ordering, pinned-descendant expansion, chronological tree building and collapsed-child activity.
- **Confidence:** high. The deleted symbols are plain TypeScript exports of a private workspace package. They have no string addressing and no dynamic import, and every consumer is a TypeScript workspace package that `tsc` checks.
- **Readiness:** ready. No owner decision is needed, because no supported feature, API or persisted format depends on this code.
- **Effort:** small, about one hour of edits plus the typechecks and the client-core tests.
- **Risk:** low. The only realistic regression is an importer this search missed, and the typechecks named below catch it at compile time.
- **Prerequisites:** none.
- **Related and overlapping items:**
  - RF-035 ("Retire the seven host sidebar.* UI preferences replaced by the Thread list plugin") is a separate remnant of the same migration. It touches different files, and either item can land first.
  - RF-068 ("Delete the superseded client-core live auto-expansion policy") and RF-079 ("Delete small orphaned helpers kept alive only by their own tests") also edit `packages/client-core/src/index.ts`. Those edits touch different lines, but rebase carefully if they land together.
  - The `plugins/thread-list/app/model` copies are not duplication to merge. `docs/forkable-plugins.md` forbids a plugin from importing a workspace package, and `packages/scripts/test/plugin-forks.test.mjs:217` rejects `@omnyo/client-core` as a plugin dependency. Those copies must stay.
- **Why this deserves its place:** this is verified dead machinery with an unusually clean reachability proof and almost no execution risk. It removes a maintenance trap: a maintainer who searches for `normalizeSidebarSectionOrder`, `buildPinnedSidebarState` or `getCollapsedChildActivity` finds two implementations, each with passing tests, and only one of them is live.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The named snapshot worktree no longer existed during verification, so the commit was extracted read-only with `git archive e9e1b74c3 | tar -x` into a temporary directory. Every path below is repository-relative.

*What the subsystem is.* `@omnyo/client-core` (`packages/client-core`) is a private, DOM-free package of client logic shared by `apps/app`, `apps/mobile`, `apps/cli` and `apps/server`. It is `"private": true` in `packages/client-core/package.json` and exports only `.`, `./route-paths` and `./prompt-draft`. The sidebar thread list used to be built into `apps/app`, and client-core held its model. In the private history (`$ARCHIVED_OMNYO_CHECKOUT`), commit `3bcba17f36` (2026-09-21) deleted the built-in thread list, `db500967a4` (2026-09-22) made the Thread list plugin forkable, and `2f004d573d` (2026-10-09) finished the move. The last app consumer of `buildChronologicalThreadList`, the mobile Recent list, was removed in `39b8e8fcf3` (2026-11-07). The model now lives in `plugins/thread-list/app/model/*`.

*Observed: the orphaned modules (Proven by inspection).*

| File | Lines | Exports |
|---|---|---|
| `packages/client-core/src/sidebar/sectionKeys.ts` | 17 | `buildSectionKey`, `sectionKeyForThreadSection` |
| `packages/client-core/src/sidebar/machineThreadGroups.ts` | 1 | `NO_MACHINE_GROUP_KEY` |
| `packages/client-core/src/sidebar/sidebarSectionId.ts` | 8 | `SidebarSectionId`, `CollapsibleSidebarSectionId` |
| `packages/client-core/src/sidebar/sidebarSectionOrder.ts` | 112 | `LegacySidebarEntityAnchor`, `buildSidebarEntitySectionId`, `normalizeSidebarSectionOrder` |
| `packages/client-core/src/sidebar/pinnedSidebarThreads.ts` | 74 | `buildPinnedSidebarState` |
| `packages/client-core/src/sidebar/projectThreadGroups.ts` | 226 | `ProjectThreadNode`, `SidebarSectionDefinition`, `ProjectThreadItem`, `CHRONOLOGICAL_CONTAINER_ID`, `ThreadComparator`, `getProjectThreadItemDescendants`, `resolveSidebarProjectId`, `buildChronologicalThreadList` (all dead) and `isSidebarProjectThread` at line 222 (live) |
| `packages/client-core/src/thread/thread-activity.ts` | 65 | dead: `CollapsedChildActivity` (line 30), `EMPTY_DRAFT_THREAD_IDS` (38), `getCollapsedChildActivity` (40), `isUnreadThread` (63), the private type `ThreadReadShape` (18). Live: `threadListIndicatorStateForThread` (23) and the domain re-exports (lines 10-16) |

`packages/client-core/src/index.ts` re-exports the sidebar files at lines 11, 13, 15, 17, 21 and 23, and `thread/thread-activity.js` at line 5.

*Observed: the consumer search (Proven by inspection).* For each symbol above, this command ran over the whole extracted snapshot, including docs, scripts, tests, configs and hidden files:

```
rg -lw --hidden "<symbol>" . -g '!plugins/thread-list/**' -g '!packages/client-core/src/sidebar/**'
```

Results:

- `NO_MACHINE_GROUP_KEY`, `buildSectionKey`, `sectionKeyForThreadSection`, `SidebarSectionId`, `CollapsibleSidebarSectionId`, `LegacySidebarEntityAnchor`, `SidebarSectionDefinition`, `CHRONOLOGICAL_CONTAINER_ID` and `getProjectThreadItemDescendants` have no hits at all.
- `buildSidebarEntitySectionId` and `normalizeSidebarSectionOrder` appear only in `packages/client-core/test/sidebarSectionOrder.test.ts`.
- `buildPinnedSidebarState` appears only in `packages/client-core/test/pinnedSidebarThreads.test.ts`.
- `ProjectThreadNode`, `ProjectThreadItem`, `ThreadComparator`, `resolveSidebarProjectId` and `buildChronologicalThreadList` appear only in `packages/client-core/test/projectThreadGroups.test.ts`.
- `getCollapsedChildActivity` and `isUnreadThread` appear only in `thread-activity.ts` itself and in `packages/client-core/test/thread-activity.test.ts`. `CollapsedChildActivity` and `EMPTY_DRAFT_THREAD_IDS` appear only in `thread-activity.ts`. Within `src/sidebar`, the only user of these symbols is the dead `projectThreadGroups.ts` (lines 2-5).
- These symbols are live and must stay:
  - `isSidebarProjectThread` is used by `apps/app/src/components/layout/faviconAttentionDot.ts:2` in `isUnreadSidebarThread` and `isPendingSidebarThread`.
  - `threadListIndicatorStateForThread` is used by `apps/app/src/lib/plugin-sidebar-threads.ts`, `apps/app/src/components/secondary-panel/info/RelatedThreadsSection.tsx`, `apps/app/src/components/commands/ThreadSearchPaletteMode.tsx` and `apps/app/src/components/sidebar/railAttention.test.ts`.
  - `isThreadRead` is used by four apps/app files and by `sidebar/threadReadState.ts`.
  - `getThreadReadToggleAction` (`sidebar/threadReadState.ts`) is used by `apps/app/src/components/thread/ThreadActionsProvider.tsx`.
  - `applyNeighborReorder` (`sidebar/neighbor-reorder.ts`) is used by `apps/app/src/lib/queued-message-reorder.ts`.
- Plugins: `rg -l '@omnyo/client-core' plugins` returns nothing. Every same-named symbol under `plugins/thread-list` is a plugin-local definition in `plugins/thread-list/app/model/*`, imported by relative path (for example `plugins/thread-list/app/list/ProjectList.tsx:52` imports `getCollapsedChildActivity` from `../model/thread-activity.js`).
- Path and string references: searching for `client-core/src/sidebar`, the six file names and `thread-activity` finds only `packages/client-core/src/index.ts`, the client-core tests and the plugin's own relative imports. Non-TypeScript files that mention `client-core` (`turbo.json:32`, `scripts/plan-ci.mjs:142`, `apps/app/bundle-budget.json:120`, `docs/api_to_audit.md:5252`, `packages/scripts/test/plugin-forks.test.mjs`) address the package or its directory as a whole, never these modules.
- The repository has no knip-style unused-export allowlist that would need an update.
- `packages/client-core/test/no-dom.test.ts` lists `src` dynamically, so deleting source files needs no change there.

*Observed: the plugin copies have diverged.* `diff` line counts (lines starting with `<` or `>`) between each client-core file and its plugin copy:

| client-core file | Plugin copy | Changed lines | Plugin copy size |
|---|---|---|---|
| `sidebarSectionOrder.ts` | `sidebar-section-order.ts` | 79 | 185 lines |
| `pinnedSidebarThreads.ts` | `pinned-sidebar-threads.ts` | 110 | 174 lines |
| `projectThreadGroups.ts` | `project-thread-groups.ts` | 867 | 997 lines |
| `machineThreadGroups.ts` | `machine-thread-groups.ts` | 64 | 65 lines |
| `sidebarSectionId.ts` | `sidebar-section-id.ts` | 11 | 13 lines |
| `thread-activity.ts` | `thread-activity.ts` | 194 | n/a |
| `sectionKeys.ts` | `section-keys.ts` | 0 (byte-identical) | 17 lines |

The byte-identical pair is also listed in `duplicate-files.txt` (line 31). For example, the plugin's `sidebar-section-id.ts` adds `"shelf"` to `CollapsibleSidebarSectionId`, and `sidebar-section-order.ts` adds `reorderSidebarSectionOrder` and `insertSidebarSectionAfter`. The client-core copy therefore encodes older semantics that no running code uses.

*Counterevidence considered.*

- Could an external or older client import these symbols? No. The package is private, never published, and absent from the plugin SDK. The plugin fork rules forbid plugins from depending on it.
- Is persisted data involved? No. The section-order strings are normalized, persisted and read only by the plugin copy.
- Does deleting the tests lose unique coverage? No live function loses coverage.
  - The deleted test cases exercise only the dead copies.
  - The live `isThreadRead`, which `isUnreadThread` wraps, stays covered through `packages/client-core/test/threadReadState.test.ts`.
  - The live plugin copies keep their own tests: `plugins/thread-list/app/model/{pinned-sidebar-threads,project-thread-groups,sidebar-section-order,thread-activity}.test.ts`.

*Maintenance cost today.* There are two implementations of the same rules, each with its own green tests, and only the plugin copy is live. A reader looking for section-order normalization, pinned-descendant expansion or collapsed-child badge activity can edit the client-core copy, see its tests pass, and change nothing in the product. In addition, about 564 test lines run on every `@omnyo/client-core#test` pass to check code that never runs.

**Proposed end state and preservation argument**

*What disappears.*

- These five files: `packages/client-core/src/sidebar/{sectionKeys,machineThreadGroups,sidebarSectionId,sidebarSectionOrder,pinnedSidebarThreads}.ts`.
- Everything in `projectThreadGroups.ts` except `isSidebarProjectThread` and its `SidebarProjectThreadShape` type.
- In `thread-activity.ts`: `ThreadReadShape`, `CollapsedChildActivity`, `EMPTY_DRAFT_THREAD_IDS`, `getCollapsedChildActivity`, `isUnreadThread`, and the imports that only these symbols used.
- The matching `export *` lines in `index.ts`.
- These test files: `packages/client-core/test/{pinnedSidebarThreads,projectThreadGroups,sidebarSectionOrder}.test.ts`.
- Two cases in `packages/client-core/test/thread-activity.test.ts`.

*What remains.*

- In `packages/client-core/src/sidebar/`: `neighbor-reorder.ts`, `threadReadState.ts`, and a file holding only `isSidebarProjectThread`. The recommended name for that file is `sidebarProjectThread.ts`, so that no file called "projectThreadGroups" survives without any groups in it.
- In `thread/thread-activity.ts`: `threadListIndicatorStateForThread` and the `@omnyo/domain` re-exports.
- `apps/app` keeps importing `isSidebarProjectThread` from `@omnyo/client-core` unchanged.
- The Thread list plugin (`plugins/thread-list/app/model`) is the single owner of the sidebar model.

*Why current semantics survive.* No running code path calls any deleted symbol (see the search above). `isSidebarProjectThread` keeps its exact body (`thread.visibility !== "hidden"`), its signature and its package-root export, so `faviconAttentionDot.ts` behaves identically. No UI state, API, route, setting key or persisted format changes.

*Why this is the simplest sufficient option.* Merging the two copies is not allowed: plugins must stay forkable. Keeping the client-core copy has no consumer to serve. Deletion is the only option that removes the second definition.

*Non-goals.*

- Changing the plugin copies, including the byte-identical `section-keys.ts`, which the fork rule requires.
- Moving `threadReadState.ts`, `neighbor-reorder.ts`, `panel/array-move.ts` or `codepoint-compare.ts`.
- The host `sidebar.*` preferences, which belong to RF-035.

*Remaining uncertainty.* An uncommitted local edit in another agent's checkout could start importing one of these symbols after the snapshot. Step 1 below re-runs the search on the current branch to catch that.

**Expected gain and cost**

Measured at the snapshot with a Python line counter over the exact line ranges listed in step 3:

| Item | Physical lines | Non-blank lines |
|---|---|---|
| Five deleted sidebar files | 212 | 173 |
| `projectThreadGroups.ts` (lines 2-32 and 37-221 removed) | 216 | 177 |
| `thread-activity.ts` (imports plus lines 18-22 and 29-65) | 46 | 40 |
| `index.ts` (5 export lines and their blank separators) | about 10 | 5 |
| **Production total** | **about 484** | **about 395** |
| Tests: `pinnedSidebarThreads.test.ts` 88, `projectThreadGroups.test.ts` 381, `sidebarSectionOrder.test.ts` 68, `thread-activity.test.ts` cases and imports about 27 | about 564 | about 507 |

Additions: none if the predicate stays in place. If it is renamed, the change adds no lines: one file move and one changed `index.ts` line.

What gets easier: one definition of each sidebar rule instead of two. Searches for sidebar model symbols land only in the plugin, and the client-core test run no longer checks dead code.

Performance: no runtime effect is expected. This is a projection. The code never executes, and `"sideEffects": false` already lets bundlers drop it. The client-core typecheck and tests should get slightly faster, but that was not measured.

**Execution steps**

1. **Reconfirm the baseline.**
   - From the repository root, on a clean branch in your own worktree, run `rg -lw "<symbol>" . -g '!plugins/thread-list/**' -g '!packages/client-core/src/sidebar/**' -g '!node_modules'` for each deleted symbol.
     - Expected hits: only `packages/client-core/test/*` and `packages/client-core/src/thread/thread-activity.ts`.
   - Confirm that `isSidebarProjectThread` is still imported only by `apps/app/src/components/layout/faviconAttentionDot.ts`.
   - Confirm that `rg -l '@omnyo/client-core' plugins` is still empty.
   - **Re-plan if** a new production importer of a deleted symbol appears outside the plugin, if a plugin now depends on client-core, or if `@omnyo/client-core` stops being private or gains a published export.

2. **Behavioral evidence.** No new tests are needed. The change is a pure deletion with a compile-time safety net. The live plugin copies keep their own tests.

3. **Edit `packages/client-core/src/thread/thread-activity.ts`.**
   - Delete `type ThreadReadShape` (lines 18-21) and everything from `export interface CollapsedChildActivity` through the end of `isUnreadThread` (lines 30-65).
   - In the first import, drop `strongestThreadWorkSummary`, `type Thread` and `type ThreadWorkSummary`. Keep `type ThreadListIndicatorState` and `type ThreadListEntry`.
   - Delete `import { isThreadRead } from "./thread-read-state.js";` (line 8).
   - Leave the `export { resolveThreadListIndicator, getThreadListIndicatorLabel, strongestThreadWorkSummary, ... } from "@omnyo/domain"` block (lines 10-16) unchanged. It is a separate re-export that live callers rely on.
   - End state: the domain re-export, the two type imports and `threadListIndicatorStateForThread`.

4. **Edit `packages/client-core/src/sidebar/projectThreadGroups.ts`.**
   - Delete lines 2-32 and 37-221. That removes the `thread-activity` import, `ProjectThreadNodeStats`, `ProjectThreadNode`, `SidebarSectionDefinition`, `ProjectThreadItem`, `CHRONOLOGICAL_CONTAINER_ID`, `ThreadComparator`, `BuildThreadNodeArgs` and every function except `isSidebarProjectThread`.
   - The file keeps:
     ```ts
     import type { ThreadListEntry } from "@omnyo/domain";

     type SidebarProjectThreadShape = Pick<ThreadListEntry, "originKind" | "visibility">;

     export function isSidebarProjectThread(thread: SidebarProjectThreadShape): boolean {
       return thread.visibility !== "hidden";
     }
     ```
   - Recommended: `git mv` the file to `packages/client-core/src/sidebar/sidebarProjectThread.ts` and change `index.ts` line 13 to `export * from "./sidebar/sidebarProjectThread.js";`.

5. **Delete these five files:** `packages/client-core/src/sidebar/sectionKeys.ts`, `machineThreadGroups.ts`, `sidebarSectionId.ts`, `sidebarSectionOrder.ts` and `pinnedSidebarThreads.ts`.
   - In `packages/client-core/src/index.ts`, remove the `export *` lines for them (lines 11, 15, 17, 21 and 23) and their blank separators.
   - Keep lines 5, 13 (updated if the file was renamed), 19 and 25.

6. **Update the tests.**
   - Delete `packages/client-core/test/pinnedSidebarThreads.test.ts`, `projectThreadGroups.test.ts` and `sidebarSectionOrder.test.ts`.
   - In `packages/client-core/test/thread-activity.test.ts`:
     - Remove `getCollapsedChildActivity` and `isUnreadThread` from the import (lines 5-6).
     - Delete the case "retains concurrent summaries when collapsed and decorates drafts independently" (lines 47-59).
     - Delete the case "keeps unread decoration independent of work and child ownership" (lines 80-91).
     - Keep the `experimental_threadIndicatorCases` table, "reading changes neither Working nor required attention" and "does not infer work from raw activity when a legacy summary is unavailable". They cover the live `threadListIndicatorStateForThread` and `resolveThreadListIndicator`.
   - **Checkpoint:** run the client-core typecheck and tests (see below) before touching anything else.

7. **Format and inspect.**
   - Run `pnpm exec oxfmt` on the changed files from the repository root.
   - Run `pnpm exec oxlint --deny-warnings` on the changed `packages/client-core` files. Client-core has no `lint` script of its own; the root `.oxlintrc.json` applies.
   - Review `git diff --stat`. The diff should touch only `packages/client-core/src/{index.ts,thread/thread-activity.ts,sidebar/*}` and `packages/client-core/test/*`.
   - Recount the removed lines against the table above.

**Verification and acceptance criteria**

The package scripts below were read from the snapshot's `package.json` files. They could not be run during this audit because the snapshot has no `node_modules`.

- `pnpm --filter @omnyo/client-core typecheck` (from the repository root; runs `tsc --noEmit` over `src` and `test`). Expected: passes.
- `pnpm --filter @omnyo/client-core test` (runs `vitest run --config vitest.config.ts`). Expected: passes. `no-dom.test.ts` lists the remaining source files automatically.
- `pnpm --filter @omnyo/app typecheck`, `pnpm --filter @omnyo/mobile typecheck`, `pnpm --filter @omnyo/cli typecheck` and `pnpm --filter @omnyo/server typecheck`. These are every dependent of client-core, and each script exists in its `package.json`. Expected: all pass. A missed importer would fail here as "has no exported member".
- Optional targeted runtime check: `pnpm --filter @omnyo/app test -- faviconAttentionDot`. `apps/app/src/components/layout/faviconAttentionDot.test.ts` exists at the snapshot, but passing a file filter through to vitest this way was not run. The predicate body does not change.
- The Thread list plugin is not touched, so its tests do not need to run.
- UI: no UI changes, so no visual comparison is needed.
- Structural completion:
  - `rg -w 'normalizeSidebarSectionOrder|buildPinnedSidebarState|buildChronologicalThreadList|getCollapsedChildActivity|isUnreadThread|NO_MACHINE_GROUP_KEY|buildSectionKey' packages apps -g '!node_modules'` returns no hits.
  - The same names still resolve under `plugins/thread-list/app/model`.
  - `packages/client-core/src/sidebar/` holds only `neighbor-reorder.ts`, `threadReadState.ts` and the predicate file.

**Rollback and stop conditions**

- **Rollback.** Revert the single commit. Nothing is persisted, no data is migrated and no runtime state changes, so a revert is complete and safe.
- **Stop if any of these happens:**
  - Step 1 finds a production importer outside `plugins/thread-list`. Keep that symbol, and re-scope the card to the rest.
  - A dependent's typecheck fails on a deleted symbol that step 1 missed. That points to an importer the search did not cover; investigate it before forcing the change.
  - Alex decides that client-core should become the shared home for a future second sidebar consumer. Even then, the diverged copy would be the wrong base: the plugin copy is the current one.
- **Safer smaller alternative:** delete only the five whole files and their index lines (about 222 lines) and leave `projectThreadGroups.ts` and `thread-activity.ts` for a follow-up.
