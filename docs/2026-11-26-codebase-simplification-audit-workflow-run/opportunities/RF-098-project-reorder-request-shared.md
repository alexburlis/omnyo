# RF-098 — One project reorder request builder (and, optionally, one optimistic-order hook) for Settings and the project rail

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real. The sweep called the two builders "byte-identical". They are identical apart from their names and one `export` keyword, and the card's line estimate is split into a required core and an optional second checkpoint.
- **Potential:** low. This removes one of two encodings of the server's anchor-based reorder rule, plus, optionally, a second copy of the optimistic-order overlay and its rollback wiring.
- **Confidence:** high for the core change. Medium for the optional hook, because the two surfaces reset their optimistic order on different signals, and the hook must keep both.
- **Readiness:** ready for checkpoint 1. Checkpoint 2 is ready only under the preservation rule in this card: each caller keeps its own reset key.
- **Effort:** small. About one to two hours for checkpoint 1, and two more hours for checkpoint 2, including moved tests.
- **Risk:** low. The change is confined to `apps/app`. The data involved is in-memory React state; nothing is persisted.
- **Prerequisites:** none.
- **Related or overlapping:** RF-081 ("One hold-and-reapply primitive for optimistic overlays across server refetches") covers TanStack Query cache overlays for thread data. It does not touch these component-local `useState` overlays, so the two cards do not overlap. RF-035 leaves `sidebar.hiddenGroups` and `projectRailPreferences.ts:7-8` untouched, and this card does not touch them either.
- **Why it deserves its place:** both surfaces call the same `projects.reorder` API with the same neighbour-anchor contract. Today the anchor rule is written down twice, and so is the rollback. A contract change would have to be made in two places that nothing keeps in step. The change is small, but so is its cost.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The named snapshot worktree was no longer on disk, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`. The snapshot has no `node_modules`, so no tests were run.

Subsystem in plain language: users can reorder projects in two places, by dragging rows in Settings → Projects and by dragging or keyboard-moving tiles in the sidebar project rail. Both send `{ id, previousProjectId, nextProjectId }` to `useReorderProject` (`apps/app/src/hooks/mutations/project-mutations.ts:85` "useReorderProject"). That hook calls `sdk.projects.reorder` and invalidates the project lists on success. It does no optimistic cache update of its own. The server contract is `packages/server-contract/src/api/projects.ts:129` (`previousProjectId: z.string().min(1).nullable()`). The database applies it at `packages/db/src/data/projects.ts:439-485`.

Observed facts (Proven by inspection):

1. **Duplicate builder.** `apps/app/src/components/settings/ProjectsSettingsSection.tsx:61-84` (interface `ProjectReorderRequest`, function `buildProjectReorderRequest`) and `apps/app/src/components/sidebar/projectRailPreferences.ts:107-130` (exported interface `RailProjectReorder`, function `railProjectReorder`) are 24 lines each. After renaming the symbols and removing `export`, `cmp` reports the two copies identical. Each copy does the same thing: it returns `null` for a same-row drop or an unknown id, applies `arrayMove`, and takes the neighbours at the target index. Each file imports `arrayMove` from `@dnd-kit/sortable` for this one purpose (`ProjectsSettingsSection.tsx:4`, `projectRailPreferences.ts:3`).
2. **Duplicate optimistic overlay.** Settings: `ProjectsSettingsSection.tsx:247-266` (`optimisticOrder` state, a reset `useEffect` keyed on `serverProjects`, and a `useMemo` merge). Rail: `apps/app/src/components/sidebar/ProjectRail.tsx:813-837` "useOrderedRailEntries" (state, a reset `useEffect` keyed on `serverOrderKey`, and a `useMemo` merge). Both merge rules are the same: optimistic ids first through a `byId` map, then any server entries the optimistic order has not seen.
3. **Duplicate mutate-and-rollback wiring.** Settings `handleReorder` at `ProjectsSettingsSection.tsx:285-298` and rail `reorder` at `ProjectRail.tsx:887-909` both do `setOptimisticOrder(request.order); reorderProject.mutate({ id: activeId, previousProjectId, nextProjectId }, { onError: () => setOptimisticOrder(null) })`.
4. **Differences that must survive.**
   - The reset signal differs. Settings resets when the `sidebarNavigationQuery.data?.projects` reference changes (line 250-252). The rail resets only when the joined id order changes (`serverOrderKey`, lines 817-821). The rail's `entries` prop is a derived array, so a reference key would reset it on every render. A shared hook must therefore accept the reset key from its caller.
   - The pending policy differs. The rail ignores moves while a reorder is in flight (`ProjectRail.tsx:888`). Settings disables dragging instead (`dragDisabled`, line 283, used at lines 333 and 341).
   - The rail alone sets a screen-reader announcement from `request.order` (`moveAnnouncement`, lines 839-848, called at lines 898-900). It computes the request from `orderedProjectIds` (line 877), which includes hidden projects.
   - Settings may have no data yet: `projects === undefined` drives the loading state at line 323.
5. **Consumers.** `git -C $OMNYO_CHECKOUT grep -n -E 'buildProjectReorderRequest|railProjectReorder|RailProjectReorder|ProjectReorderRequest|previousProjectId' e9e1b74c3 -- . ':!*.md'` found the two builders and their callers; `ProjectsSettingsSection.test.tsx:18, 229-260` (direct unit tests of `buildProjectReorderRequest`); `ProjectRail.test.tsx` lines 664-760 (UI tests that assert the `reorder` SDK payload); and unrelated forwarders in the CLI (`apps/cli/src/commands/project.ts:506`), server route, SDK (`packages/sdk/src/areas/projects.ts:738`), database and server tests. `projectRailPreferences` is imported only by `ProjectRail.tsx` and `ProjectRail.test.tsx`. Neither builder is part of the SDK or plugin SDK, a plugin, the CLI, desktop, mobile or persisted data. That search covered the whole snapshot tree, excluding Markdown.
6. **Not the same contract.** Other `arrayMove` callers in `apps/app/src` (`plugin-detail-navigation.tsx:300`, `QueuedMessagesList.tsx:389`, `sidebarSplitLayout.ts:504`, `ProvidersSettingsSection.tsx:84`, `lib/stored-order.ts:73`) build different requests. Folding them in is out of scope (see the rejected expansion below).

Maintenance cost today: if the reorder API changes, say to an index or a single anchor, someone must change two builders, two call sites and two rollback paths, and the two copies can drift without any test noticing. The direct unit tests cover only the Settings copy. The rail copy is tested only through UI tests.

**Proposed end state and preservation argument**

Checkpoint 1 (required):

- A new module, `apps/app/src/lib/project-reorder.ts`, owns `export interface ProjectReorderRequest { order: string[]; previousProjectId: string | null; nextProjectId: string | null }` and `export function projectReorderRequest(ids: readonly string[], activeId: string, overId: string): ProjectReorderRequest | null`. Its body is the current one, unchanged.
- `ProjectsSettingsSection.tsx` and `ProjectRail.tsx` import that module. `buildProjectReorderRequest`, `railProjectReorder`, `RailProjectReorder` and the two `arrayMove` imports disappear.
- The direct unit tests move unchanged, apart from the function name, from `ProjectsSettingsSection.test.tsx:229-260` to `apps/app/src/lib/project-reorder.test.ts`.

A neutral `lib` module is the simplest sufficient owner. `projectRailPreferences.ts` is named for the rail, and Settings would otherwise depend on a rail file for a project-wide rule. `apps/app/src/lib/queued-message-reorder.ts` is the existing precedent for this kind of reorder-request module.

Checkpoint 2 (optional, separate commit): the hook `apps/app/src/hooks/useProjectReorder.ts`:

```ts
export function useProjectReorder<TEntry>(args: {
  entries: readonly TEntry[] | undefined;
  getId: (entry: TEntry) => string;   // must be module-level or stable
  resetKey: unknown;                  // caller-owned reset signal
}): {
  ordered: readonly TEntry[] | undefined; // undefined iff entries is undefined
  isPending: boolean;                     // reorderProject.isPending
  reorder: (ids: readonly string[], activeId: string, overId: string)
    => ProjectReorderRequest | null;      // builds, sets optimistic order, mutates with onError rollback
};
```

The hook owns the `useReorderProject()` call, the `optimisticOrder` state, the reset effect (`useEffect(() => set(null), [resetKey])`), the merge `useMemo` and the mutate-with-rollback. Settings passes `resetKey: serverProjects` and keeps `dragDisabled = isPending || projectIds.length < 2`. The rail passes `resetKey: serverOrderKey`, keeps `if (isPending) return;` before calling `reorder`, and sets its announcement from the returned request. `useOrderedRailEntries` and the Settings overlay block disappear.

Why behaviour survives:

- The builder body is moved verbatim, so the payload and the optimistic order are unchanged.
- The reset semantics stay per caller through `resetKey`. Settings keeps its reference-change reset, and the rail keeps its order-key reset.
- Both pending policies stay at their call sites.
- The rail's announcement still uses `request.order`, and React batches all three state updates inside the one event handler, so moving the mutate call into the hook does not change what the user sees.
- The `undefined` loading state in Settings is passed through.

Non-goals: no change to the reorder API, to `useReorderProject`, to the hidden-project rules, to drag-and-drop sensors, to the announcement text, or to which surface disables or ignores input while a move is pending. This card does not unify the two reset signals. Doing so would change Settings or rail behaviour and would need its own decision.

**Expected gain and cost**

Counts were taken by inspecting line ranges at the snapshot (`sed -n <range>p | rg -c -v '^\s*$'` for the non-blank counts). They are projections, not measured diffs.

| Item | Before | After | Net production lines |
|---|---|---|---|
| Builder and interface | 2 × 24 lines in two components | 24 lines, plus about 2 lines of header in `lib/project-reorder.ts` | about −22 |
| `arrayMove` and helper imports | 2 `arrayMove` imports | 1 import in the new module, and 1 changed import line in each caller | about −1 |
| Optimistic overlay (checkpoint 2) | Settings 247-266 (20 lines) and rail 813-837 (25 lines) | one hook of about 40 lines, including the mutate wiring | about −10 to −15 |
| Mutate-and-rollback wiring (checkpoint 2) | Settings 285-298 (14 lines) and rail 887-909 (23 lines, of which about 7 are announcement and name lookup) | about 4 lines in Settings and about 12 in the rail | (included above) |

- **Checkpoint 1:** about 20-23 production lines net. One encoding of the anchor rule disappears.
- **Checkpoints 1 and 2:** about 30-38 production lines net. There is then one owner each for the anchor rule, the optimistic-order merge and the rollback.
- **Tests:** about 30 test lines move from `ProjectsSettingsSection.test.tsx` into `lib/project-reorder.test.ts`. That is moved code, not deleted code.
- **Cost:** checkpoint 2 adds a generic hook with a `resetKey` parameter that readers must understand.
- **Performance:** neutral by construction. The same memos, effects and mutation run. No measurement was taken.

**Execution steps**

1. **Reconfirm.**
   - Run `git -C $OMNYO_CHECKOUT grep -n -E 'buildProjectReorderRequest|railProjectReorder|RailProjectReorder|ProjectReorderRequest' HEAD -- apps packages plugins`.
   - Confirm that the two builders are still identical and that no third consumer has appeared.
   - If either builder has diverged, for example a rail-only rule about hidden or Personal projects, stop and re-plan. The shared function would then need a parameter or would not be shareable.
2. **Checkpoint 1: share the builder.**
   1. Create `apps/app/src/lib/project-reorder.ts` with `import { arrayMove } from "@dnd-kit/sortable";`, the exported `ProjectReorderRequest` interface and `projectReorderRequest`, using the current body unchanged.
   2. In `ProjectsSettingsSection.tsx`, delete lines 61-84 and the `arrayMove` import at line 4, add `import { projectReorderRequest } from "@/lib/project-reorder";`, and change line 286 to call `projectReorderRequest`.
   3. In `projectRailPreferences.ts`, delete lines 107-130 and the `arrayMove` import at line 3. In `ProjectRail.tsx`, remove `railProjectReorder` from the import at lines 68-75, import `projectReorderRequest` from `@/lib/project-reorder`, and change line 889.
   4. Move the `describe("buildProjectReorderRequest", …)` block at `ProjectsSettingsSection.test.tsx:229-260` into a new `apps/app/src/lib/project-reorder.test.ts`, renaming only the function, and drop `buildProjectReorderRequest` from the import at line 18. Keep every assertion.
   5. Run typecheck, the three test files and lint (see below). Commit.
3. **Checkpoint 2 (optional): share the overlay and the wiring.**
   1. Create `apps/app/src/hooks/useProjectReorder.ts` with the signature above. Copy the merge rule exactly: `[...optimistic.flatMap((id) => byId.get(id) ?? []), ...entries.filter((e) => !seen.has(getId(e)))]`. Return `entries` unchanged when no optimistic order exists, and `undefined` when `entries` is `undefined`.
   2. In Settings, replace lines 238 and 247-266 with `const { ordered: projects, isPending, reorder } = useProjectReorder({ entries: serverProjects, getId: projectIdOf, resetKey: serverProjects });`, where `projectIdOf` is a module-level `(p) => p.id`. Set `dragDisabled = isPending || projectIds.length < 2`, and make `handleReorder` call `reorder(projectIds, activeId, overId)`.
   3. In the rail, delete `useOrderedRailEntries` (lines 813-837) and the `useReorderProject` import at line 62. Inside `ProjectRailTiles`, compute `serverOrderKey` as today and call the hook with `getId: railEntryIdOf` (module level) and `resetKey: serverOrderKey`. In `reorder`, keep `if (isPending) return;`, look up the moved project's name only after a non-null request, and call `setAnnouncement(moveAnnouncement(name, request.order, new Set(sortableIds), activeId))`.
   4. Check that `useReorderProject` is no longer imported by either component, and that each surface keeps its own pending policy and reset key.
   5. Run the same checks. Commit separately.
4. **Clean up and recount.**
   - Make sure no references to `railProjectReorder` or `buildProjectReorderRequest` remain (run the same `git grep`).
   - Run `git diff --stat` and confirm that only the files named here changed.
   - Recount the net production lines against step 1.

**Verification and acceptance criteria**

Commands exist in the snapshot's `apps/app/package.json` (`test`: `vitest run --config vitest.config.ts`; `typecheck`; `lint`: `oxlint src …`) and root `package.json` (`format:check`: `oxfmt . --check`). They were not run for this card, because the snapshot has no `node_modules`.

- `cd apps/app && pnpm exec vitest run --config vitest.config.ts src/lib/project-reorder.test.ts src/components/settings/ProjectsSettingsSection.test.tsx src/components/sidebar/ProjectRail.test.tsx`. All tests must pass, with no edited expectations. These cover:
  - the four moved builder cases: move down, move to the top, move to the bottom, and same or unknown ids;
  - the `ProjectRail arrangement` suite at `ProjectRail.test.tsx:664-760`, which checks the `reorder` SDK payloads, "keeps Personal last", the "Moved web to position 1 of 5" announcement, Alt+Arrow moves, and that the rail "restores the order when saving fails". That last test is the onError rollback.
- `cd apps/app && pnpm typecheck`.
- `cd apps/app && pnpm lint`, then `pnpm exec oxfmt <changed files>` from the repository root, and `pnpm format:check`.
- Settings rollback has no direct test today. If checkpoint 2 lands, add one focused test to `ProjectsSettingsSection.test.tsx`. It should make `sdk.projects.reorder` reject (the file already mocks `@/lib/sdk`), trigger `handleReorder` through the sortable list's keyboard path, and assert that the original row order returns. If the drag path cannot be driven in jsdom, test the hook directly with `renderHook` and both `resetKey` behaviours:
  - a reference change resets the order;
  - an unchanged order key keeps the optimistic order.
- Manual UI check (Alex tests UI): drag a project in Settings → Projects and in the rail, then confirm that each surface's order updates at once and survives the refetch. Also confirm that a move made while offline snaps back on both surfaces.
- Structural completion:
  - Exactly one definition of the anchor rule remains (`git grep -n 'arrayMove(\[...ids\], from, to)' -- apps/app/src` returns only `lib/project-reorder.ts`).
  - After checkpoint 2, exactly one `optimisticOrder` state for projects remains, in `useProjectReorder.ts`.

**Rollback and stop conditions**

- Each checkpoint is one self-contained commit inside `apps/app`, with no persisted data or API change. Reverting the commit restores the previous state.
- Stop if the two builders have diverged when you reconfirm, or if the reorder contract changes in flight.
- Stop if a third caller needs a different anchor rule. Then share only what is truly common, or keep the copies.
- Stop checkpoint 2 if keeping both reset signals and both pending policies would make the hook take more than the three parameters above. Ship checkpoint 1 alone; it is the safer smaller alternative.
- Do not unify the reset keys as part of this card.

Rejected expansion (recorded so later agents do not repeat it): a generic "neighbour reorder request" builder shared with queued messages (`lib/queued-message-reorder.ts`, `QueuedMessagesList.tsx:389`), plugin navigation (`plugin-detail-navigation.tsx:300`), providers (`ProvidersSettingsSection.tsx:84`) and split layouts (`sidebarSplitLayout.ts:504`). Those callers send different request shapes, such as group boundaries, whole orders or tab moves, so one builder would add parameters without removing a mechanism.
