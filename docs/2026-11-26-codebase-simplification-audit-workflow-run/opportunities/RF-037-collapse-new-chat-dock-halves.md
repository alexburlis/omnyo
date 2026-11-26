# RF-037 — Render the launcher project cells and the stage project shelf from one ProjectCells body, and share the dock pick and plus-menu wiring

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication the sweep reported is real and was reproduced, but two parts of the sweep's plan were wrong or incomplete. First, the launcher dock already subscribes to sidebar navigation through `ProjectIcon`, so the "dock must not newly subscribe" concern does not apply. Second, a source-text anchor test requires the JSX tags `<ProjectDock`, `<ProjectShelf`, `<WhereLine` and `<StageWhereControls` to stay in `NewChatDock.tsx`. The plan below keeps those names as thin wrappers so that test needs no change.
- **Potential:** medium. One maintained project-cell body (about 70 duplicated lines) disappears, along with a second copy of the pick orchestration and plus-menu wiring.
- **Confidence:** high that the duplication exists and can be merged without behavior change (Proven by inspection). Medium on the exact line gain, which is a projection.
- **Readiness:** ready.
- **Effort:** about 2-3 hours, including a manual check of the ⌘N launcher and the Home stage.
- **Risk:** low. The change is UI-only in one file plus one import. The realistic regressions are a class, aria or `data-*` drift between the two cell layouts, swapping the icon fallback behavior, or losing the "one pick at a time" guard. Existing tests cover both docks.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none overlap directly. RF-029 (one composer selection queue) touches the new-thread composer selection path upstream of `dock.select`, but not this file's rendering. If RF-029 lands first, re-check that `dock.select` and `project.onChange` keep their signatures.
- **Why it deserves its place:** `NewChatDock.tsx` was changed on 2026-11-24 and twice on 2026-11-25 (`git log -- apps/app/src/components/promptbox/dock/NewChatDock.tsx`), so it is actively edited. Today any change to the More-projects trigger, its aria label, the selected-cell rule or the project-pick failure handling must be made twice, and nothing forces the two copies to agree.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). At verification time the main checkout's copies of `NewChatDock.tsx`, `new-chat-machines.ts` and `MachinePicker.tsx` were byte-identical to the snapshot (`cmp` and `git diff --stat e9e1b74c3 -- <paths>`, both empty).

What the subsystem does. The new-chat composer has two selection layouts. `apps/app/src/components/promptbox/NewThreadPromptBox.tsx` renders `NewChatStageDock` (line 347) for the Home stage and `NewChatDock` (line 443) for the ⌘N launcher. Only one renders at a time. Both docks let the user pick a project with one click from ranked project cells, plus a "More projects" trigger that opens `ProjectSelector`. Both also let the user pick a machine and workspace, and both show the plus menu and the session options.

Observed duplication in `apps/app/src/components/promptbox/dock/NewChatDock.tsx` (1,418 lines, `wc -l`). Counts were Reproduced with Python `difflib.SequenceMatcher` over non-blank, whitespace-stripped lines:

| Pair | Lines | Matching | What differs |
|---|---|---|---|
| `ProjectDock` (353-440) vs `ProjectShelf` (442-554) | 85 vs 107 | 74 | The group wrapper class, the cell class (`CELL_CLASS_NAME` line 99 vs `SHELF_CELL_CLASS_NAME` line 117) and the icon renderer |
| `NewChatDock` (176-258) vs `NewChatStageDock` (264-351) | 79 vs 84 | 47 | The layout. Lines 190-206 and 279-295 (focus guard, `useHostScopedPicks`, `pickWhere`, `pickProject`) are identical, as is the `ComposerPlusMenuSlot` wiring at 233-243 and 302-310 |
| `WhereLine` (642-739) vs `StageWhereControls` (741-832) | 97 vs 88 | 59 | The layout. The nine-field props type, the `whereOptions` destructuring and the two provider-input slot conditions (729-735, 823-829) are identical |

`ProjectDock` and `ProjectShelf` share these pieces line for line: the `names` map, the `dockCells(...)` call, the `moreLabel` derivation ("More", "No project", the project name or "Project"), the cell button attributes (`aria-pressed`, `disabled`, `onMouseDown={keepEditorFocus}`, `onClick`), the `ProjectSelector` props, and the More trigger (`aria-label={`More projects: ${moreLabel}`}`, the `ChevronDown` glyph tile). The real differences are:

- The group wrapper. The launcher uses `"flex flex-wrap justify-center gap-1 px-3.5 pb-1.5 pt-3"` and the shelf uses `"flex flex-wrap justify-center gap-4"`.
- The cell class (`CELL_CLASS_NAME` vs `SHELF_CELL_CLASS_NAME`).
- The icon. The launcher renders `<ProjectIcon projectId className="size-8 rounded-lg" />`. The shelf renders its local `plate(projectId)` closure (line 473): a `<span aria-hidden data-project-icon className={SHELF_TILE_CLASS_NAME}>` wrapping `<ProjectFace variant="tile">`. The shelf resolves the face from one `useSidebarNavigation()` and one `useConnectedHostIds()` call at the top of `ProjectShelf`.
- The fallback while navigation is loading. `ProjectIcon` returns `null` (`apps/app/src/components/sidebar/ProjectFace.tsx:341-369`). `plate` still renders the empty tile span, so the shelf cell keeps its 32px tile box. This difference must survive.

Correction to the sweep (Proven by inspection). `ProjectIcon` itself calls `useSidebarNavigation()` and `useConnectedHostIds()` for every icon (`ProjectFace.tsx:346-347`). The launcher dock therefore already subscribes once per cell. The thing to preserve is the shelf's current one-subscription-per-shelf structure, not the absence of subscriptions in the dock.

Contract encoded in a test (Proven by inspection). `apps/app/src/components/plugin/theme-preview-fixture-anatomy.test.ts:232-246` reads `NewChatDock.tsx` as text and requires it to contain `"<ProjectDock"`, `"{favorites}"`, `"<WhereLine"`, `"aria-pressed:bg-state-active"`, `"<ProjectShelf"`, `"<StageWhereControls"`, `'variant="tile"'` and `"group-aria-pressed/shelf-cell:opacity-100"`. The test exists so the Theme Preview plugin's mock keeps matching the real anatomy. The plan keeps every one of those strings.

Offline label (Proven by inspection). `apps/app/src/components/promptbox/dock/new-chat-machines.ts:74-80` "resolveMachineState" builds `host.lastSeenAt === null ? "Offline" : `Offline · last seen ${formatRelativeTime({ timestamp: host.lastSeenAt, now })}`` inline. `apps/app/src/components/pickers/MachinePicker.tsx:293-300` exports `formatOfflineMachineStatus(lastSeenAt, now)` with the same output. `apps/app/src/components/pickers/EnvironmentPicker.tsx:51,996` already imports it. `plugins/storage-retention/app.tsx:2002` has its own copy, but forkable plugins may not import app code (`docs/forkable-plugins.md`), so that copy stays.

Provider-input slot rule. The conditions `selectedProvider !== undefined && selectedProvider.inputs !== null` (environment slot) and `selectedProvider?.machineInputs !== undefined && selectedProvider.machineInputs !== null` (machine slot) appear in `WhereLine`, in `StageWhereControls` and a third time in `NewThreadPromptBox.tsx:576-582`. The third copy renders the machine slot before the environment slot, and that order must be kept.

Consumer search. `git grep -n "ProjectShelf\|ProjectDock\|StageWhereControls\|WhereLine\|data-new-chat-shelf\|shelf-cell" e9e1b74c3` over the whole snapshot found only `NewChatDock.tsx`, the anchor test above and an unrelated `projectShelf` state variable in `apps/app/src/views/RootComposeView.tsx:450,1509`. `git grep "NewChatStageDock\|dock/NewChatDock"` found only `NewThreadPromptBox.tsx`, its test mock (`NewThreadPromptBox.test.tsx:21-26`) and `NewChatDock.test.tsx`. All the touched components are module-private (not exported), except `NewChatDock`, `NewChatStageDock` and their props types, whose signatures do not change. No SDK, plugin, persisted data or route depends on them.

Test coverage. `apps/app/src/components/promptbox/dock/NewChatDock.test.tsx` mocks `ProjectIcon` as `<span data-project-icon>` and `ProjectFace` as `<span data-project-face data-variant>` (lines 36-49). It covers the launcher (`describe("NewChatDock")` line 194: project pick, favorites order, worktree toggle, offline row text "Offline · last seen 3d ago", the one-pick-at-a-time guard at line 320). It also covers the stage (`describe("NewChatStageDock")` line 346: control row, shelf group with `data-variant` "tile", the selected tile not carrying `bg-state-active` at line 391, the machine icon menu and the folded workspace). `new-chat-machines.test.ts:109` asserts "Offline · last seen 2h ago".

**Proposed end state and preservation argument**

What disappears:

1. The second project-cell body. A private `ProjectCells` component owns the names map, the `dockCells` call, the `moreLabel` rule, the cell buttons, the `ProjectSelector` wiring and the More trigger. `ProjectDock` and `ProjectShelf` keep their names and call sites but shrink to adapters that supply only the group class, the cell class and an icon renderer.
2. The second copy of the pick orchestration and the plus-menu wiring. A private `useDockControls` hook owns the focus guard, the host-scoped pick runner, `pickWhere`, `pickProject`, `projectless` and the configured `ComposerPlusMenuSlot` element.
3. The duplicated where-controls props type. `WhereLine` and `StageWhereControls` share one `WhereControlsProps` interface. `WhereLine` adds `trailing`.
4. The inline offline label in `new-chat-machines.ts`, which calls `formatOfflineMachineStatus` instead.

What remains separate on purpose: the two dock layouts (`NewChatDock` and `NewChatStageDock`), the two where-control layouts, `NewThreadPromptBox`'s environment slot with its reversed order, and the storage-retention plugin's own offline label.

Shapes:

```ts
interface ProjectCellsProps {
  rankedProjectIds: readonly string[];
  project: NewThreadProjectConfig;
  keepEditorFocus: KeepEditorFocus;
  onPick: (projectId: string | null) => void;
}

function ProjectCells(props: ProjectCellsProps & {
  groupClassName: string;
  cellClassName: string;
  renderIcon: (projectId: string) => ReactNode; // used for each cell and for the More trigger's chosen project
}): JSX.Element;

function ProjectDock(props: ProjectCellsProps) {
  return <ProjectCells {...props}
    groupClassName="flex flex-wrap justify-center gap-1 px-3.5 pb-1.5 pt-3"
    cellClassName={CELL_CLASS_NAME}
    renderIcon={(id) => <ProjectIcon projectId={id} className="size-8 rounded-lg" />} />;
}

function ProjectShelf(props: ProjectCellsProps) {
  const { data: navigation } = useSidebarNavigation();   // still once per shelf
  const connectedHostIds = useConnectedHostIds();         // still once per shelf
  const plate = (projectId: string) => { /* unchanged body, keeps variant="tile" */ };
  return <ProjectCells {...props} groupClassName="flex flex-wrap justify-center gap-4"
    cellClassName={SHELF_CELL_CLASS_NAME} renderIcon={plate} />;
}

function useDockControls(props: Pick<NewChatDockProps,
  "dock" | "project" | "promptActions" | "canAttach" | "promptBoxRef" | "approvals">): {
  keepEditorFocus: KeepEditorFocus;
  projectless: boolean;
  pickWhere: (pick: WherePick) => void;
  pickProject: (projectId: string | null) => void;
  plusMenu: ReactNode; // the ComposerPlusMenuSlot element with today's exact props
};
```

The More trigger keeps today's branch. When `moreShows === null` it renders the `ChevronDown` tile. Otherwise it calls `renderIcon(moreShows.kind === "project" ? moreShows.projectId : PERSONAL_PROJECT_ID)`, which matches both current branches (`ProjectIcon` with the same class, or `plate(...)`).

Why this preserves behavior:

- Every DOM node, class string, aria attribute and `data-*` hook is produced by the same expressions as today. Only where those expressions live changes.
- `ProjectShelf` still calls the two queries once per shelf. `ProjectDock` still renders `ProjectIcon`, with its per-icon subscriptions and its null fallback. The shelf still renders the empty tile while loading. Subscription counts are unchanged (Proven by inspection of the plan; confirm in step 6).
- `useHostScopedPicks` stays one instance per mounted dock, because each dock calls `useDockControls` once. The one-pick-at-a-time guard and the "Couldn't change where this chat runs." toast keep their scope.
- The source anchors `<ProjectDock`, `<ProjectShelf`, `<WhereLine`, `<StageWhereControls`, `variant="tile"`, `aria-pressed:bg-state-active`, `group-aria-pressed/shelf-cell:opacity-100` and `{favorites}` all remain in `NewChatDock.tsx`.
- The app uses React Compiler (`apps/app/vite-react-compiler.ts`), so the inline arrow props do not need manual memoization. Today's code does not memoize them either.

Why this is the simplest sufficient option. A `variant: "dock" | "shelf"` switch inside one component (the sweep's proposal) would need a new `ShelfPlate` child to keep the shelf's queries off the launcher. It would also rename the JSX tags the anchor test reads, or force an edit to that test. Passing the three differences in from the two existing adapter names removes the duplicated body without either cost.

Non-goals: no visual, copy or interaction change. No change to `NewThreadPromptBox`'s slot order. No change to `ProjectFace.tsx`, `project-ranking.ts` or the Theme Preview plugin. No sharing with `plugins/storage-retention`.

**Expected gain and cost**

Projection (not measured). Handwritten production lines net, all in `apps/app/src/components/promptbox/dock/NewChatDock.tsx` and `new-chat-machines.ts`:

| Part | Before | After (projected) | Net |
|---|---|---|---|
| `ProjectDock` + `ProjectShelf` (353-554, 202 lines with blanks) | 2 full bodies | `ProjectCells` about 95, `ProjectDock` adapter about 12, `ProjectShelf` adapter with `plate` about 36, shared props type about 6 | about -50 |
| Pick orchestration + plus menu (190-206, 233-243, 279-295, 302-310) | 2 copies, about 56 lines | one `useDockControls` hook about 35, plus 2 short call sites | about -15 to -20 |
| `WhereLine` / `StageWhereControls` props types | 2 copies of 9 fields | one interface | about -9 |
| Offline label | inline copy | one call plus an import | about -4 |
| **Total** | | | **about -75 to -80 lines; quote 55-80 to allow for formatter layout** |

Test, generated, docs and fixture lines: 0 expected. No test should need editing.

Mechanisms: before, there were 2 project-cell implementations, 2 pick-and-plus-menu wirings, 2 where-props types and 2 offline-label formatters. After, there is 1 of each. The two layout adapters remain explicit.

Causal maintenance gain. A change to the More-projects label or aria text, the "No project" rule, the selected-cell `aria-pressed` rule, `ProjectSelector` props, the pick failure toast or the plus-menu attach and action wiring becomes one edit that both layouts pick up. Today the copies can silently diverge.

Cost: one level of indirection (`renderIcon`) and a hook. Performance: neutral by construction, because no query, effect or render count changes. No benchmark is needed.

**Execution steps**

1. **Reconfirm the baseline.** In your working checkout, check that the anchors still hold: `ProjectDock`, `ProjectShelf`, `NewChatDock`, `NewChatStageDock`, `WhereLine` and `StageWhereControls` in `apps/app/src/components/promptbox/dock/NewChatDock.tsx`; `ProjectIcon` in `apps/app/src/components/sidebar/ProjectFace.tsx`; and the anchor list in `apps/app/src/components/plugin/theme-preview-fixture-anatomy.test.ts`. Run `git status --porcelain -- apps/app/src/components/promptbox/dock apps/app/src/components/pickers/MachinePicker.tsx`. If another agent has uncommitted changes in these files, stop and coordinate, because this file is actively edited. Re-plan if any of these hold:
   - the two docks gain real behavioral differences, such as different pick semantics or different More-trigger rules;
   - `ProjectIcon` stops subscribing per icon;
   - the anchor test's required strings change.
   Record the baseline with `wc -l` on `NewChatDock.tsx` and `new-chat-machines.ts`.
2. **Baseline evidence.** Run the targeted tests listed under Verification and confirm they pass before you edit anything. No new test is required, because the existing suites cover both layouts, the guard and the offline text. Optionally, before editing, capture the rendered `outerHTML` of `[data-new-chat-dock]` and `[data-new-chat-shelf]` from the existing `NewChatDock.test.tsx` renders into a scratch file under `~/scratch/omnyo/<owner-id>--rf037/` for a byte comparison after the change. Do not commit it.
3. **Checkpoint A: project cells.**
   - In `NewChatDock.tsx`, add `interface ProjectCellsProps` (the four shared props).
   - Rename the body of `ProjectDock` to `function ProjectCells(...)` and add `groupClassName`, `cellClassName` and `renderIcon`. Replace the wrapper class, both `className={CELL_CLASS_NAME}` uses (cell and More trigger) and both `<ProjectIcon .../>` uses with the new props, keeping the More trigger's `PERSONAL_PROJECT_ID` branch.
   - Re-add `ProjectDock` as the adapter shown above.
   - Reduce `ProjectShelf` to its two hooks, its unchanged `plate` closure (which keeps `variant="tile"` and `SHELF_TILE_CLASS_NAME`) and a `<ProjectCells>` call.
   - Leave the call sites at lines 210 (`<ProjectDock`) and 334 (`<ProjectShelf`) unchanged.
   - Run `NewChatDock.test.tsx` and the anchor test.
4. **Checkpoint B: dock controls.**
   - Add `function useDockControls(...)` next to `useHostScopedPicks`. It contains the current lines 190-206 and returns `plusMenu`, the `ComposerPlusMenuSlot` element with today's exact props (`actions`, `onAttach` gated by `canAttach`, `onAction`, `approvals ?? undefined`).
   - In `NewChatDock`, replace lines 190-206 with one `const { keepEditorFocus, projectless, pickWhere, pickProject, plusMenu } = useDockControls(...)`, and replace the inline `ComposerPlusMenuSlot` inside `trailing` with `{plusMenu}`. Keep `{sessionOptionsControl}` before it.
   - In `NewChatStageDock`, do the same, keeping `{plusMenu}` before `{sessionOptionsControl}`. The two layouts order these differently today, and that order must stay.
   - Run `NewChatDock.test.tsx`. The guard test at line 320 must still pass.
5. **Checkpoint C: where props and offline label.**
   - Extract `interface WhereControlsProps` from the nine shared fields. Use `WhereControlsProps & { trailing: ReactNode }` for `WhereLine` and `WhereControlsProps` for `StageWhereControls`. Leave both bodies and both slot conditions as they are, so render order is unchanged.
   - In `new-chat-machines.ts` "resolveMachineState", replace the inline title with `formatOfflineMachineStatus(host.lastSeenAt, now)`, imported from `@/components/pickers/MachinePicker` (as `EnvironmentPicker.tsx` already does). Remove the `formatRelativeTime` import if nothing else uses it.
   - If importing a component module into this pure module breaks `new-chat-machines.test.ts` or creates an import cycle (Hypothesis, not observed), skip only this sub-step and record why. Do not move the helper as part of this card.
   - Run `new-chat-machines.test.ts` and `NewChatDock.test.tsx`.
6. **Clean up and recount.**
   - Confirm no unused imports or constants remain. `ProjectIcon`, `ProjectFace`, `useConnectedHostIds`, `useSidebarNavigation` and `ComposerPlusMenuSlot` should each still be imported exactly once.
   - Confirm `useSidebarNavigation` and `useConnectedHostIds` are called only inside `ProjectShelf` in this file (`rg -n "useSidebarNavigation\(|useConnectedHostIds\(" apps/app/src/components/promptbox/dock/NewChatDock.tsx`).
   - Inspect the full diff for unrelated changes.
   - Re-run `wc -l` and report the actual net reduction against step 1's baseline.
   - Run the formatter and lint on the two changed files.

**Verification and acceptance criteria**

Commands. The script names were read from `apps/app/package.json` and the root `package.json` at the snapshot. They were not executed here, because the snapshot had no `node_modules`.

- Targeted tests, from `apps/app`:
  `pnpm exec vitest run --config vitest.config.ts src/components/promptbox/dock/NewChatDock.test.tsx src/components/promptbox/dock/new-chat-machines.test.ts src/components/plugin/theme-preview-fixture-anatomy.test.ts src/components/promptbox/NewThreadPromptBox.test.tsx`
  These are the same files the package's `test` script (`vitest run --config vitest.config.ts`) would run. Expected: all pass with no assertion or snapshot edited.
- Types, from the repo root: `pnpm --filter @omnyo/app typecheck` (script `typecheck`: `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`). Expected: clean.
- Lint, from `apps/app`: `pnpm exec oxlint --deny-warnings src/components/promptbox/dock/NewChatDock.tsx src/components/promptbox/dock/new-chat-machines.ts`. The package `lint` script is `oxlint src ...`.
- Format, from the repo root: `pnpm exec oxfmt apps/app/src/components/promptbox/dock/NewChatDock.tsx apps/app/src/components/promptbox/dock/new-chat-machines.ts`, then `pnpm exec oxfmt --check` on the same files. The root `format:check` script is `oxfmt . --check`.

Behavior and contract checks:

- Both docks still render the same project cells, More label ("More", "No project", the project name or "Project"), aria labels, `aria-pressed` state and `ProjectSelector` behavior. This is covered by `NewChatDock.test.tsx` lines 195 and 371-391.
- The shelf tiles still carry `data-variant="tile"`, and the selected tile still lacks `bg-state-active` (test line 391).
- A second machine-scoped pick is still ignored while the first is pending (test line 320).
- The offline text is unchanged ("Offline · last seen 3d ago" at test line 301, "Offline · last seen 2h ago" in `new-chat-machines.test.ts:109`).
- The anchor test passes without edits.
- Optionally, the captured `outerHTML` from step 2 is byte-identical after the change.

Visual and interaction check. Alex tests UI himself, so this is a short manual pass he can do, not a gate.
- In the ⌘N launcher: project cells, the More trigger with and without an off-list project, the "No project" state, keyboard focus not leaving the editor on a desktop pointer, the plus menu's attach and action items, and session options after the plus menu.
- On the Home stage: shelf tiles at rest, on hover and when selected; the empty tile while navigation loads; the plus menu before session options; the machine and workspace row.
- A single screenshot is not enough for focus behavior.

Structural completion:
- Only one place in `NewChatDock.tsx` builds `moreLabel`, calls `dockCells` and renders `ProjectSelector` for the docks (`rg -n "dockCells\(|moreLabel =|<ProjectSelector" apps/app/src/components/promptbox/dock/NewChatDock.tsx` shows one hit each).
- Only one place calls `useHostScopedPicks` and `wherePickSelection` for the docks.
- `new-chat-machines.ts` no longer contains the "Offline · last seen" string.

Performance: no query, effect or subscription count changes, which step 6's `rg` check confirms. No benchmark is required.

**Rollback and stop conditions**

- **Rollback:** each checkpoint touches only `NewChatDock.tsx`, and checkpoint C also touches `new-chat-machines.ts`. Reverting the commit for a checkpoint restores the previous state exactly. No persisted data, API or published export is involved.
- **Stop** if another agent has uncommitted work in these files (step 1).
- **Stop** if preserving the DOM requires a variant-specific branch inside `ProjectCells` beyond the three injected props. That would mean the layouts have diverged, and they should stay separate.
- **Stop** if `NewChatDock.test.tsx` or the anchor test fails in a way that would require editing an assertion, or if a manual check shows any visual or focus difference.
- **Stop** if `useSidebarNavigation` or `useConnectedHostIds` would move into `ProjectCells` or be called per shelf cell.
- **Smaller safe alternative:** do checkpoint A alone. It carries most of the gain.
