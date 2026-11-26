# RF-102 — Build secondary-panel tab descriptions once

## Rank and disposition

**Potential: high within the client slice. Confidence: high. Readiness: ready. Effort: medium (roughly 1–2 days for the descriptor extraction. Lifecycle expansion is a later checkpoint). Risk: medium.** Rechecks and bounds prior §12. Prefer this before changes that add tab kinds. Independent of RF-103's storage-type cleanup. The gains do not overlap.

## Context and evidence

Snapshot: `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`.

- `apps/app/src/views/RootComposeView.tsx:1269`: `panelTabs` maps the eight `SecondaryFileFixedPanelTab` kinds to `SecondaryPanelRenderableTab` labels, visuals, status, close/select handlers and a render callback.
- `apps/app/src/views/thread-detail/ThreadDetailView.tsx:3431`: `filenameOfPanelTab` and `panelTabs` repeat that mapping. Compared ranges are 131/128 lines, with 109 trimmed-nonblank lines matching in order.
- Both mappings implement the same browser title/host/fallback label, terminal title/status and terminal-specific select/close, workspace status, storage pin marker, attachment name, New Tab label and plugin icon/flush layout.
- `components/secondary-panel/secondaryPanelTab.ts` defines renderable-tab shape. `ThreadSecondaryPanel.tsx` / `SecondaryPanelLayout.tsx` consume it. `usePanelTerminals.ts` already owns terminal creation, cleanup and activation for both views.
- Related repetition exists at `RootComposeView.tsx:1109` / `ThreadDetailView.tsx:1856` (New Tab/reopen/quick-open commands), at 1166 / 1920 (plugin-details-first close path), and at 880 / 1169 (terminal-tab synchronization). These are evidence for a possible later local controller, **not included in the descriptor saving below**.
- Tests: `views/RootComposePanelCommandHandlers.test.tsx`, `components/secondary-panel/usePanelTerminals.test.tsx`, `SecondaryPanelTabStrip.test.ts`, `ThreadSecondaryPanel.test.ts`, `secondaryPanelTabState.test.ts`, `lib/fixed-panel-tabs-sync.test.ts`.

Counterevidence: root content renderer uses `SecondaryPanelPaneRenderContext`, root terminal target, root project/environment and compact drawer reveal. Detail content adds timeline navigation/link routing, thread storage, file-opener original rendering and thread context. `components/plugin/PluginPanelRightPanelHost.tsx` has different panel-host policy/UI and is excluded. A generalized mega-controller would erase these boundaries and is not justified.

## End state and preservation

Add `buildSecondaryPanelRenderableTabs` in `components/secondary-panel/` with the common display mapping. Inputs: ordered tabs. Terminal lookup plus terminal select/close. Plugin-action lookup. Activate/close file-tab callbacks. And `renderContent(tab,pane)`. Output: the existing readonly renderable-tab list. Keep JSX icons/classes/copy byte-for-byte in the moved mapping. Root passes its current pane-aware renderer. Detail passes its existing renderer ignoring unused pane context.

Both views retain content rendering, root/detail context, command registration, drawer behavior and close-window policy at the first checkpoint. A later independently verified extraction may put the equal close dispatch into a small local helper, but only after preserving the plugin-details-first and focused-pane semantics. It must not be required to realize this card's primary saving.

## Expected gain and cost

Of 259 production lines in the two mapping ranges, remove 235–259 and add 125–155 shared mapping/wiring lines. **net 80–125 lines**. Two tab-kind display switches become one. Moved code is not counted as deletion. The estimate accounts for the retained implementation. Tests may add a compact table for eight variants. No test deletion promised. Additional command/lifecycle consolidation could save more but has no counted estimate here. The same map executes on each caller's current schedule. Do not introduce a new state store or alter memoization.

## Execution steps

1. Confirm the eight-kind union and both current mappings. Record terminal status cases, browser URL/title fallbacks, plugin missing-action icon/flush behavior and pinned file output. Stop/replan if a kind now intentionally renders different chrome in one view.
2. Add a pure display-mapping test using real tab shapes and the exact current callbacks/render marker. Cover all eight kinds and missing terminal/plugin metadata. This protects meaningful chrome/callback behavior rather than just asserting the new helper calls itself.
3. Move one mapping into `buildSecondaryPanelRenderableTabs.tsx`. Use the current `SecondaryPanelRenderableTab` and file-tab union. Add no per-view mode enum. Preserve root's memoization and terminal map lookup.
4. Replace the other mapping with the helper. Detail's `renderContent` must still use its existing thread-context renderer, and root must still forward the supplied pane. Keep terminal close/select routed through `usePanelTerminals`, not generic `closeTab`.
5. Remove duplicate filename/mapping helpers and unused icon imports from both views. Do not touch `PluginPanelRightPanelHost` or content switches. Re-evaluate command/close duplication separately after this checkpoint. If taken, preserve and test focused-pane routing and plugin-details priority with no duplicate registration.
6. Run focused tests and app typecheck, inspect both renderer callbacks and the full diff, and recount savings against the exact two ranges.

## Verification and acceptance

Not run in this audit. From repository root:

```sh
pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts src/views/RootComposePanelCommandHandlers.test.tsx src/components/secondary-panel/usePanelTerminals.test.tsx src/components/secondary-panel/SecondaryPanelTabStrip.test.ts src/components/secondary-panel/ThreadSecondaryPanel.test.ts src/lib/fixed-panel-tabs-sync.test.ts
pnpm --filter @omnyo/app typecheck
```

Run the new helper test by its actual added path as well. In each view compare browser empty/title/URL labels, terminal missing/running/ended status and close, workspace deleted status, pinned storage files, attachments, New Tab and plugin default/missing/flush/file-opener cases. Interactions must still select the same tab and terminate a terminal only through terminal cleanup. Compare desktop/narrow drawer chrome and focus only for affected mapping states. Preserve baseline stories (`ThreadSecondaryPanel.stories.tsx`, `FilePreview.stories.tsx`, `BrowserTabStates.stories.tsx`) without updating expected visuals to hide differences.

No performance claim is made. Preserve one traversal and existing memoization boundaries. Compare render counts for tab selection in the existing panel tests if the extraction changes callback stability. Structural acceptance: one tab-display switch, two small caller adapters, unchanged content-rendering owners.

## Rollback and stop

Revert only the descriptor extraction's exact diff. No storage migration is involved. Stop if different icon/copy/layout behavior is discovered, if callback identity creates unnecessary redraws, or if the helper needs switches for root/detail content. Keep the smaller shared display mapping and retain policy in the views. Any later controller expansion must have its own working checkpoint and may not inflate this card's counted savings.
