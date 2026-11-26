# RF-090 — Give the split-layout tree schema one owner: a `createSplitLayoutSchema(contentSchema)` factory used by the workspace split and the right-panel sidebar split

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and exactly as the sweep described, but the removable code is larger than the sweep estimated (about 70 sidebar lines disappear instead of the estimated 35 to 50 net), and the plan needs one typed factory signature and one nested-tree test fixture that the sweep did not name.
- **Potential:** low. It removes one duplicated definition of a persisted-data contract, about 60 net handwritten production lines and five never-surfaced error strings. It does not remove a subsystem.
- **Confidence:** high. Both schemas were compared clause by clause (Proven by inspection). Acceptance of stored data stays the same for every input.
- **Readiness:** ready. No owner decision is needed, because no supported behavior, persisted format or UI changes.
- **Effort:** S, about 1 to 2 hours including the added test fixture.
- **Risk:** low. The only realistic regression is a stored layout that is accepted or rejected differently after the change. Existing tests in both files cover each invariant, and one nested-split fixture closes the remaining gap.
- **Prerequisites:** none.
- **Related or overlapping opportunities:** none directly. RF-022 (derive persisted fixed-panel tab types from zod schemas) and RF-040 (retire plugin-local BB-to-Omnyo storage imports) touch neighbouring persistence code but not these schemas. `apps/app/src/lib/legacy-browser-preferences.ts:45` "sidebarSplitLayout" rewrites the legacy `bb-secondary-panel-split` plugin id to `omnyo-secondary-panel-split` in stored sidebar layouts. That migration depends on the sentinel id staying unchanged, which this plan keeps.
- **Why it deserves its place:** both split systems persist layout trees to `localStorage` and must reject corrupt data with the same tree rules. Today, changing `MAX_PANES` semantics, the size-normalization tolerance or the node shape means editing two schemas that must agree, and nothing checks that they do. The change is cheap, safe and leaves one owner.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree was no longer on disk when this card was written, so every file was read with `git show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>` from `$OMNYO_CHECKOUT`. No test, type check or build was run, because the snapshot has no installed dependencies.

The web app (`apps/app`, package `@omnyo/app`) has two split-pane systems that share one tree model, the `LayoutNode`, `PaneNode`, `SplitNode` and `SplitLayout` types in `apps/app/src/lib/split-layout/types.ts`, and the tree operations in `apps/app/src/lib/split-layout/ops.ts` (`MAX_PANES = 8` at line 11, `listPanes` at line 23, `countPanes` at line 31):

1. **The workspace split** (thread panes side by side). It is persisted under `omnyo.splitLayout` (`apps/app/src/lib/split-layout/persistence.ts:7` "SPLIT_LAYOUT_STORAGE_KEY") as `{ version: 1, layout }`. `apps/app/src/lib/split-layout/atoms.ts:19` parses it with `deserializeSplitLayout`.
2. **The right-panel sidebar split** (tab groups split inside the secondary panel). It is persisted per thread under `omnyo.thread.secondaryPanelSplitLayout.<panelStateId>` (`apps/app/src/components/secondary-panel/sidebarSplitLayout.ts:30`) as `{ version: 1, groups, layout, maximizedPaneId? }`. `apps/app/src/components/secondary-panel/SidebarSplitContainer.tsx:146` parses it with `parseSidebarSplitState`. Each sidebar pane's content is a sentinel `plugin-panel` value whose `pluginId` is `omnyo-secondary-panel-split` and whose `panelPath` is the tab-group id (`sidebarSplitLayout.ts:71` "groupContent").

Observed facts (Proven by inspection):

| Tree rule | Workspace, `split-layout/persistence.ts` | Sidebar, `secondary-panel/sidebarSplitLayout.ts` |
|---|---|---|
| Pane node is a strict `{ type: "pane", paneId: string(min 1), content }` | `paneNodeSchema`, lines 34-40 | `paneNodeSchema`, lines 897-903 |
| Split node is a strict `{ type: "split", dir: "row" \| "col", sizes: positive numbers, children: min 2 }` | `splitNodeSchema`, lines 46-53 | inline in `layoutNodeSchema`, lines 908-915; also has `sizes.min(2)`, which is redundant given the next rule |
| `sizes.length === children.length` | `superRefine`, lines 55-61 | `.refine`, line 916 |
| Each split's sizes sum to 1 within `1e-9` | `superRefine` per split node, lines 63-71 | recursive `hasNormalizedSplitSizes`, lines 920-928, with `NORMALIZED_SPLIT_SIZE_EPSILON = 1e-9` at line 37, called at lines 982-988 |
| Lazy recursive union of pane and split | `layoutNodeSchema`, lines 42-44 | `layoutNodeSchema`, lines 905-918 |
| Layout is a strict `{ root, focusedPaneId: string(min 1) }` | `splitLayoutSchema`, lines 74-79 | inline `layout` object, lines 943-948 |
| At most `MAX_PANES` panes | lines 83-89 (`countPanes`) | lines 958-964 (`listPanes(...).length`, same count) |
| The focused pane exists | lines 91-97 | lines 974-980 |
| Pane ids are unique | lines 99-105 | lines 966-972 |

Rules that only the sidebar has, which must stay in the sidebar: the sentinel content schema (`paneContentSchema`, lines 888-895, with `pluginId: z.literal(SIDEBAR_SPLIT_PLUGIN_ID)` and `subPath: z.literal("")`), the strict `groups` record (lines 933-942), optional nullable `maximizedPaneId` (line 949), and the group checks inside `sidebarSplitStateSchema`'s `superRefine`: each pane references one unique group (lines 990-1003), groups map one-to-one to panes (lines 1005-1014), group key equals group id (lines 1017-1023), and the active tab belongs to its group (lines 1025-1031). The transform that drops a stale `maximizedPaneId` (lines 1034-1044) also stays.

Both callers use `safeParse` and discard the issues: `persistence.ts:128-130` returns `null`, and `sidebarSplitLayout.ts:1115-1127` falls back to `createSidebarSplitState`. The error messages and issue paths are therefore never shown to a user or logged (Proven by inspection).

Search for other copies or consumers (run from `$OMNYO_CHECKOUT`):

- `git grep -n -E "must sum to 1|sizes must|NORMALIZED_SPLIT_SIZE_EPSILON|hasNormalizedSplitSizes|focusedPaneId: z\.|MAX_PANES" e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- . ':!*.md'` found tree validation only in these two files. All other `MAX_PANES` uses are runtime caps in UI and ops code.
- `git grep -n -E "sidebarSplitStateSchema|splitLayoutSchema|storedSplitLayoutSchema|layoutNodeSchema|paneNodeSchema" e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- .` found these names only in the two files. All of them are module-private. `persistence.ts` is re-exported through the `apps/app/src/lib/split-layout/index.ts` barrel, but only its exported functions and constants are visible.
- `git grep -n -E "omnyo\.splitLayout|secondaryPanelSplitLayout|deserializeSplitLayout|parseSidebarSplitState" e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e -- .` found no consumer outside `apps/app`. This covers the plugins, mobile, desktop, SDK and server. `legacy-browser-preferences.ts` only rewrites a string in stored JSON and does not validate the tree.
- These schemas are internal to the web app. They are not part of the SDK, the plugin SDK or any server contract.

Type compatibility: `apps/app/package.json:108` declares `zod ^4.3.6`, and the snapshot's `pnpm-lock.yaml` resolves `zod@4.6.7`. In that version, `ZodType<out Output, out Input, ...>` is declared covariant (`zod/v4/classic/schemas.d.ts:7` in the main checkout's installed copy). The sidebar's narrower content schema is therefore assignable to a `z.ZodType<PaneContent>` parameter (Proven by inspection of the declaration, not compiled).

Existing tests:

- `apps/app/src/lib/split-layout/persistence.test.ts:106` "rejects malformed JSON, unknown versions, and invalid layout invariants" covers bad root sizes, a missing focused pane and nine panes. It does not cover duplicate pane ids, a size-count mismatch or a non-normalized nested split.
- `apps/app/src/components/secondary-panel/sidebarSplitLayout.test.ts:256` "rejects persisted layouts that exceed the shared pane cap" and the `it.each` cases ending at about line 341, "falls back safely for $name", cover duplicate pane ids, duplicate group references, a stale focused pane, a group key that differs from its id, an orphan group and non-normalized root sizes. Lines 117 and 143 cover acceptance of valid v1 states with and without `maximizedPaneId`.

Maintenance cost today: the tree contract (node shapes, strictness, size rules, epsilon, pane cap, focus and uniqueness) lives in two places with different structure (`superRefine` per node versus a recursive helper) and different messages. A change to one, such as allowing a new `dir` or adjusting the tolerance, silently diverges from the other.

**Proposed end state and preservation argument**

What remains:

- `apps/app/src/lib/split-layout/persistence.ts` owns the tree rules through one exported factory:

  ```ts
  export function createSplitLayoutSchema(
    contentSchema: z.ZodType<PaneContent>,
  ): z.ZodType<SplitLayout> {
    const paneNodeSchema: z.ZodType<PaneNode> = z
      .object({ type: z.literal("pane"), paneId: z.string().min(1), content: contentSchema })
      .strict();
    const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
      z.union([paneNodeSchema, splitNodeSchema]),
    );
    const splitNodeSchema: z.ZodType<SplitNode> = /* existing lines 46-72, unchanged */;
    return /* existing splitLayoutSchema body, lines 74-106, unchanged */;
  }

  const splitLayoutSchema = createSplitLayoutSchema(paneContentSchema);
  ```

  The workspace `paneContentSchema` (lines 9-32), `storedSplitLayoutSchema`, `serializeSplitLayout` and `deserializeSplitLayout` stay as they are.
- `apps/app/src/components/secondary-panel/sidebarSplitLayout.ts` keeps its sentinel `paneContentSchema` and builds `layout: createSplitLayoutSchema(paneContentSchema)` inside `sidebarSplitStateSchema`. Its `superRefine` keeps only the group rules (unique group per pane, one-to-one groups, key equals id, active tab in group), and its transform stays unchanged.

What disappears from `sidebarSplitLayout.ts`: `NORMALIZED_SPLIT_SIZE_EPSILON` (line 37), `paneNodeSchema` (lines 897-903), `layoutNodeSchema` (lines 905-918), `hasNormalizedSplitSizes` (lines 920-928), the inline `layout` object (lines 943-948, which becomes one line), the `paneIds` local (line 954), and the pane-cap, uniqueness, focus and normalization checks (lines 958-988).

Why semantics survive (Proven by inspection, clause by clause):

- Pane and split node shapes, strictness, `dir` values, positive sizes and `children.min(2)` are identical in both schemas today.
- The sidebar's extra `sizes.min(2)` is implied by `children.min(2)` together with `sizes.length === children.length`, so dropping it accepts no new input.
- The workspace's per-split `superRefine` sum check visits every split node in the tree, which is exactly what the recursive `hasNormalizedSplitSizes` checks. The tolerance is `1e-9` in both, compared as `> 1e-9` reject versus `<= 1e-9` accept.
- `countPanes(root) > MAX_PANES` and `listPanes(root).length > MAX_PANES` count the same panes.
- Focus and uniqueness checks are identical.
- With the sentinel content schema passed in, any sidebar pane whose content is not the sentinel is still rejected, as it is today.
- The sidebar's group `superRefine` keeps running over structurally valid data: zod 4 skips refinements after non-continuable structural issues, and custom issues from the inner layout schema do not make the outer data unsafe for `listPanes` or `sidebarPaneGroupId`. In every case where any issue exists, `safeParse` still fails, so the accept or reject result is unchanged.
- Issue messages and paths change: the sidebar's "Sidebar …" messages become the shared messages, and issues move to nested paths under `layout`. Both callers discard the issues, so nothing observable changes.
- Persisted formats, storage keys, versions (`SPLIT_LAYOUT_SCHEMA_VERSION = 1`, `SIDEBAR_SPLIT_LAYOUT_STORAGE_VERSION = 1`), the sentinel plugin id and the legacy-id rewrite in `legacy-browser-preferences.ts` are all untouched.

Why this is the simplest sufficient option: a factory that takes the content schema is the only variation point between the two schemas. Exporting the node schemas separately would leave the layout-level rules (cap, focus, uniqueness) duplicated. A generic type parameter is unnecessary, because both callers need a `SplitLayout` output and `SidebarSplitState.layout` is already typed `SplitLayout`.

Non-goals: no change to the sidebar group model, the reconcile logic, the maximize behaviour, the pruning, the storage keys or the workspace content union. The error messages are not unified for their own sake beyond what the factory implies.

**Expected gain and cost**

Projections from the snapshot line ranges above, not a measured diff:

- `sidebarSplitLayout.ts`: about 72 lines removed (2 + 33 + 5 + 1 + 32) and about 1 import name added, for roughly 70 lines net.
- `persistence.ts`: about 8 to 12 lines added for the function signature, the `return`, the closing brace, the `splitLayoutSchema` call, and a `PaneContent` type import that the formatter will probably wrap onto several lines.
- Net: about 58 to 64 handwritten production lines fewer. Test lines grow by about 15 to 30 for the added fixtures.
- Mechanisms: two definitions of the layout-tree invariants become one. One recursive helper and one epsilon constant disappear.
- Maintenance link: raising `MAX_PANES` semantics, changing the size tolerance, or adding a split direction or node field becomes one edit in `persistence.ts`, and both systems inherit it.
- Performance: neutral by construction. Both schemas are built once at module load and parse one small object per load. No measurement was taken, and none is needed for this size of input.
- Cost: the sidebar now depends on the workspace persistence module for its tree contract. It already imports `MAX_PANES`, `listPanes` and the tree types from the same `@/lib/split-layout` barrel, so no new dependency edge appears.

**Execution steps**

1. **Reconfirm the baseline.** In the working checkout, open `apps/app/src/lib/split-layout/persistence.ts` and `apps/app/src/components/secondary-panel/sidebarSplitLayout.ts` and confirm the symbols in the table above still exist with the same rules. Re-plan if either schema has gained a rule the other lacks (for example a new content kind, a different epsilon or a different pane cap), if the sidebar's layout has started to carry fields outside `{ root, focusedPaneId }`, or if any file outside these two now imports their schemas. Record the baseline line counts with `wc -l` on both files.
2. **Add the missing characterization before editing.** These tests must pass before the refactor and keep passing after it.
   - In `apps/app/src/lib/split-layout/persistence.test.ts`, inside the "rejects malformed JSON, unknown versions, and invalid layout invariants" test or a new `it` next to it, add three rejections built from the existing `layout` fixture: duplicate pane ids; a root whose `sizes` length differs from `children` length; and a nested split (a child of type `split`) whose own sizes sum to 0.9 while the root sums to 1.
   - In `apps/app/src/components/secondary-panel/sidebarSplitLayout.test.ts`, extend the `it.each` "falls back safely for $name" table with two cases: a nested split whose inner sizes are not normalized (replace `children[1]` of the two-pane fixture with a split of two sentinel panes, keeping groups one-to-one, and give that inner split sizes `[0.6, 0.6]`); and a pane whose content is a non-sentinel `plugin-panel` (for example `pluginId: "other"`).
   - Also add one acceptance case: a valid nested sidebar layout (two-level split, normalized sizes, groups one-to-one) parses to an equal state, so the change cannot reject previously accepted data.
   - Checkpoint: run the two test files (see Verification). All tests pass on the unchanged code.
3. **Introduce the factory in `persistence.ts`.** Add `PaneContent` to the `import type { ... } from "./types"` list. Wrap the existing `paneNodeSchema`, `layoutNodeSchema`, `splitNodeSchema` and `splitLayoutSchema` definitions (lines 34-106) in `export function createSplitLayoutSchema(contentSchema: z.ZodType<PaneContent>): z.ZodType<SplitLayout>`. Replace `content: paneContentSchema` with `content: contentSchema`, keep every refinement and message byte for byte, and `return` the layout schema. Below it, define `const splitLayoutSchema = createSplitLayoutSchema(paneContentSchema);` so `storedSplitLayoutSchema` is unchanged. Keep the `const` order inside the function so the `z.lazy` closure still references `splitNodeSchema` after initialization, exactly as today. Checkpoint: the persistence tests pass.
4. **Switch the sidebar to the factory in `sidebarSplitLayout.ts`.**
   - Add `createSplitLayoutSchema` to the existing `@/lib/split-layout` import (lines 3-20).
   - Delete `NORMALIZED_SPLIT_SIZE_EPSILON`, `paneNodeSchema`, `layoutNodeSchema` and `hasNormalizedSplitSizes`.
   - In `sidebarSplitStateSchema`, replace the inline `layout: z.object({ root: layoutNodeSchema, focusedPaneId: ... }).strict()` with `layout: createSplitLayoutSchema(paneContentSchema)`.
   - In its `superRefine`, delete the `paneIds` local and the four checks for pane cap, unique pane ids, focused pane and normalized sizes. Keep `panes`, `groupIds`, `storedGroupIds`, `referencedGroupIds` and the four group checks unchanged.
   - Keep the `LayoutNode`, `MAX_PANES`, `countPanes` and `listPanes` imports: they are still used at lines 129, 586 and in the group check. Let the lint run confirm that no import became unused.
   - Checkpoint: both test files pass, including the fixtures from step 2.
5. **Clean up.** Confirm that no file still mentions `hasNormalizedSplitSizes`, `NORMALIZED_SPLIT_SIZE_EPSILON` or the removed "Sidebar split sizes must be normalized" style messages: `rg -n "hasNormalizedSplitSizes|NORMALIZED_SPLIT_SIZE_EPSILON|Sidebar pane IDs must be unique|focused sidebar pane must exist|sidebar split supports at most" apps/app/src` returns nothing. No documentation references these internals (searched with `git grep` over `docs/` and `*.md` at the snapshot, no hits).
6. **Format, verify, and review the diff.** Run the formatter, lint, type check and the targeted tests listed below. Inspect `git diff` for only these four files. Recount with `wc -l` against the step 1 baseline and report the actual production and test line deltas separately.

**Verification and acceptance criteria**

The script names below were read from the snapshot's `package.json` files. The commands could not be run during this audit because the snapshot has no installed dependencies.

- Targeted tests, from `apps/app` (the `test` script is `vitest run --config vitest.config.ts`):
  `pnpm exec vitest run --config vitest.config.ts src/lib/split-layout/persistence.test.ts src/components/secondary-panel/sidebarSplitLayout.test.ts src/components/secondary-panel/SidebarSplitContainer.test.tsx src/lib/split-layout/atoms.test.ts`
  Expected result: all pass, including the new fixtures, and no existing assertion is edited or removed.
- Type check, from `apps/app`: `pnpm typecheck` (script: `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`). Expected result: no errors. This specifically proves that the sentinel content schema is assignable to `z.ZodType<PaneContent>` and that `SidebarSplitState.layout` still types as `SplitLayout`.
- Lint, from `apps/app`: `pnpm lint` (an oxlint script). Expected result: clean, with no unused imports in `sidebarSplitLayout.ts`.
- Format, from the repository root: `pnpm exec oxfmt <the four changed files>`, then `pnpm exec oxfmt --check <the four changed files>`. The root `format` and `format:check` scripts are `oxfmt .` and `oxfmt . --check`.
- Behavioural contract: every input that one of the two parsers accepted before is still accepted, and every input that it rejected is still rejected. The step 2 fixtures cover each tree invariant at the root and at a nested level for both parsers, plus the sidebar's sentinel-content restriction and one valid nested sidebar state.
- UI: there is no visual change, so no screenshot comparison is needed. Alex can do an optional manual check: create a two-level split in the right panel and a three-pane workspace split, reload the app, and confirm both restore unchanged.
- Performance: no comparison is required. Schema construction happens once per module load, and parse work per stored value is unchanged.
- Structural completion: `rg -n "z\.lazy" apps/app/src/components/secondary-panel/sidebarSplitLayout.ts` returns nothing. `createSplitLayoutSchema` has exactly two call sites, `persistence.ts` and `sidebarSplitLayout.ts`. The tree invariants appear only in `persistence.ts`.

**Rollback and stop conditions**

- Rollback boundary: the change touches four files (two production files and two test files) in one commit. Reverting that commit restores the previous schemas exactly. No persisted data, storage key or version changes, so a rollback needs no data migration, and users' stored layouts stay valid in both directions.
- Stop and re-plan if any of the following happens:
  - The type check rejects passing the sentinel schema as `z.ZodType<PaneContent>`, which would happen if a zod upgrade dropped the covariant `ZodType` declaration. Use a generic `createSplitLayoutSchema<C extends PaneContent>(contentSchema: z.ZodType<C>)` instead, and do not cast.
  - Any step 2 fixture behaves differently before and after the refactor. That means the invariants were not identical after all. Keep the old sidebar schema and document the divergence as a deliberate rule.
  - The sidebar's tree rules have legitimately diverged in the working checkout, for example a sidebar-only pane cap. Then pass that rule as a factory option only if it stays a single small parameter. Otherwise keep the two schemas.
  - A consumer outside these two files has started importing either schema.
- Safer smaller alternative: if the factory meets resistance, export only the shared `splitNodeSchema` rules as a `superRefine` helper. That removes the duplicated size checks but leaves the layout-level checks duplicated, so it is a weaker result.
