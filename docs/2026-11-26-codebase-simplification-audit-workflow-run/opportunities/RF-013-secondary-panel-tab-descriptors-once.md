# RF-013 — Replace the two hand-maintained right-panel tab-chrome switches in root compose and thread detail with one shared builder (plugin page adoption gated on a UI decision)

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The two-view consolidation is confirmed and ready. Adopting the builder on the plugin page right panel is a separate, decision-needed checkpoint, because it would change visible tab chrome on plugin pages.
- **Potential:** medium. One eight-arm switch of duplicated presentation rules disappears. The absolute line saving is moderate, but this is the edit site every new right-panel tab kind must touch.
- **Confidence:** high for root compose and thread detail (Proven by inspection). Medium for the plugin page, where the intent behind its different chrome is not recorded.
- **Readiness:** ready for checkpoints 1 to 3. Checkpoint 4 (plugin page) is decision-needed.
- **Effort:** S to M. About half a day to one day for the two views, including a new characterization test. Add about half a day for the plugin page if Alex approves the UI change.
- **Risk:** low for the two views, because the moved code is token-identical apart from three injected values. Medium for the plugin page, because its icons, coarse-pointer sizing, fill rules and terminal filtering are user-visible.
- **Prerequisites:** none.
- **Related and overlapping opportunities:**
  - RF-021 (shared panel commands and the close-window cascade) and RF-038 (terminal-tab reconciliation in `useThreadFileTabs`) were split out of the same sweep finding. They touch neighbouring code in the same two views but not the descriptor switch. Savings are counted separately and do not overlap. Any order works; landing RF-013 first gives the smallest diffs.
  - RF-022 (derive persisted fixed-panel tab types from zod) changes how `SecondaryFileFixedPanelTab` is declared, not its members. The builder's exhaustive switch keeps working.
  - The same opportunity also appears in this audit folder as `opportunities/RF-102-secondary-panel-descriptors.md`, written under an earlier numbering by the continuation pass. That card and this one describe the same two-view change. The index owner should keep one and count the saving once.
- **Why it deserves its place:** both views render the same persisted tab kinds in the same tab strip with the same chrome. Today the rule for each kind lives twice, and the private history shows the copies being edited together. The change is mechanical, the risk is low and the saving is durable.

**Context and evidence**

Snapshot: public Omnyo `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e`. All paths are relative to that snapshot. The audited worktree path was missing at audit time, so files were read with `git -C $OMNYO_CHECKOUT show e9e1b74c3:<path>`. No `node_modules` were present, so no tests were run.

*The subsystem.* The right panel (also called the secondary panel) shows tabs of eight persisted kinds: `browser`, `terminal`, `workspace-file-preview`, `host-file-preview`, `thread-storage-file-preview`, `attachment-file-preview`, `new-tab` and `plugin-panel`. The union is `SecondaryFileFixedPanelTab` from `@/lib/fixed-panel-tabs-state`. Each host page turns its ordered tab list into `SecondaryPanelRenderableTab` objects (`apps/app/src/components/secondary-panel/secondaryPanelTab.ts:23`). Each object carries a label, a leading icon, a status label, a pin flag, select and close handlers, a content renderer and a `contentFillsRegion` flag. `ThreadSecondaryPanel` and `SecondaryPanelTabStrip` consume that list.

*Observed facts (Proven by inspection).*

1. `apps/app/src/views/RootComposeView.tsx:1269-1411` "panelTabs" is a `useMemo` that maps `syncedOrderedSecondaryFileTabs` through an eight-arm switch. It is 143 lines including the dependency list (`sed -n 1269,1411p | wc -l`). Its only consumer is `tabs: panelTabs` at line 1555.
2. `apps/app/src/views/thread-detail/ThreadDetailView.tsx:3431-3557` "filenameOfPanelTab" and "panelTabs" form the same switch without `useMemo`. It is 127 lines. Its only consumer is `tabs: panelTabs` at line 3641.
3. A whitespace-normalized, blank-dropped `difflib.SequenceMatcher` comparison (`python3 -I`, over exactly those ranges) gives 135 root lines and 120 thread lines, with 109 matching in order. The non-matching lines are only:
   - the plugin action list: `rootPanelNewThreadPanelActions` (root, from `usePluginSlots().newThreadPanelActions`, line 837) and `pluginThreadPanelActions` (thread, from `usePluginSlots().threadPanelActions`, line 982);
   - the renderer: root uses `renderContent: (pane) => renderRootPanelTabContent(tab, pane)`, and thread uses `renderContent: () => renderSecondaryTabContent(tab)`;
   - the local filename helper name (`filenameOf` and `filenameOfPanelTab`, both `path.split("/").at(-1) ?? path`), line wrapping, and root's `useMemo` wrapper.
   Every label, icon, class, `aria-hidden`, status rule, `isPinned`, `contentFillsRegion` rule (`plugin-panel` with `fileOpenerOwner !== undefined || pluginAction?.layout === "flush"`), terminal routing (`terminals.select(tab.terminalId)` and `terminals.close(tab.terminalId)`), and file-tab routing (`handleActivateFileTab(tab.id)` and `closeTab(tab.id)`) is identical.
4. In each view the imports `RightPanelFileTabIcon`, `COARSE_POINTER_COMPACT_ICON_SIZE_CLASS`, `PluginItemIcon` and `getBrowserUrlHost` are used only inside this block. In both files `grep -c` gives 5, 5, 2 and 2 occurrences, that is, one import plus the uses in the block. `Icon` is still used elsewhere in both views.
5. Both views already share the inputs: `terminals` comes from `usePanelTerminals` (type `PanelTerminals`, `apps/app/src/components/secondary-panel/usePanelTerminals.ts:37`, with `select(terminalId, target?)` and `close(terminalId)`). `terminalsById` is the same `useMemo(new Map(terminalSessions.map(...)))` in both views (`RootComposeView.tsx:825`, `ThreadDetailView.tsx:1164`).
6. A third producer of the same kinds exists: `apps/app/src/components/plugin/PluginPanelRightPanelHost.tsx:1001-1117` "panelTabs" (117 lines). It differs in behaviour as well as text:
   - Every icon uses `className="size-3.5"` instead of `COARSE_POINTER_COMPACT_ICON_SIZE_CLASS` (`"size-3.5 max-md:pointer-coarse:size-5"`, `packages/shared-ui/src/components/ui/coarse-pointer-sizing.ts:13`), so icons stay small on coarse-pointer mobile. No icon sets `aria-hidden`.
   - All file kinds use a generic `<Icon name="File">` instead of the file-type icon from `RightPanelFileTabIcon`.
   - The filename split is `split(/[\\/]/u)` instead of `split("/")`.
   - Plugin panels use `PluginIcon icon={null}` (there is no plugin-action lookup) and always set `contentFillsRegion: true`.
   - Terminal tabs without `tab.target` are dropped (`flatMap` returns `[]`), terminal tabs set `contentFillsRegion: true`, and terminal select passes `tab.target`.
   - `onSelect` for every non-terminal kind also calls `selectPersistedPanelTab()` and `revealPanel()`.
7. History (private repository `$ARCHIVED_OMNYO_CHECKOUT`, read-only `git log -S`): `81f98d635d` "Convert large text pastes into ordinary attachments" (2026-10-09) added an `attachment-file-preview` arm to all three producers. The plugin host was created in `e8764f7c34` "Give plugin pages the shared right panel" (2026-08-18) and never used `RightPanelFileTabIcon` or the coarse-pointer class (`git log -S'RightPanelFileTabIcon'` and `-S'COARSE_POINTER'` on that file return nothing). Its commit message states that plugin pages "use the same panel shell, controls, sizing, background, and transitions as New thread and thread pages". The tab icons are not mentioned, so whether their difference is intended is unknown.
8. Other `SecondaryPanelRenderableTab` producers do not map these eight kinds and are out of scope (`git grep -n SecondaryPanelRenderableTab e9e1b74c3 -- apps packages`): `apps/app/src/views/ToolsView.tsx:608` (marketplace plugin detail tabs), `PluginPanelRightPanelHost.tsx:775` "pluginDetailTabs", `apps/app/src/components/plugin/plugin-detail-navigation.tsx:243`, and Ladle stories.
9. Test coverage: no test renders either view's tab strip. `apps/app/src/components/plugin/PluginNewThreadComposer.test.tsx:165` renders `RootComposeView` but mocks `SecondaryPanelLayout` to render only `main`. `git grep '"New tab"'` over app tests finds only component-level fixtures. The descriptor mapping is therefore uncovered in both views. `PluginPanelRightPanelHost.test.tsx` covers the plugin page host.

*Non-obvious consumers checked.* The block is component-local and is not exported. There is no string addressing, plugin manifest, SDK or plugin-SDK export, persisted field or CLI reference: the descriptors are derived per render from persisted tabs and are never stored. The search was `git grep -n "panelTabs" e9e1b74c3 -- apps/app/src` together with the producer search above.

*Maintenance cost today.* Adding a tab kind, changing a label or status rule, or changing icon sizing needs matching edits in two switches that must stay token-identical, with no test to catch a mismatch. On plugin pages it needs a third, already different, edit.

**Proposed end state and preservation argument**

*What remains.* One pure function in `apps/app/src/components/secondary-panel/buildSecondaryFileTabDescriptors.tsx`. It is the canonical owner of the per-kind tab chrome for root compose and thread detail:

```ts
import type { ReactNode } from "react";
import type { SecondaryFileFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import type { PanelTerminals } from "./usePanelTerminals";
import type {
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
} from "./secondaryPanelTab";

interface SecondaryFileTabPluginAction {
  pluginId: string;
  id: string;
  icon?: /* the existing icon type of the panel-action slots */;
  layout?: /* the existing layout type, which includes "flush" */;
}

export interface BuildSecondaryFileTabDescriptorsOptions {
  tabs: readonly SecondaryFileFixedPanelTab[];
  pluginActions: readonly SecondaryFileTabPluginAction[];
  terminalsById: ReadonlyMap<string, /* existing terminal session type */>;
  terminals: Pick<PanelTerminals, "select" | "close">;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  renderContent: (
    tab: SecondaryFileFixedPanelTab,
    pane: SecondaryPanelPaneRenderContext,
  ) => ReactNode;
}

export function buildSecondaryFileTabDescriptors(
  options: BuildSecondaryFileTabDescriptorsOptions,
): SecondaryPanelRenderableTab[];
```

The body is the current switch moved verbatim from `ThreadDetailView.tsx:3433-3557`, with the three injected values replacing the view-local names. Take the exact icon and layout types from `PluginThreadPanelActionSlot` and `PluginNewThreadPanelActionSlot` (`apps/app/src/lib/plugin-slots.ts:107-111`) so that both slot arrays are assignable without casts. Typecheck confirms this.

*Call sites.*

- Root: `const panelTabs = useMemo(() => buildSecondaryFileTabDescriptors({ tabs: syncedOrderedSecondaryFileTabs, pluginActions: rootPanelNewThreadPanelActions, terminalsById, terminals, onActivateTab: handleActivateFileTab, onCloseTab: closeTab, renderContent: renderRootPanelTabContent }), [same seven dependencies as today])`. `renderRootPanelTabContent` already has the `(tab, pane)` signature.
- Thread: `const panelTabs = buildSecondaryFileTabDescriptors({ ..., pluginActions: pluginThreadPanelActions, renderContent: (tab) => renderSecondaryTabContent(tab) })`, left unmemoized as today.

*What disappears.* The second eight-arm switch, the two local filename helpers, and four now-unused imports in each view.

*Why this is the simplest sufficient option.* The two copies have the same meaning and invariants. The builder needs no caller-specific flag or branch, only three injected values that already differ by name. A React component or hook would add nothing, because the mapping holds no state. Leaving both copies keeps a silent-drift risk with no test.

*Preserved contracts.* Tab labels (browser title, then URL host, then "Browser"; terminal session title or "Terminal"; filename; attachment name; "New tab"; plugin title), icons and classes byte-for-byte, `aria-hidden`, status labels (workspace `statusLabel`, terminal non-running status), `isPinned` for thread-storage tabs, `contentFillsRegion` for flush and file-opener plugin panels, terminal select and close through `usePanelTerminals` (never the generic `closeTab`), and root's pane-aware rendering (terminal and new-tab autofocus depend on `pane.isFocused`). Allocation and memoization stay as they are: root keeps its `useMemo` with the same dependencies, and thread keeps rebuilding per render under the React Compiler (`apps/app/vite-react-compiler.ts`). No new subscription or state is added.

*Non-goals.* No change to content renderers (`renderRootPanelTabContent`, `renderSecondaryTabContent`), commands, the close-window cascade (RF-021), terminal sync (RF-038), the `terminalsById` memos, or `PluginPanelRightPanelHost` in the ready checkpoints. The plugin page's different chrome (see the incidental finding on plugin-page tab chrome) is not corrected silently inside this refactor.

*Plugin page (checkpoint 4, decision-needed).* If Alex decides plugin-page tabs should match the thread and new-thread chrome (file-type icons, coarse-pointer sizing, `aria-hidden`), the plugin host can call the same builder. It would pass `pluginActions: []`, an `onActivateTab` that wraps `selectPersistedPanelTab(); activateTab(id); revealPanel();`, and a `terminals.select` adapter that forwards `tab.target`. It would filter out target-less terminal tabs before the call. Two plugin-page rules still have no equivalent in the builder: `contentFillsRegion: true` for every terminal and for every plugin panel. Each needs a decision before it becomes a builder option or a post-map override. If keeping them would need more than one small post-map override, keep the plugin page's own switch.

**Expected gain and cost**

Observed baseline (`sed -n <range>p | wc -l` at the snapshot): root block 143 lines, thread block 127 lines, plus 8 import lines that become unused. That is 278 handwritten production lines.

Projection (not measured):

| Item | Lines |
| --- | --- |
| Removed from the two views | about 278 |
| New builder file (imports, options type, switch) | about 125 to 140 |
| Root and thread call sites | about 25 to 35 |
| **Net production reduction, two views** | **about 100 to 125** |
| Plugin page, if approved (removes about 117 lines, adds a 15 to 25 line call site and adapters) | about 90 to 100 more |
| New characterization test (test code, counted separately) | about 120 to 180 added |

The sweep estimates differ for these reasons. S01's 130 to 190 also counted the close-window, command and terminal-sync glue, which now belongs to RF-021 and RF-038. S04's 150 to 220 assumed a plugin-page adoption with no UI decision. S03's 110 to 130 is consistent with this card.

*Mechanisms.* Before: two independently maintained tab-chrome switches for the same tab kinds (three with the plugin page). After: one switch with two callers (three if checkpoint 4 lands).

*Maintenance example.* `81f98d635d` added `attachment-file-preview` by editing both view switches identically, plus the plugin page. After this change the chrome for a new kind is one builder arm plus one test row. Each view still adds its content-renderer case, which is legitimately view-specific.

*Performance.* Hypothesis: neutral. Same objects, same traversal, same memoization boundaries. The builder imports only modules both lazy view chunks already import (`RightPanelFileTabIcon`, `PluginItemIcon`, `getBrowserUrlHost`, shared-ui `Icon` and sizing), so chunk composition should not change materially. The production build's startup-chunk budget check (`apps/app/vite-startup-chunks.ts` reading `apps/app/bundle-budget.json`) confirms this.

**Execution steps**

1. **Reconfirm.** Check out current `main` in your own worktree. Confirm that `RootComposeView.tsx` "panelTabs" and `ThreadDetailView.tsx` "filenameOfPanelTab"/"panelTabs" still match apart from the three injected values. Rerun the normalized diff, or read both blocks side by side. Confirm that `SecondaryFileFixedPanelTab` still has eight kinds. **Re-plan if:** either view now renders any kind with different chrome, a ninth kind exists in only one view, or RF-021 or RF-038 has already moved neighbouring code (then adapt the anchors only).
2. **Characterization test first.** Add `apps/app/src/components/secondary-panel/buildSecondaryFileTabDescriptors.test.tsx`. Write expected values literally from the current source, not from the new helper's output. Cover:
   - browser with a title, with an empty title and a URL (host label), and with no title and an empty URL ("Browser");
   - terminal with a running session (status `null`), an exited session (status equals the session status) and a missing session ("Terminal", status `null`), where select and close call `terminals.select(terminalId)` and `terminals.close(terminalId)` and never `onCloseTab`;
   - a workspace file with a status label, a host file, and thread-storage files pinned and unpinned (`isPinned`);
   - an attachment, which is labelled by `name`;
   - new tab ("New tab");
   - a plugin panel with a matching action (its icon is passed to `PluginItemIcon`, and `layout: "flush"` gives `contentFillsRegion: true`), with `fileOpenerOwner` set (fill `true`), and with no matching action (icon `null`, fill `false`);
   - `renderContent` receiving the tab and the pane argument.
   For icons, assert the rendered element type and props (`name`, `className`, `aria-hidden`), or render each `leadingVisual` with `@testing-library/react` and assert classes. Write the test against the builder signature above and make it pass in step 3.
3. **Checkpoint 1: create the builder from the thread copy.** Move the switch body from `ThreadDetailView.tsx:3433-3557` into `buildSecondaryFileTabDescriptors`. Replace `pluginThreadPanelActions` with `pluginActions`, `handleActivateFileTab` with `onActivateTab`, `closeTab` with `onCloseTab`, and `() => renderSecondaryTabContent(tab)` with `(pane) => renderContent(tab, pane)`. Keep one module-local `filenameOf`. Replace the thread block with the call site described above. Delete `filenameOfPanelTab`. Remove the now-unused imports `RightPanelFileTabIcon`, `COARSE_POINTER_COMPACT_ICON_SIZE_CLASS`, `PluginItemIcon` and `getBrowserUrlHost`, and keep `SecondaryPanelRenderableTab` only if it is still referenced. Run the new test plus app typecheck.
4. **Checkpoint 2: switch root.** Replace the body of the root `useMemo` (`RootComposeView.tsx:1270-1400`) with the builder call, keeping the dependency array unchanged. Remove the same four imports if they become unused. Run the tests and typecheck again.
5. **Checkpoint 3: cleanup and recount.** Confirm that no second copy of the switch remains: `rg -n 'label: "New tab"' apps/app/src` should list only the builder, the plugin page, stories and test fixtures. Format and lint the touched files. Recount the lines removed and added against the step 1 baseline and record them in the PR description.
6. **Checkpoint 4 (decision-needed, plugin page). Investigation gate first.** Present Alex with a before/after comparison of plugin-page tab chrome: file-type icons instead of the generic File icon, coarse-pointer `size-5` instead of `size-3.5` on mobile, and `aria-hidden` icons. Separately, determine whether `contentFillsRegion: true` for plugin-page terminals is required. Render a plugin page terminal with and without the flag in the desktop dev build, and check `ThreadSecondaryPanel`'s handling of that flag. Only if Alex approves the chrome change and the fill rules can be kept with at most one small post-map override, replace `PluginPanelRightPanelHost.tsx` "panelTabs" with the builder call described in the end state. Otherwise stop after checkpoint 3 and record "plugin page keeps its own chrome by decision" in the index.

**Verification and acceptance criteria**

Commands. These were not run in this audit, because the snapshot has no `node_modules`. The script names are confirmed in the snapshot's `apps/app/package.json` (`test`, `typecheck`, `lint`) and the root `package.json` (`format:check`). Run from the repository root:

```sh
pnpm --filter @omnyo/app exec vitest run --config vitest.config.ts \
  src/components/secondary-panel/buildSecondaryFileTabDescriptors.test.tsx \
  src/components/secondary-panel/SecondaryPanelTabStrip.test.ts \
  src/components/secondary-panel/ThreadSecondaryPanel.test.ts \
  src/components/secondary-panel/usePanelTerminals.test.tsx \
  src/components/plugin/PluginNewThreadComposer.test.tsx \
  src/views/RootComposePanelTabContent.test.tsx
pnpm --filter @omnyo/app typecheck
pnpm exec oxlint --fix <touched files> && pnpm exec oxfmt <touched files>
pnpm --filter @omnyo/app lint
```

For checkpoint 4, also run `src/components/plugin/PluginPanelRightPanelHost.test.tsx` with the same vitest command, and run `pnpm --filter @omnyo/app build`, which applies the startup-chunk budget.

Acceptance:

- **Behaviour.** The new characterization test passes against both call paths (the same builder). Terminal close still goes only through `terminals.close`. Root's terminal and new-tab autofocus still receives `pane.isFocused`. Typecheck proves that both slot arrays are assignable to `pluginActions` without casts.
- **UI.** Alex tests UI changes himself, so no screenshot rounds are required for checkpoints 1 to 3. They are a pure move with byte-identical JSX, which the diff review confirms. A reviewer should check in the diff that every `leadingVisual` JSX element, class constant and `aria-hidden` attribute is unchanged. Checkpoint 4 is a deliberate UI change and needs the owner's explicit approval of the comparison from step 6.
- **Performance.** No claim is made. Root's dependency array is unchanged, and thread detail still builds the list unmemoized. If the build reports a startup-chunk budget change, stop and investigate.
- **Structure.** Exactly one switch over the eight kinds serves root compose and thread detail. Neither view imports the four tab-chrome modules any more. The net production line reduction is in the projected range, or the PR states the actual figure.

**Rollback and stop conditions**

- **Rollback.** Each checkpoint is a self-contained commit with no persisted data, migration or public API involved. Reverting the commit restores the inline switch. Revert only this change's commits, never unrelated work.
- **Stop if:**
  - the two views' copies have diverged in meaning since the snapshot (keep both, record why, and re-plan);
  - the builder would need a caller-mode flag or per-view branch (the shared meaning no longer holds);
  - the slot action types cannot be unified without casts (re-plan the `pluginActions` type, or pass a `findPluginAction(tab)` callback instead);
  - the build's chunk budget changes;
  - for checkpoint 4, Alex declines the plugin-page chrome change or the fill rules need more than one override. Then keep the plugin page's own switch; the two-view saving stands on its own.
