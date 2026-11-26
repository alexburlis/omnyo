# RF-093 — One synchronous scroll-edge fade hook and mask builder for the project rail and the mobile footer status line

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real, but between a different pair than the sweep claimed. `useRailScrollFades` (vertical rail) and `useHorizontalFades` (mobile footer status line) are the same mechanism written twice: a synchronous `useLayoutEffect`, one `ResizeObserver` on the scroller and its content, a passive scroll listener, a 2 px edge threshold, and a matching `maskImage`/`WebkitMaskImage` gradient builder. The sweep's proposal to fold both into `useScrollOverflowState` is rejected. That hook is a different mechanism: it defers measurement to `requestAnimationFrame`, adds a `MutationObserver` and an `IntersectionObserver` sentinel path, and owns its refs. Adopting it would change when the rail paints its mask and separator.
- **Potential:** low to medium. About 45–60 handwritten production lines go away. Two observer and listener lifecycles become one, and two mask builders become one.
- **Confidence:** high. The equivalence of the two hooks is proven by inspection below.
- **Readiness:** ready. No owner decision is needed, and no timing or behavior change is intended.
- **Effort:** small, about 2–3 hours including tests.
- **Risk:** low. The measurement timing, observers and thresholds stay the same. The only semantic difference, the footer gaining an `overflows` gate, is proven to be a no-op.
- **Prerequisites:** none.
- **Related or overlapping RF ids:** none touch these files. RF-035 (retire host `sidebar.*` preferences) and RF-044 (Resources rail widget) touch other parts of the sidebar, not `useRailOverflow.ts` or `FooterStatusLine.tsx`.
- **Why it deserves its place:** it removes duplicated knowledge (the edge threshold, the overflow rule, the observer lifecycle and the mask string format) from two UI surfaces that must look and behave alike. It is cheap and carries no timing risk. It ranks low because the absolute saving is small.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The prepared read-only worktree was absent, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c…:<path>`. The three hook files have not changed between the snapshot and local `HEAD` 5f2d3f895 (`git diff --stat e9e1b74c… HEAD` lists only `ProjectRail*` and `railAttention*` under `sidebar/`).

What the subsystem does: the desktop and web app's left navigation rail has two scrolling columns, project tiles and destinations. When either column overflows, it fades the clipped edge with a CSS mask, and the project column also shows a 1 px separator above and below. The mobile bottom rail shows plugin status cards in a horizontally scrolling line that fades its clipped left and right edges.

Observed facts (Proven by inspection):

- `apps/app/src/components/sidebar/useRailOverflow.ts` (104 lines):
  - The constants sit at lines 11–15: `RAIL_FADE_TOP_PX = 28`, `RAIL_FADE_BOTTOM_PX = 40` and `RAIL_SCROLL_EDGE_PX = 2`. `RAIL_SEPARATOR_CLASS` is at line 8.
  - `RailScrollFades { overflows, fadeTop, fadeBottom }` is at lines 17–21, and `NO_RAIL_SCROLL_FADES` at lines 23–27.
  - `readRailScrollFades` (lines 29–40) computes `overflows = scrollHeight > clientHeight + 1`, `fadeTop = overflows && scrollTop > 2` and `fadeBottom = overflows && scrollTop + clientHeight < scrollHeight - 2`.
  - `sameRailScrollFades` (lines 42–51) compares two results.
  - `useRailScrollFades(scrollRef, contentRef)` (lines 53–85) measures synchronously in `useLayoutEffect`. It calls `update()` immediately, then creates one `ResizeObserver` that observes the scroller and its content, adds a passive `scroll` listener, and disconnects on cleanup.
  - `railFadeMaskStyle` (lines 87–104) builds `linear-gradient(to bottom, …)` with 28 px and 40 px stops and returns `{ maskImage, WebkitMaskImage }`.
- `apps/app/src/components/plugin/FooterStatusLine.tsx` (89 lines):
  - The constants are `FADE_PX = 24` (line 10) and `EDGE_PX = 2` (line 12).
  - `StatusRowFades { start, end }` and `NO_FADES` are at lines 14–19.
  - `useHorizontalFades(scrollRef, contentRef)` (lines 21–58) has the same lifecycle line for line, with `scrollLeft`, `clientWidth` and `scrollWidth` in place of the vertical metrics. It has no `overflows` gate and no `overflows` output.
  - `fadeMask` (lines 60–68) builds `linear-gradient(to right, …)` with 24 px at both ends, in the same `transparent 0, #000 Npx` / `#000 calc(100% - Npx), transparent 100%` stop format.
  - `FooterStatusLine` (lines 70–89) is the only consumer.
- Consumers: `git grep -n -E "useRailScrollFades|railFadeMaskStyle|useHorizontalFades|useScrollOverflowState|RailScrollFades|useRailOverflow|FooterStatusLine" e9e1b74c… -- .` over the whole tree found the following:
  - `apps/app/src/components/sidebar/AppNavRail.tsx` imports the rail helpers at lines 100–102 and calls `useRailScrollFades` twice, at line 475 (`projectFades`) and line 477 (`destinationFades`). It reads `.overflows`, `.fadeTop` and `.fadeBottom` at lines 653, 659–661, 673 and 700–702, which render the separator and the `data-overflowing`, `data-fade-top` and `data-fade-bottom` attributes. It calls `railFadeMaskStyle` at lines 663 and 704.
  - `apps/app/src/components/sidebar/MobileBottomRail.tsx:29` renders `FooterStatusLine`.
  - `apps/app/src/components/sidebar/useRailOverflow.test.ts` covers both rail helpers.
  - Nothing in `packages/`, `plugins/`, the SDK, the plugin SDK, the CLI, scripts or mobile references either hook. Neither hook is a published export. The search is a literal-symbol search, and these are module-local React hooks with no string or manifest addressing.
- Tests that encode the contract:
  - `apps/app/src/components/sidebar/useRailOverflow.test.ts:55-102` asserts the rail result synchronously after a stubbed `ResizeObserver` callback and after a `scroll` event, with no timers. Lines 104–123 assert the exact mask string `linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 40px), transparent 100%)`.
  - `apps/app/src/components/sidebar/AppNavRail.test.tsx:790-824` ("separates and fades the project list only while it overflows") asserts synchronously that the separator and the fade attributes appear and disappear.
  - `apps/app/src/components/sidebar/MobileBottomRail.test.tsx` does not test fades: a grep for `fade|mask|ResizeObserver|scroll` found nothing. The footer fade has no unit coverage today.
- Why the sweep's target hook does not fit: `apps/app/src/components/thread/timeline/useScrollOverflowState.ts` (175 lines) is a different design.
  - It owns `scrollRef`, `topSentinelRef` and `bottomSentinelRef`.
  - Its `measureOverflow` path (lines 52–121) runs in `useEffect` and schedules measurement through `requestAnimationFrame`, with a `setTimeout` fallback. It also observes subtree mutations with a `MutationObserver` and uses a 1 px threshold.
  - Its sentinel path (lines 123–166) uses `IntersectionObserver`.
  - It reports only `aboveOverflow` and `belowOverflow`, with no `overflows` flag.
  - Its seven consumers depend on the sentinel and `enabled` options: `PaletteShell.tsx:65`, `ProjectSelector.tsx:101`, `PluginBrowseControls.tsx:515`, `QueuedMessagesList.tsx:1577`, `ThreadTableOfContents.tsx:721`, `TimelineDetailScroll.tsx:39` and `ToolsView.tsx:107`.

  If the rail moved onto this hook, its first measurement would land after paint. The project separator (`RAIL_SEPARATOR_CLASS`, `my-1 h-px`, rendered from `.overflows`) would then pop in a frame late and shift the layout. Both synchronous rail tests would also need fake timers. Moving the file to a neutral folder would only relocate code, so it is not counted as a gain.
- `apps/app/src/components/secondary-panel/SecondaryPanelTabStrip.tsx:195-237` (`applyEdgeFlags`, `measureCapacity`) is also a different mechanism. It measures content against strip capacity, caches `maxScrollLeft` in refs, and drives wheel-to-horizontal scrolling (around lines 340–370). It is out of scope.

Line counts (Reproduced, `git show e9e1b74c…:<file> | sed -n '<range>p' | wc -l`):

| Range | Lines |
|---|---|
| Rail measurement, `useRailOverflow.ts` 15–85 | 71 |
| Rail mask, `useRailOverflow.ts` 87–104 | 18 |
| Footer measurement, `FooterStatusLine.tsx` 12–58 | 47 |
| Footer mask, `FooterStatusLine.tsx` 60–68 | 9 |
| **Duplicated machinery in scope** | **145** |

Maintenance cost today: a change to the edge threshold, the overflow rule, the observer targets, or the mask format (for example, adding `mask-size` or switching to `mask` shorthand) must be made twice and kept consistent by hand. The footer variant has no test, so drift there would go unnoticed.

**Proposed end state and preservation argument**

What remains:

- One module, `apps/app/src/hooks/useScrollEdgeFades.ts`. `apps/app/src/hooks/` already holds neutral app hooks such as `useAppTheme.ts`. It exports the following:
  - `type ScrollEdgeAxis = "x" | "y"`.
  - `interface ScrollEdgeFades { overflows: boolean; start: boolean; end: boolean }`.
  - `useScrollEdgeFades(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, axis: ScrollEdgeAxis): ScrollEdgeFades`. Its body is the current rail lifecycle verbatim: `useLayoutEffect`, an immediate `update()`, one `ResizeObserver` on the scroller and the content, a passive `scroll` listener, cleanup, and identity-preserving `setState`. `axis` joins the dependency list.
  - `scrollEdgeFadeMask(fades: ScrollEdgeFades, direction: "to bottom" | "to right", startPx: number, endPx: number): CSSProperties | undefined`. It returns `undefined` when neither edge fades. Otherwise it returns `{ maskImage, WebkitMaskImage }` built with the existing stop strings.
- Measurement logic, one function for both axes:

  ```ts
  const SCROLL_EDGE_PX = 2;
  function readScrollEdgeFades(el: HTMLElement, axis: ScrollEdgeAxis): ScrollEdgeFades {
    const y = axis === "y";
    const offset = y ? el.scrollTop : el.scrollLeft;
    const viewport = y ? el.clientHeight : el.clientWidth;
    const extent = y ? el.scrollHeight : el.scrollWidth;
    const overflows = extent > viewport + 1;
    return {
      overflows,
      start: overflows && offset > SCROLL_EDGE_PX,
      end: overflows && offset + viewport < extent - SCROLL_EDGE_PX,
    };
  }
  ```

- `useRailOverflow.ts` keeps `RAIL_SEPARATOR_CLASS`, `RAIL_FADE_TOP_PX` and `RAIL_FADE_BOTTOM_PX`. `railFadeMaskStyle(fades)` shrinks to a one-line wrapper: `scrollEdgeFadeMask(fades, "to bottom", RAIL_FADE_TOP_PX, RAIL_FADE_BOTTOM_PX)`. Alternatively, `AppNavRail.tsx` calls the shared builder directly and the wrapper goes too; pick whichever keeps the rail constants private.
- `FooterStatusLine.tsx` keeps `FADE_PX` and calls `useScrollEdgeFades(scrollRef, contentRef, "x")` and `scrollEdgeFadeMask(fades, "to right", FADE_PX, FADE_PX)`.

What disappears: `readRailScrollFades`, `sameRailScrollFades`, `NO_RAIL_SCROLL_FADES`, the body of `useRailScrollFades`, `RailScrollFades` (replaced by `ScrollEdgeFades`), `RAIL_SCROLL_EDGE_PX`, `useHorizontalFades`, `StatusRowFades`, `NO_FADES`, `EDGE_PX` and `fadeMask`.

Field naming: the rail's fields become `start` and `end` instead of `fadeTop` and `fadeBottom`. `AppNavRail.tsx` updates its six reads, but the DOM attributes `data-fade-top` and `data-fade-bottom` keep their names because `AppNavRail.test.tsx` asserts them.

Preservation argument (Proven by inspection):

- **Rail.** The thresholds (`+ 1` for overflow, 2 px for the edges), the `overflows` gate, the observer targets, the listener options and the synchronous layout-effect timing are identical to today. The rail's first paint, its separator and its fade attributes are therefore unchanged.
- **Footer.** The only change is the new `overflows &&` gate on `start` and `end`, and it is a no-op. When `scrollWidth <= clientWidth + 1`, the maximum `scrollLeft` is at most 1, so today's `start = scrollLeft > 2` is already false. Today's `end = scrollLeft + clientWidth < scrollWidth - 2` is also false, because `scrollLeft + clientWidth >= clientWidth >= scrollWidth - 1`. When the line does overflow, the gate is true. The footer's thresholds, observers and timing are otherwise the same. Its mask string is byte-identical: `linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)` and its single-edge variants.
- **Performance.** The same observers and listeners run per instance (three: two rail columns and one footer). No `MutationObserver` or rAF is added.

Non-goals:

- Leave `useScrollOverflowState` where it is and keep its timing. Moving it to a neutral folder is an optional rename, not a simplification.
- Do not touch `SecondaryPanelTabStrip`.
- Do not migrate `PaletteShell.tsx`'s inline `black 1.5rem` masks to the new builder. Its strings and units differ, and it is driven by `useScrollOverflowState`.

**Expected gain and cost**

- **Before:** 145 handwritten production lines of duplicated measurement and mask code in two files (measured above), with two observer and listener lifecycles and two mask builders.
- **After (projection):** about 80–90 lines in `useScrollEdgeFades.ts` plus about 5–8 lines of wrappers and imports in the two consumers. The projected net reduction is **about 45–60 production lines**, with one lifecycle and one mask builder. The basis is the draft above and the repository's multi-line `oxfmt` style. The real count is unknown until formatted.
- **Tests:** about the same size overall. The hook case moves from `useRailOverflow.test.ts` to `useScrollEdgeFades.test.ts` with renamed fields, and one horizontal case (about 20–30 lines) is added because the footer has no coverage today.
- **Maintenance gain:** the edge threshold, the overflow rule, the observer targets and the mask format each have one owner. A fix to any of them, such as observing another element or changing the mask syntax for a browser, lands once and is covered for both axes.
- **Cost:** a third positional argument (`axis`) and a rename of the rail fields. There is no runtime or performance cost.

**Execution steps**

1. **Reconfirm the baseline.**
   - Confirm that `useRailOverflow.ts`, `FooterStatusLine.tsx` and `AppNavRail.tsx` still match the anchors above: `git log -1 -- <files>` and a read.
   - Re-run the consumer `git grep` from Context on the current tree.
   - Re-plan if any of the following holds: a new consumer of either hook appeared; either hook now gained a `MutationObserver`, rAF or a different threshold; or the footer started reading an `overflows`-like flag with different semantics.
   - Record a baseline by running the tests in the Verification section on the unmodified tree and noting that they pass.
2. **Create the shared module.** Add `apps/app/src/hooks/useScrollEdgeFades.ts` with `ScrollEdgeAxis`, `ScrollEdgeFades`, a private `NO_SCROLL_EDGE_FADES`, a private `readScrollEdgeFades` (the code above), `useScrollEdgeFades` (copy the body of `useRailScrollFades` at `useRailOverflow.ts:59-82`, replacing `readRailScrollFades(scroller)` with `readScrollEdgeFades(scroller, axis)` and inlining the field comparison in `setFades`), and `scrollEdgeFadeMask`. For the mask, port `railFadeMaskStyle` (lines 92–103) with `direction`, `startPx` and `endPx` as parameters, keeping the exact stop strings.
3. **Add a test for the shared module.** Create `apps/app/src/hooks/useScrollEdgeFades.test.ts`:
   - Move the `ControlledResizeObserver` harness and the vertical case from `useRailOverflow.test.ts:7-102` unchanged, except for the field names (`fadeTop` becomes `start`, `fadeBottom` becomes `end`) and `axis: "y"`.
   - Add a horizontal case with the same structure, using `clientWidth`, `scrollWidth` and `scrollLeft` with the metrics 200/500/0, then 120, then 300. Expect `{false,false,false}`, then `{true,false,true}`, `{true,true,true}` and `{true,true,false}`.
   - Add a non-overflowing horizontal case (`clientWidth 200, scrollWidth 201`) expecting all false.
   - Keep the exact rail mask string assertion from lines 119–122 and add the footer's exact `to right … 24px … calc(100% - 24px)` string.

   **Checkpoint:** the new test passes against the new module.
4. **Switch the rail.**
   - In `useRailOverflow.ts`, delete lines 15–85 and the `RailScrollFades` interface.
   - Re-export or replace `railFadeMaskStyle` as a wrapper over `scrollEdgeFadeMask(fades, "to bottom", RAIL_FADE_TOP_PX, RAIL_FADE_BOTTOM_PX)`, and drop the unused `useLayoutEffect`, `useState` and `RefObject` imports.
   - In `AppNavRail.tsx` lines 100–102 and 475–480, import `useScrollEdgeFades` from `@/hooks/useScrollEdgeFades` and call it with `"y"`. Rename the reads at lines 659–661 and 700–702 from `.fadeTop`/`.fadeBottom` to `.start`/`.end`, and keep the `data-fade-*` attribute names.
   - Reduce `useRailOverflow.test.ts` to its mask test, or delete that file if the mask test now lives in the shared test. Do not lose the exact rail mask string assertion.

   **Checkpoint:** run the rail tests listed in the Verification section.
5. **Switch the footer.** In `FooterStatusLine.tsx`, delete lines 12–68, call `useScrollEdgeFades(scrollRef, contentRef, "x")` and `scrollEdgeFadeMask(fades, "to right", FADE_PX, FADE_PX)`, and trim the React imports to `useRef` and `ReactNode`.
6. **Clean up and recount.**
   - Confirm that nothing still references the removed symbols: `rg -n "useHorizontalFades|readRailScrollFades|sameRailScrollFades|RailScrollFades|StatusRowFades|RAIL_SCROLL_EDGE_PX" apps/app/src` should print nothing.
   - Format and lint the changed files.
   - Recount the production lines of the three files against the 145-line baseline and report the actual net change.
   - Inspect the full diff for unrelated edits.

**Verification and acceptance criteria**

Commands. These come from `apps/app/package.json` scripts (`test`: `vitest run --config vitest.config.ts`, `typecheck`, `lint`) and the root `package.json` (`format`, `format:check`). They were not run in this audit because the snapshot had no `node_modules`.

- Run from `$OMNYO_CHECKOUT` (or the execution worktree):

  ```sh
  pnpm --filter @omnyo/app test -- src/hooks/useScrollEdgeFades.test.ts src/components/sidebar/useRailOverflow.test.ts src/components/sidebar/AppNavRail.test.tsx src/components/sidebar/MobileBottomRail.test.tsx
  ```

  Every file should pass. `apps/app/vitest.config.ts` accepts explicit `src/…test.ts(x)` filters. Drop `useRailOverflow.test.ts` from the list if step 4 deleted it.
- `pnpm --filter @omnyo/app typecheck` should report no errors.
- `pnpm exec oxlint --fix <changed files>`, then `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`, following the global Oxc rule. Then run `pnpm --filter @omnyo/app lint` and `pnpm format:check`.

Behavior checks the tests must catch:

- The rail result updates synchronously after a resize and after a scroll, with no timers.
- The separator and the `data-fade-*` attributes appear only while the content overflows. `AppNavRail.test.tsx:790-824` checks this unchanged.
- The exact mask strings for both directions are unchanged.
- The horizontal footer case has the same edge results as today's `useHorizontalFades`.

Visual and interaction checks: Alex checks UI changes himself. Hand over these states:

- The desktop rail with enough projects to overflow, scrolled to the top, the middle and the bottom. The separator and the fades must appear on the first frame without a flash.
- The destination column when it is short.
- The mobile bottom rail (compact viewport) with enough footer status cards to overflow horizontally, scrolled to both ends.

Performance: no comparison is required, because the observers, the listeners and the timing are unchanged by construction. If a reviewer finds an added observer or deferred measurement in the diff, treat that as a plan violation rather than a performance trade-off.

Structural completion:

- `useHorizontalFades` and the rail's private measurement functions are gone.
- `useScrollEdgeFades` is the only scroll-edge fade measurement for these two surfaces.
- `useScrollOverflowState` is unchanged.

**Rollback and stop conditions**

- **Rollback:** the change is three source files, one new module and its test, with no persisted data, API or SDK surface. Reverting the commit restores the previous state.
- **Stop and re-plan** if any of the following happens:
  - A consumer outside `AppNavRail` and `FooterStatusLine` turns up that needs different thresholds.
  - The two surfaces need different observer targets or timing, for example if the footer must react to child mutations.
  - Any existing rail test needs fake timers or changed expectations to pass. That means the timing changed.
  - The mask strings differ from the baseline.
- **Smaller alternative:** if renaming the rail fields meets resistance, keep `fadeTop` and `fadeBottom` by having `useRailOverflow.ts` map the shared result. That costs about 6 lines of the saving but leaves `AppNavRail.tsx` untouched.
