# RF-021 — Give the right-panel Cmd+W cascade and the new-tab, reopen and quick-open commands one owner for New Thread and thread detail

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real and exact, but the sweep overstated the line gain. The plugin-detail visibility part is dropped (see "Rejected sub-leads" below).
- **Potential:** low. The main gain is one owner for a user-facing keyboard rule, not line count. About 10 to 40 handwritten production lines go away net.
- **Confidence:** high that the code is duplicated and that the shared version can keep today's behavior. This is proven by inspection, not executed.
- **Readiness:** ready. The sweep's gate was "confirm that command dispatch does not depend on registration order". That gate is resolved by inspection (see Context). Step 1 asks the executor to recheck it on the current checkout.
- **Effort:** S to M, about half a day including the cascade test.
- **Risk:** low to medium. A regression would show as Cmd+W, Cmd+T, Cmd+Shift+T or quick open doing the wrong thing in one of the two views, or acting in an unfocused split pane.
- **Prerequisites:** none.
- **Related and overlapping:**
  - RF-013 (tab descriptors built once) edits the same two views and consumes `handleActivateFileTab` in its `onSelect` closures. Either order works. If RF-013 lands first, the hook simply supplies the callback it uses.
  - RF-038 (terminal tab reconciliation in `useThreadFileTabs`) touches `terminals.close`, which the close cascade calls. If RF-038 changes that signature, adapt the `closeTerminal` input.
  - RF-089 (root compose navigation state) and RF-087 (thread action keyboard commands table) touch the same files but different symbols. No line overlap.
  - The thread-only legacy `desktopInfo.onOpenNewTab` bridge is tracked by the sweep's ISS-S01 issue. This card keeps that bridge unchanged.
- **Why it deserves its place:** two copies of the same 28-line Cmd+W rule and two copies of the same panel command handlers must be edited together today. An existing generic component, `RootComposePanelCommandHandlers`, is used by only one of its two natural callers. The other caller, thread detail, re-implements it inline. The change is small, local and low risk, so it ranks below the large deletions.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26), read from the Git object store with `git show <commit>:<path>`. The snapshot worktree path named in the task no longer existed, so the files were read straight from the commit. No tests were run, because the snapshot has no `node_modules`.

Both the New Thread view and thread detail host the same right-hand secondary panel. The panel has file, browser, terminal and plugin-detail tabs and a compact-viewport drawer. Each view wires the same keyboard and desktop commands to that panel. The scope is the web app `apps/app` and the Electron desktop shell's close-window and new-tab bridges.

Observed facts (Proven by inspection):

1. **The Cmd+W close cascade is identical.**
   - Locations: `apps/app/src/views/RootComposeView.tsx:1166` `handleCloseWindowRequest` and `apps/app/src/views/thread-detail/ThreadDetailView.tsx:1920` `handleCloseWindowRequest`.
   - Size: 29 nonblank lines each after whitespace normalization, including the dependency array, and identical. This was compared with `python3 -I -c` over the extracted files.
   - Order:
     1. If a plugin detail is active, close it.
     2. Else, if the panel is closed, return `false`.
     3. Else, if the active tab is a file tab (`isSecondaryFileTab`), close it. A terminal closes through `terminals.close(terminalId)`. Any other file tab closes through `closeTab(id)`.
     4. Else, close the panel.
2. **The tab command callbacks are identical apart from two naming differences.**
   - Locations: `RootComposeView.tsx:1087-1126` (34 nonblank lines) against `ThreadDetailView.tsx:1672-1686` and `1850-1873` (14 + 20 nonblank lines).
   - Callbacks: `handleSelectFileSearchResult`, `handleActivateFileTab` and `handleOpenNewTab`, and `useAppCommandHandler` for `"panel.newTab"`, `"panel.reopenClosedTab"` and `"file.quickOpen"`.
   - Difference 1: `isFocusedPane` in root compose and `isFocused` in thread detail.
   - Difference 2: root compose calls `openTab({ kind: "new-tab" })`. Thread detail calls `openNewTab()`, a 3-line wrapper at `ThreadDetailView.tsx:1050` that calls the same `openTab({ kind: "new-tab" })`. That wrapper's only consumer is `handleOpenNewTab`. A search for `openNewTab` finds only lines 1050, 1851 and 1854.
   - The `shouldAutoFocusNewTab` state and `handleNewTabAutoFocusHandled` are also duplicated: `RootComposeView.tsx:830-835` and `ThreadDetailView.tsx:908-913`, 5 nonblank lines each.
3. **Thread detail re-implements the existing panel command component inline.**
   - `apps/app/src/views/RootComposePanelCommandHandlers.tsx` `RootComposePanelCommandHandlers` (41 lines) registers four things, all gated on `isFocused`:
     - `"panel.toggle"`
     - `useWindowRightPanel({ isOpen, enabled: isFocused })`
     - `"panel.close"`
     - the desktop `onCloseWindowRequest(onClose)` effect
   - Root compose renders it at `RootComposeView.tsx:1524`.
   - Thread detail repeats the same four registrations inline. `"panel.toggle"` plus `useWindowRightPanel` is at `ThreadDetailView.tsx:1956-1962`, `"panel.close"` is at `1977-1981`, and the desktop effect is at `1995-2010`. Together they are 23 nonblank lines. Two thread-only handlers sit between them, `"panel.fullScreen.toggle"` (1963) and `"diff.toggle"` (1982).
   - The desktop effect's null check is written differently (`desktopInfo === null || desktopInfo.onCloseWindowRequest === undefined` against `desktopInfo?.onCloseWindowRequest === undefined`), but the two checks are equivalent.
   - Only the `onToggle` callback differs between the views, and the component already takes it as a prop. Root compose passes `handleToggleSecondaryPanel`, which opens a new tab when the panel is closed. Thread detail passes `toggleSecondaryPanel` (`ThreadDetailView.tsx:1591`), which closes plugin details or toggles the workspace panel.
4. **Consumers outside the two views.**
   - `apps/app/src/views/RootComposePanelCommandHandlers.test.tsx` checks focused-pane routing of the shortcuts and the desktop close handler.
   - `apps/app/src/components/plugin/PluginNewThreadComposer.test.tsx:146` mocks `@/views/RootComposePanelCommandHandlers` by module path and export name. The mock renders a button that calls the real `onClose` from `RootComposeView`. The test at line 2206 uses it to check that Cmd+W closes an active plugin detail without closing a terminal.
   - No other references were found. The search was `git grep -n RootComposePanelCommandHandlers <commit>` across the whole repository.
   - No published SDK, plugin SDK, plugin manifest, CLI or persisted data refers to these symbols. They are app-internal React code.
   - No test covers the thread-detail cascade. The search was `git grep -l -E "onCloseWindowRequest|panel\.close|..." <commit> -- 'apps/app/src/**/*.test.*'`. None of the matching files exercises `ThreadDetailView`'s cascade.
5. **The registration-order gate holds by inspection.**
   - `apps/app/src/components/commands/AppCommandProvider.tsx:258` `dispatch` sorts a command's handlers by `priority` descending, then by `sequence` descending, so the later registration runs first. It stops at the first handler that returns `true`.
   - Every handler moved by this plan returns `false` unless its pane is focused. The other registrants of the same commands are:
     - `apps/app/src/views/thread-detail/SplitWorkspaceSecondaryPanelHost.tsx:176`, which handles `"panel.toggle"` only when `model === null`
     - `apps/app/src/components/plugin/PluginPanelRightPanelHost.tsx:652-690`, which is gated on `isFocused && panel !== null` on plugin pages
   - Only one pane is focused at a time, so at most one handler claims each command and order does not change the outcome.
   - `useWindowRightPanel` (`apps/app/src/components/layout/WindowRightPanelToggle.tsx:36`) appends enabled registrations to a jotai atom, and the toggle reads `.at(-1)`. Moving thread detail's call into a child component changes only its effect order relative to thread detail's own subtree. Nothing else in that subtree registers `useWindowRightPanel`.
   - `ThreadDetailViewInternal` has a single top-level `return` (`ThreadDetailView.tsx:3720`). It already renders command-only children such as `ThreadArchiveCommandHandler`, so a child placed there is always mounted while the hooks are.
   - The desktop preload (`apps/desktop/src/preload.ts:677`) calls every close-window listener and reports whether any of them handled the request.
6. **Desktop bridges.** `apps/desktop/src/main.ts:1072` `openNewTab` sends both the legacy `omnyo-desktop:open-new-tab` channel and the app command `"panel.newTab"`. Thread detail subscribes to `onOpenNewTab` only when the preload lacks `onAppCommand` (`ThreadDetailView.tsx:1874-1890`), which serves older desktop shells. Root compose has no such bridge. That divergence already exists and stays out of scope.

Current maintenance cost: changing what Cmd+W closes, or changing how a new tab is revealed and focused, requires two identical edits in two large files (1,579 and 3,748 lines). Thread detail also keeps a third copy of the component's four registrations. Nothing enforces that the copies agree, and only the root compose copy has tests.

Rejected sub-leads (do not repeat):

- **Plugin-detail visibility** (`RootComposeView.tsx:683-708` against `ThreadDetailView.tsx:822-849`). The `usePluginDetailPanelState` arguments differ (panel state id and history-key inputs), so only `isSecondaryPanelOpen` and the `usePublishVisiblePanel` tab mapping, about 12 lines each, are shared. A hook taking four inputs would save close to zero lines. `PluginPanelRightPanelHost.tsx:369` has its own shape. Not material. If anything, it belongs with RF-013.
- **Folding `PluginPanelRightPanelHost` into this owner.** Its reopen command restores plugin-page destinations through its own `openedPluginIds` state, and it has no `"panel.close"` handler. That is a different policy, not the same rule. See newIssues for the missing close handling.
- **Turning `RootComposePanelCommandHandlers` into a hook.** That would break the module-path mock in `PluginNewThreadComposer.test.tsx` and would not remove more lines. Keep it as a component.

**Proposed end state and preservation argument**

What remains:

1. `apps/app/src/components/secondary-panel/SecondaryPanelCommandHandlers.tsx` exports `SecondaryPanelCommandHandlers`. This is today's `RootComposePanelCommandHandlers` moved and renamed, with identical props `{ isFocused, isOpen, onClose, onToggle }` and an identical body. Both views render it.
2. `apps/app/src/components/secondary-panel/useSecondaryPanelCloseRequest.ts` exports the one cascade:

   ```ts
   export function useSecondaryPanelCloseRequest(input: {
     activeTab: SecondaryFixedPanelTab | null;
     closePanel: () => void;
     closeTab: (tabId: string) => void;
     closeTerminal: (terminalId: string) => void;
     isOpen: boolean;
     pluginDetails: { activePluginId: string | null; close: (pluginId: string) => void };
   }): () => boolean;
   ```

   The body is today's cascade verbatim. Its `useCallback` dependencies are the six inputs. Today's callers pass the whole `terminals` object. This hook receives `terminals.close` instead, which only narrows identity changes and does not change behavior.
3. `apps/app/src/components/secondary-panel/useSecondaryPanelTabCommands.ts` exports:

   ```ts
   export function useSecondaryPanelTabCommands(input: {
     isFocused: boolean;
     activateTab: (tabId: string) => void;
     openTab: (request: { kind: "new-tab" }) => void; // or the useThreadFileTabs openTab type
     reopenClosedTab: (pluginDetails?: PluginDetailHistoryTarget) => boolean;
     selectFileSearchResult: (selection: FileSearchSelection) => void;
     pluginDetails: PluginDetailHistoryTarget;
     reveal: () => void; // today's openCompactDrawer
   }): {
     handleActivateFileTab: (tabId: string) => void;
     handleOpenNewTab: () => void;
     handleSelectFileSearchResult: (selection: FileSearchSelection) => void;
     shouldAutoFocusNewTab: boolean;
     handleNewTabAutoFocusHandled: () => void;
   };
   ```

   The body holds today's `shouldAutoFocusNewTab` state, the three callbacks, and the three `useAppCommandHandler` registrations, each gated on `isFocused`, in today's order.

   - Take the exact parameter types from `useThreadFileTabs` (`apps/app/src/components/secondary-panel/useThreadFileTabs.ts:283`). For example, use `Pick<ReturnType<typeof useThreadFileTabs>, "activateTab" | "openTab" | "reopenClosedTab" | "selectFileSearchResult">` instead of restating the signatures.
   - `pluginDetails` is the same object both views already pass to `reopenClosedTab`.

What disappears:

- the second copy of the cascade
- the second copy of the tab callbacks, commands and auto-focus state
- thread detail's inline copy of the four panel registrations
- thread detail's `openNewTab` wrapper
- the root-compose-only name of a component that is generic

What stays view-specific:

- `onToggle`: root compose's `handleToggleSecondaryPanel` and thread detail's `toggleSecondaryPanel`
- thread detail's `"panel.fullScreen.toggle"` and `"diff.toggle"` handlers
- thread detail's legacy `desktopInfo.onOpenNewTab` effect
- thread detail's `handleRevealBrowserTab`, which consumes `handleActivateFileTab`
- each view's `usePluginDetailPanelState`, `isSecondaryPanelOpen` and `usePublishVisiblePanel`
- everything else, including git diff and pane maximize

Preservation argument:

- Behavior is unchanged by construction, because the moved bodies are verbatim and the only inputs that differ are passed in as arguments.
- All of these keep their meaning:
  - the commands `panel.toggle`, `panel.close`, `panel.newTab`, `panel.reopenClosedTab` and `file.quickOpen`
  - the desktop `onCloseWindowRequest` return value, where `true` keeps the window open
  - the compact-drawer reveal
  - the auto-focus of the new-tab search
  - the plugin-detail-first close order
  - the `false` result that lets the desktop close the window when the panel is closed
- Focus gating and command routing in split panes are unchanged, for the ordering reasons in Context item 5.
- No persisted format, route, setting key, SDK export or CSS changes. The UI states involved are panel open or closed, compact drawer, and active tab kind (terminal, file, browser, fixed tab, plugin detail).

Non-goals:

- Do not add the legacy `onOpenNewTab` bridge to root compose.
- Do not add `"panel.close"` to `PluginPanelRightPanelHost`.
- Do not change toggle semantics.
- Do not merge the plugin-detail visibility code.

Any of these would be a behavior change that needs its own decision.

**Expected gain and cost**

Counted with nonblank lines over the cited ranges at the snapshot.

| | Root compose | Thread detail | Total |
|---|---|---|---|
| Removed (observed) | 67 (lines 1087-1126, 830-835 and 1166-1199) | 93 (lines 1672-1686, 1850-1873, 908-913, 1050-1052, 1920-1953, the `panel.toggle` and `useWindowRightPanel` part of 1956-1962, 1977-1981 and 1995-2010) | 160 |
| Added (projection) | | | about 120 to 150 |

The additions break down as follows:

- the tab-commands hook: about 50
- the close hook: about 40
- two call sites per view: about 22 each with oxfmt line breaking
- the thread-detail component render and imports: about 10

**Net handwritten production change:** about 10 to 40 lines removed. The component move is not counted as a gain.

The sweep's figure of 90-130 lines did not count the call-site and signature lines the shared hooks need.

**Tests:**

- `RootComposePanelCommandHandlers.test.tsx` moves with a rename, for no net change.
- The module path and export name in the `PluginNewThreadComposer.test.tsx` mock change, a 2-line edit.
- A recommended new unit test for the cascade hook adds about 60 to 90 lines. It is warranted because thread detail's Cmd+W path has no coverage today.

**Mechanisms:**

| | Before | After |
|---|---|---|
| Cmd+W cascades | 2 | 1 |
| Tab command handler sets | 2 | 1 |
| Panel registrations | 1 generic component plus 1 inline copy | 1 component used by both views |

**Maintenance example:** suppose Cmd+W should close the active browser tab before the plugin detail. Today that takes two identical edits, and only one of them is tested. After this change it takes one edit in `useSecondaryPanelCloseRequest`, covered by one test.

**Performance:** neutral by inspection. Callback identities and effect registrations are equivalent. The new modules are imported by views that are already lazily loaded (`LazyRootComposeView`, `LazyThreadDetailView`). No measurement was made.

**Execution steps**

1. **Reconfirm the anchors.** On a fresh checkout, re-run the commands below in `apps/app/src` and confirm the two cascades are still identical apart from whitespace. Re-plan if either view has diverged on purpose, for example if one cascade gained a browser-tab branch.

   ```
   rg -n "handleCloseWindowRequest|panel\.newTab|panel\.reopenClosedTab|file\.quickOpen|panel\.close|onCloseWindowRequest|RootComposePanelCommandHandlers" apps/app/src
   rg -n "sort\(|sequence" apps/app/src/components/commands/AppCommandProvider.tsx
   ```

   Also stop and re-plan if `AppCommandProvider` dispatch no longer uses first-claim-wins, or if a new handler for these commands exists that does not check focus. Check whether RF-013 or RF-038 has already landed, and adapt the names they changed.
2. **Characterize the cascade.** Add `apps/app/src/components/secondary-panel/useSecondaryPanelCloseRequest.test.tsx`, using jsdom and `renderHook` from `@testing-library/react` as in the existing tests. Cover each case with plain `vi.fn()` inputs:
   - active plugin detail: calls `pluginDetails.close(id)` and returns `true`
   - panel closed: returns `false`
   - active terminal tab: calls `closeTerminal(terminalId)` and not `closeTab`
   - active non-terminal file tab: calls `closeTab(id)`
   - active fixed, non-file tab: calls `closePanel()`

   Write it against the hook signature, then create the hook by copying the cascade body from `RootComposeView.tsx:1166` unchanged.
3. **Checkpoint A, the close hook.** Replace `handleCloseWindowRequest` in both views with `useSecondaryPanelCloseRequest({ activeTab: activeFixedSecondaryTab, closePanel: closeSecondaryPanel, closeTab, closeTerminal: terminals.close, isOpen: isSecondaryPanelOpen, pluginDetails })`. Keep each call where today's definition sits, after `usePanelTerminals`. Remove the now-unused `isSecondaryFileTab` import from either view if nothing else uses it. Run the tests listed under Verification.
4. **Checkpoint B, the component.** Move the files with `git mv`:
   - `apps/app/src/views/RootComposePanelCommandHandlers.tsx` to `apps/app/src/components/secondary-panel/SecondaryPanelCommandHandlers.tsx`
   - its test to `apps/app/src/components/secondary-panel/SecondaryPanelCommandHandlers.test.tsx`

   Then make these edits:
   - Rename the component and its props interface, and update the test's import and `describe` name.
   - In `RootComposeView.tsx`, update the import at line 158 and the JSX at line 1524.
   - In `PluginNewThreadComposer.test.tsx:146`, change the mocked module path to `@/components/secondary-panel/SecondaryPanelCommandHandlers` and the mocked export name to `SecondaryPanelCommandHandlers`.
   - In `ThreadDetailView.tsx`, delete the inline `"panel.toggle"` handler, the `useWindowRightPanel` call, the `"panel.close"` handler and the desktop `onCloseWindowRequest` effect (lines 1956-1962, 1977-1981 and 1995-2010).
   - Keep `"panel.fullScreen.toggle"` and `"diff.toggle"` exactly where they are.
   - Render `<SecondaryPanelCommandHandlers isFocused={isFocused} isOpen={isSecondaryPanelOpen} onClose={handleCloseWindowRequest} onToggle={toggleSecondaryPanel} />` as the first child inside the `ThreadGitProvider` in the single `return` at `ThreadDetailView.tsx:3720`, next to `ThreadArchiveCommandHandler`.
   - Drop the `useWindowRightPanel` import from thread detail if it is now unused.

   Run the tests again.
5. **Checkpoint C, the tab commands.** Create `useSecondaryPanelTabCommands.ts` from `RootComposeView.tsx:1087-1126` plus the auto-focus state at `830-835`. The new-tab call is `openTab({ kind: "new-tab" })`, and the focus check uses the `isFocused` input.
   - In root compose, call the hook at line 1087 with `isFocused: isFocusedPane` and `reveal: openCompactDrawer`, and destructure the five outputs. Delete lines 830-835 and 1087-1126.
   - In thread detail, call it at line 1672, which is before `handleRevealBrowserTab` consumes `handleActivateFileTab`. Delete lines 908-913, the `openNewTab` wrapper at 1050-1052, the callbacks at 1672-1686, and `handleOpenNewTab` and the three handlers at 1850-1873.
   - Keep the legacy `desktopInfo.onOpenNewTab` effect at 1874-1890 unchanged. It now uses the hook's `handleOpenNewTab`.
   - Check that every existing consumer still receives the same callback: `shouldAutoFocusNewTab` and `onAutoFocusNewTabHandled` / `onAutoFocusHandled` props (`RootComposeView.tsx:1220-1262` and `ThreadDetailView.tsx:3287-3293`), `onOpenNewTab` (`RootComposeView.tsx:1564`, `ThreadDetailView.tsx:3652`), and the `onSelect` closures.
6. **Clean up and recount.** Delete any import left unused (`useState` or `useCallback` only if truly unused). Confirm that `rg -n "RootComposePanelCommandHandlers|handleCloseWindowRequest = useCallback" apps/app/src` returns nothing. Recount the nonblank lines removed and added against this card's baseline, and inspect the full diff for unrelated edits.

**Verification and acceptance criteria**

These commands were identified from `apps/app/package.json` scripts (`test` is `vitest run --config vitest.config.ts`, plus `lint` and `typecheck`) and from the root `package.json` (`format:check` is `oxfmt . --check`). They were not executed in this audit.

- From the repository root, run the focused tests: `pnpm --filter @omnyo/app test src/components/secondary-panel/SecondaryPanelCommandHandlers.test.tsx src/components/secondary-panel/useSecondaryPanelCloseRequest.test.tsx src/components/plugin/PluginNewThreadComposer.test.tsx src/views/RootComposeSecondaryContent.test.tsx src/views/thread-detail/ThreadDetailSecondaryContent.test.tsx src/components/plugin/PluginPanelRightPanelHost.test.tsx`. All must pass with unchanged assertions. The moved component test keeps its focused-pane and desktop-close assertions unchanged.
- Run the type check, `pnpm --filter @omnyo/app typecheck`. It must pass.
- Run lint and format for the changed files: `pnpm exec oxlint --fix <changed files>`, then `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`. Finally run `pnpm format:check` from the root.
- Manually check the desktop and web app (Alex tests UI himself). Do this in both New Thread and a thread, and in a two-pane split with each pane focused in turn:
  - Cmd+W closes an open plugin detail first, then the active terminal, then the active file or browser tab, then the panel. With the panel closed, Cmd+W lets the desktop close the window.
  - Cmd+T and quick open add a focused new-tab search and open the compact drawer on a narrow viewport.
  - Cmd+Shift+T reopens the last closed tab or plugin detail.
  - Cmd+P (the panel toggle) keeps each view's toggle semantics.
  - The title-bar right-panel toggle reflects the focused pane.
  - Only the focused split pane reacts.
- **Structural completion:** one cascade (`useSecondaryPanelCloseRequest`) and one tab command owner (`useSecondaryPanelTabCommands`) exist. `SecondaryPanelCommandHandlers` is rendered by both views. Thread detail contains no `"panel.toggle"`, `"panel.close"`, `"panel.newTab"`, `"panel.reopenClosedTab"` or `"file.quickOpen"` handler.

**Rollback and stop conditions**

Each checkpoint (A, B, C) is a separate local commit touching only `apps/app/src`. Reverting a checkpoint restores the earlier code. There is no data or compatibility impact.

Stop and re-plan in any of these cases:

- **The cascades have drifted.** The two cascades are no longer identical on the current checkout. Decide which behavior is intended before merging them.
- **Dispatch has changed.** `AppCommandProvider` dispatch, or `useWindowRightPanel`'s last-registration-wins rule, has changed so that registration order decides the outcome.
- **A test fails.** Any listed test fails in a way that would need an assertion changed instead of an import updated.
- **Manual testing finds a regression.** For example, Cmd+W closes the window while a panel tab is open, or an unfocused pane handles a shortcut.

If checkpoint C turns out awkward, for example because RF-013 reshaped the callbacks, ship only A and B. They carry most of the duplicated-rule benefit.
