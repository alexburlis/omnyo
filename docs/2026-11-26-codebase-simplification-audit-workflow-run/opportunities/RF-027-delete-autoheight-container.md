# RF-027 — Delete the unused `AutoHeightContainer`, `AutoHeightSnapContext` and their intrinsic-height timer machinery from `height-transition.tsx`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: `AutoHeightContainer` and `AutoHeightSnapContext` have no production caller, and only their own tests exercise them. The sweep's counts were slightly low, and its history was wrong. The last production caller was removed on 2026-11-07, not on 2026-08-27. The sweep also missed two other importers of the file; both use only `HeightTransition` and need no change.
- **Potential:** low to medium. 248 handwritten production lines go (202 of them non-blank), leaving 184 of the file's 432 lines. A further 147 test lines go, leaving 112 of 259. One of the module's two height animators disappears, together with the module's only `setTimeout`-based state machine.
- **Confidence:** high.
- **Readiness:** ready.
- **Effort:** small, under an hour. The work is one source-file edit, one test-file trim, a typecheck and the targeted tests.
- **Risk:** low. The module is internal to `apps/app`, and plugins cannot reach it. A wrong deletion inside the file shows up as a TypeScript or oxlint error.
- **Prerequisites:** none.
- **Related or overlapping:** RF-047 retires the Polish review Ladle story and manifest. Its manifest entry `integration-height-transition-snap` lists this file but describes only `HeightTransition`, so the two items are independent and either can land first. RF-093 (scroll-edge overflow fade) and the timeline items (RF-023, RF-025) do not touch this file.
- **Why it deserves its place:** this is dead machinery, not cosmetic tidying. The 2026-11-07 chat-scrolling rebuild deliberately removed "a height-animated wrapper around the whole timeline" as one of five independent scroll-position movers, but it left the wrapper's implementation and tests behind. Anyone who changes the motion tokens, `observeSharedResize`, `applyHeight` or the snap contract still has to keep a second, more complex animator compiling and passing. A future reader could also reintroduce it, which would bring back the scroll jumps that commit fixed.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The read-only snapshot worktree named in the audit brief no longer existed when this card was written, so all evidence was read with `git show <commit>:<path>` and `git grep <commit>` from `$OMNYO_CHECKOUT`. History before the 2026-11-24 public squash was read from the retired private store at `$ARCHIVED_OMNYO_CHECKOUT`. No test or build was run, because the snapshot has no `node_modules`.

What the module does. `apps/app/src/components/ui/height-transition.tsx` holds two height animators that share a small snap toolkit:

- Shared and kept: `SnapState` (:31), `SNAP_TRANSITION_CLASS` (:35), `enterSnapMode` (:49), `exitSnapMode` (:53), `scheduleRestore` (:57), `applyHeight` (:68), `cleanupSnapState` (:90) and `getObservedInnerHeight` (:152).
- Live: `HeightTransition` (:167-257). This is a disclosure animator driven by a `visible` prop. It is used by `apps/app/src/components/thread/timeline/ThreadTimelineSurface.tsx:14` and by the Ladle story `apps/app/src/components/thread/timeline/StreamingRows.stories.tsx:8` (rendered at :54).
- Dead: `AutoHeightSnapContext` (:259), `AutoHeightContainerProps` (:261-265), `AUTO_HEIGHT_INITIAL_SETTLE_MS` (:267), `AUTO_HEIGHT_WIDTH_RESIZE_SETTLE_MS` (:269), `useSnapHeightGrowth` (:271-276) and `AutoHeightContainer` (:278-432). Four helpers serve only `AutoHeightContainer`: `IntrinsicHeightResizeState` (:37-40), `ScheduleIntrinsicHeightRestoreArgs` (:42-47), `enterIntrinsicHeightMode` (:99-117), `scheduleIntrinsicHeightRestore` (:119-139, which reads `AUTO_HEIGHT_WIDTH_RESIZE_SETTLE_MS`) and `cancelIntrinsicHeightRestore` (:141-150).
- Imports used only by the dead part: `createContext` and `useCallback` (react import, :2-8), `usePointerCoarse` (:10) and `supportsScrollAnchoring` (:21). `MOTION_DURATION_MS` and `usePrefersReducedMotion` stay, because `HeightTransition` uses both (:171, :175).

Reachability proof (Proven by inspection):

- `git grep -n -I AutoHeight e9e1b74c3 -- .` over the whole repository found hits only in `height-transition.tsx` and `height-transition.test.tsx`. That search covers code, docs, JSON, scripts, plugins, packages, desktop, mobile and tests. `AutoHeightSnapContext` has no `useContext` consumer anywhere.
- `git grep -n -I -e snapRevision -e animateGrowth -e AUTO_HEIGHT -e useSnapHeightGrowth -e IntrinsicHeight e9e1b74c3 -- .` found hits only in those two files. No string-addressed or prop-name consumer exists.
- `git grep -n -I height-transition e9e1b74c3 -- .` found four referencing files. `ThreadTimelineSurface.tsx:14` and `StreamingRows.stories.tsx:8` import only `HeightTransition`. `apps/app/src/polish-review/polish-review-manifest.ts:8764-8781` (entry `integration-height-transition-snap`) is a file list for a `HeightTransition` fix. The test file is the fourth.
- Plugins cannot import this file. Forkable plugins resolve `@/*` through their own tsconfig paths into `packages/shared-ui/src/*` (for example `plugins/account-pool` maps `"@/*": ["../../packages/shared-ui/src/*"]`, applied by `apps/app/vite-forkable-plugin-paths.ts` `forkablePluginPaths`). `packages/shared-ui` has no `height-transition` file: `git ls-tree -r --name-only e9e1b74c3 | rg height-transition` lists only the two `apps/app` files. Neither the plugin SDK, `packages/plugin-registry` nor any plugin mentions it.
- There is no persisted data, route, setting, CLI command or manifest id involved. The component is pure UI.
- The only unrelated near-hit is `tests/qa/inline-mobile/proof.mjs:242` and `:260`, whose "Autoheight" refers to inline HTML visualisation sizing, not this component.

History (Proven by inspection, private store). `git log --all -S AutoHeightContainer -- apps/app/src` shows the timeline used it from 2026-05 onwards. Commit `4152177a0b` (2026-11-07, "Rebuild chat scrolling around one position owner without layout shift", also present as `64fdce5b0e`) removed `import { AutoHeightContainer }` from `ThreadTimelineRows.tsx` and the `AutoHeightSnapContext.Provider` test helper. Its message lists "a height-animated wrapper around the whole timeline" among the five mechanisms that "moved the scroll position independently", and the rebuild replaced them with one scroll-position owner. The removal was therefore intentional, not accidental. The sweep's reference to `8b2213625` (2026-08-27) is a comment-only commit.

Shared helpers that survive elsewhere: `supportsScrollAnchoring` (`apps/app/src/lib/scroll-anchoring-support.ts:1`) stays, because `apps/app/src/components/thread/timeline/timeline-row-containment.ts:3,17` uses it. `usePointerCoarse` stays, with many other users in `apps/app` and `packages/shared-ui`. Only the imports in this file go.

Tests. `apps/app/src/components/ui/height-transition.test.tsx` has three `HeightTransition` tests (:27-112) and two `AutoHeightContainer` blocks: `describe("AutoHeightContainer")` (:130-186) and `describe("AutoHeightContainer growth easing")` (:208-259). The helpers `makeResizeEntry` (:114-128), `stubMediaQueries` (:188-199) and `stubScrollAnchoringSupport` (:201-206) serve only those blocks. After the trim, the `MOTION_DURATION_MS` import (:5) is used only by the deleted easing block, so it goes too. None of the `HeightTransition` tests depends on the deleted helpers.

Maintenance cost today: `AutoHeightContainer` is the most complex code in the file. It runs an initial-settle timer, a width-resize intrinsic-height mode with a 120 ms restore timer, a `snapRevision` effect, a context provider and a pointer/motion/scroll-anchoring growth policy, and all of it shares `applyHeight` and `SnapState` with the live animator. Any change to that shared contract has to be reasoned about, and tested, against both animators.

**Proposed end state and preservation argument**

`height-transition.tsx` keeps exactly one exported animator, `HeightTransition`, together with its snap toolkit (`SnapState`, `SNAP_TRANSITION_CLASS`, `enterSnapMode`, `exitSnapMode`, `scheduleRestore`, `applyHeight`, `cleanupSnapState`, `getObservedInnerHeight`) and its imports (`useStore`, `useLayoutEffect`, `useRef`, `ReactNode`, `cn`, the motion tokens, document visibility, `observedBorderBoxBlockSize`, `observeSharedResize` and `layoutAnimationInFlightCountAtom`). The `PAUSE_COLLAPSED_DESCENDANT_ANIMATIONS_CLASS` constant also stays.

What disappears: the `AutoHeight*` exports, the constants, `useSnapHeightGrowth`, the intrinsic-height helpers and types, the four imports listed above, and the matching tests and test helpers.

Preservation argument: `HeightTransition`'s body (:167-257) and every function it calls are untouched, so its rendering, transition strings, snap behaviour, document-visibility resync and cleanup are byte-identical. The three `HeightTransition` tests stay unchanged and keep guarding the paused-descendant class, the pageshow snap and the post-snap transition. No UI state changes, because no rendered tree contains `AutoHeightContainer`.

Non-goals: no change to `HeightTransition`, `ThreadTimelineSurface`, the Ladle story, the polish-review manifest (which RF-047 owns), `supportsScrollAnchoring`, `usePointerCoarse` or `shared-resize-observer`.

Remaining uncertainty: none material. If the component were needed again, git history holds it, but the 2026-11-07 rebuild argues against reintroducing a height-animated wrapper around timeline content.

**Expected gain and cost**

Measured with a line-exact simulation over the snapshot files (Reproduced, with temp copies removed afterwards):

| File | Before | After | Removed |
|---|---|---|---|
| `apps/app/src/components/ui/height-transition.tsx` (production) | 432 lines (354 non-blank) | 184 lines (152 non-blank) | 248 lines (202 non-blank) |
| `apps/app/src/components/ui/height-transition.test.tsx` (test) | 259 lines | 112 lines | 147 lines |

The production count assumes oxfmt collapses the react import to one line, `import { useLayoutEffect, useRef, type ReactNode } from "react";` (64 characters). If the formatter keeps it multi-line, the reduction is 243 lines.

Mechanisms: before, the module held two height animators, one timer-driven intrinsic-height state machine and one context. After, it holds one animator. The causal maintenance gain is that the shared snap contract has one consumer, so a change to `applyHeight`, the motion tokens or `observeSharedResize` needs to be checked against `HeightTransition` only.

Performance: neutral at runtime, because the code never runs. The `apps/app` chunk that contains this module may shrink slightly if the bundler did not already drop the unused export. That effect is unmeasured, and no performance claim depends on it.

Cost: no additions and no tradeoffs.

**Execution steps**

1. Reconfirm the baseline in a clean worktree on current `origin/main`, never in a checkout with foreign uncommitted edits to these two files. Run `git grep -n -I AutoHeight` and `git grep -n -I height-transition` from the repository root.
   - Stop and re-plan if any file other than the two above references `AutoHeight`.
   - Stop and re-plan if a new importer of `height-transition` uses anything except `HeightTransition`.
   - Stop and re-plan if `packages/shared-ui` now has a `height-transition` file that plugins could alias.
   - Confirm that the line anchors in Context still match. If they have drifted, locate the code by symbol.
2. Edit `apps/app/src/components/ui/height-transition.tsx`:
   1. Delete everything from `export const AutoHeightSnapContext` to the end of the file. That covers `AutoHeightContainerProps`, both `AUTO_HEIGHT_*` constants, `useSnapHeightGrowth` and `AutoHeightContainer`, plus the blank line before them.
   2. Delete `cancelIntrinsicHeightRestore`, `scheduleIntrinsicHeightRestore` and `enterIntrinsicHeightMode` (the block between `cleanupSnapState` and `getObservedInnerHeight`).
   3. Delete the `IntrinsicHeightResizeState` and `ScheduleIntrinsicHeightRestoreArgs` interfaces. Keep `SnapState` and `SNAP_TRANSITION_CLASS`.
   4. Remove `createContext` and `useCallback` from the react import. Delete the `usePointerCoarse` import line and the `supportsScrollAnchoring` import line. Keep `MOTION_DURATION_MS` and `usePrefersReducedMotion`.
   5. Leave `HeightTransition` and the shared snap helpers byte-identical.
3. Edit `apps/app/src/components/ui/height-transition.test.tsx`:
   1. Delete `makeResizeEntry`, `describe("AutoHeightContainer")`, `stubMediaQueries`, `stubScrollAnchoringSupport` and `describe("AutoHeightContainer growth easing")`, which is everything after the closing `});` of `describe("HeightTransition")`.
   2. Change the import to `import { HeightTransition } from "./height-transition";`.
   3. Delete the now-unused `import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";`.
   4. Keep `ResizeObserverStub` and `afterEach`, because the `HeightTransition` tests use them.
4. Checkpoint: run typecheck and lint (see below). Any "cannot find name" error means a shared helper was deleted by mistake: restore that helper, not the dead component.
5. Run the targeted tests. Then inspect `git diff` and confirm three things: only the two files changed, `HeightTransition`'s body is unchanged, and no `AutoHeight`, `IntrinsicHeight`, `snapRevision` or `useSnapHeightGrowth` token remains in the repository. Recount with `wc -l` against the table above.
6. Leave the polish-review manifest entry alone. It still names both files, which still exist.

**Verification and acceptance criteria**

The commands below come from `apps/app/package.json` and the root `package.json` at the snapshot. They were not executed here, because the snapshot has no `node_modules`.

- Format the changed files, from the repository root: `pnpm exec oxfmt apps/app/src/components/ui/height-transition.tsx apps/app/src/components/ui/height-transition.test.tsx`. The root `format` script is `oxfmt .`, and the config is `.oxfmtrc.json`.
- Lint, from `apps/app`: `pnpm run lint` (script `oxlint src ...`). Alternatively, from the repository root, run `pnpm exec oxlint --deny-warnings --format=agent apps/app/src/components/ui`. Expect no unused-import or unused-variable warnings.
- Typecheck, from `apps/app`: `pnpm run typecheck` (script `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`). Expect a clean pass.
- Targeted tests, from `apps/app`: `pnpm exec vitest run --config vitest.config.ts src/components/ui/height-transition.test.tsx src/components/thread/timeline/ThreadTimelineSurface.test.tsx src/components/thread/timeline/ThreadTimelinePanelContent.test.tsx src/views/thread-detail/ThreadTimelinePane.test.tsx`. Expect the three `HeightTransition` tests and the timeline-surface tests to pass with assertions unchanged. The `test` script is `vitest run --config vitest.config.ts`. Passing file filters to it is standard Vitest usage; if the config's `include` list rejects one of these paths, run the file through that config's include.
- Structural check, from the repository root: `git grep -n -I -e AutoHeight -e IntrinsicHeight -e useSnapHeightGrowth -e snapRevision` should return nothing.
- Visual check: none is required, because no rendered tree changes. Optionally, run `pnpm run storybook` in `apps/app` and confirm that the `thread--timeline--streaming--rows` story's working indicator still eases in and out.
- Performance check: none is required, because the deleted code does not run.

Acceptance requires all of the following:

- Both files are reduced as in the table, within the formatter's choice of import layout.
- `HeightTransition` is unchanged.
- Typecheck, lint and the targeted tests pass.
- No `AutoHeight` symbol remains.

**Rollback and stop conditions**

The change boundary is one commit that touches two files, with no data, persisted-format or API implications. Rollback is `git revert` of that commit.

Stop and re-plan if any of the following holds:

- A new production caller of `AutoHeightContainer` or `AutoHeightSnapContext` exists on current `origin/main`.
- A plugin or package gains an alias that reaches `apps/app/src/components/ui/height-transition`.
- Typecheck shows that a helper this card classifies as AutoHeight-only is used by `HeightTransition`. In that case, keep the helper and delete only the rest.

If a product owner wants animated growth for streaming content again, treat that as a new design against the single scroll-position owner from commit `4152177a0b`, not as a reason to keep this code.
