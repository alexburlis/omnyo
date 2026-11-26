# RF-086 — Remove the plugin detail page's second copy of the uninstall flow by reusing `usePluginRemoval` and `PluginRemovalDialog`

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds as described. Three details are corrected below: the line anchors, the claimed catalog-search bug (realtime already covers it while connected), and the pending-state wiring (the hook must expose the pending plugin id).
- **Potential:** low. About 40 handwritten production lines go away. What matters more is that one user-facing contract stops having two owners: the uninstall mutation, its four toast strings and its confirmation dialog.
- **Confidence:** high. Proven by inspection.
- **Readiness:** ready.
- **Effort:** S, about 1 to 2 hours including one new focused test.
- **Risk:** low. The copy, the dialog component and the server call are identical. The only behavior differences are listed under "Proposed end state".
- **Prerequisites:** none.
- **Related or overlapping opportunities:** none overlap. This card is unrelated to RF-033 (plugin install and update job queues) and to RF-063 (typed plugin routes). It mentions the sweep lead ISS-S03-002 (catalog search not invalidated after removal on the detail page). That lead is downgraded here; see "Context and evidence".
- **Why it deserves its place:** it is a cheap, safe consolidation of a duplicated user-facing flow that has already drifted (the cache handling and the `removable` guard differ). It is a quick win, not a large reduction.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The audit worktree had been removed, so every file was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e:<path>`.

The Omnyo web app (`apps/app`) offers plugin uninstall in two places:

1. **The Plugins overview.** `apps/app/src/components/plugin/PluginsOverview.tsx:65` calls `usePluginRemoval()`. Line 225 (`uninstallCatalogEntry`) calls `removal.open(plugin)`, and line 349 renders `<PluginRemovalDialog removal={removal} />`.
2. **The plugin detail page.** `apps/app/src/views/ToolsView.tsx:157` `PluginDetailToolView` hand-builds the same flow. The detail page is mounted by `PluginsView` (`ToolsView.tsx:630`) and by `PluginDetailPaneView` (`ToolsView.tsx:486`). Through `LazyPluginDetailPaneView` (`apps/app/src/views/ToolsViewSplits.tsx:11`), that pane appears in the settings split, the thread split area and the overview.

Observed facts (Proven by inspection):

- `apps/app/src/components/plugin/management/usePluginRemoval.tsx:23` `usePluginRemoval` does the following:
  - It holds `target` state and runs a `useMutation` whose `mutationFn` (lines 29-35) rejects non-`removable` plugins and otherwise calls `removePlugin(fetch, plugin.id)`.
  - On success (lines 36-48) it shows `pluginToast.success("Plugin removed from Omnyo" | "Plugin uninstalled", plugin, "catalog")`, runs `setTarget(null)` and `invalidatePluginCatalogSearch`, and returns `invalidatePluginList`.
  - On error (lines 49-58) it shows `pluginToast.error("Plugin removal failed" | "Plugin uninstall failed", plugin, "installed", pluginAdminErrorMessage(error))`.
  - It returns `{ target, pending, open, close, confirm }`. `open` ignores non-removable plugins, and `close` and `confirm` do nothing while the mutation is pending.
- `usePluginRemoval.tsx:80` `PluginRemovalDialog` renders `ConfirmDeleteDialog` and `ConfirmDeleteDialogContent` with the title `"Remove plugin from Omnyo?" | "Uninstall plugin?"`, `pluginRemovalDescription`, `pluginRemovalLabel`, `pending`, `onConfirm={removal.confirm}` and `onCancel={removal.close}`.
- `ToolsView.tsx` duplicates this:
  - line 214 `const [deleteTarget, setDeleteTarget] = useState<PluginListItem | null>(null);`
  - lines 255-279 `const pluginDelete = useMutation(...)`. It has the same `meta`, the same `removePlugin` call (without the `removable` guard), the same four toast strings with the same `"catalog"`/`"installed"` arguments, and the same `pluginAdminErrorMessage`. On success it also calls `navigate(getToolsOwnedCollectionRoutePath("plugins"))` and returns `listQuery.refetch()` instead of the cache-owner invalidations.
  - lines 298-303 `pendingPluginId` reads `pluginDelete.isPending && pluginDelete.variables ? pluginDelete.variables.id : …`.
  - line 377 `onDelete={setDeleteTarget}` on `PluginDetail`.
  - lines 452-472: the dialog markup, a copy of `PluginRemovalDialog`'s output.
  - import lines that exist only for this flow: 22-25 (`ConfirmDeleteDialog`, `ConfirmDeleteDialogContent`), 46-47 (`pluginRemovalDescription`, `pluginRemovalLabel`), 54 (`removePlugin`), 59 (`pluginAdminErrorMessage`) and 69 (`pluginToast`). I listed each symbol's uses with `grep -n "\b<symbol>\b"` over the extracted file. Each of these symbols is used only in the removal flow. `pluginIsLocalSource` (line 232), `useMutation` (line 238, `pluginToggle`) and `getToolsOwnedCollectionRoutePath` (needed for the navigation) must stay.
- The differences between the two copies are all harmless:
  - **`removable` guard.** `PluginDetail` already disables the Uninstall menu item when `!plugin.removable` (`apps/app/src/components/tools/PluginDetail.tsx:448-452`). The test `ToolsView.plugin-detail.test.tsx:656-734` ("disables Uninstall for a core plugin") encodes this, so the hook's guard changes nothing reachable.
  - **Cancel while pending.** `ToolsView` allows `onCancel` while pending and the hook does not. The `ConfirmDeleteDialogContent` cancel button is `disabled={pending}` (`packages/shared-ui/src/components/ui/confirm-delete-dialog.tsx:45`), so users see no difference.
  - **List refresh.** `listQuery.refetch()` and `invalidatePluginList` (`apps/app/src/hooks/cache-owners/plugin-cache-owner.ts:83`) both refresh the active plugin list. `invalidatePluginList` also covers every other `allPluginListQueryKeyPrefix()` query.
  - **Catalog search.** The hook additionally calls `invalidatePluginCatalogSearch` (`plugin-cache-owner.ts:111`).
- **Counterevidence on ISS-S03-002.** The server's `remove` (`apps/server/src/services/plugins/plugin-service.ts:2004`) calls `notifyPluginsChanged()` at line 2055. That function emits `"plugins-changed"` (line 1023). The client maps `"plugins-changed"` to `dirtyPluginManagementQueries` (`apps/app/src/hooks/cache-owners/realtime-cache-registry.ts:697-705`), which includes `allPluginCatalogSearchQueryKeyPrefix()` (line 1587). The detail page's missing explicit invalidation therefore only matters while the realtime connection is down. It is a minor gap, not a user-visible defect in normal operation. Hypothesis: a stale "installed" badge can appear after an offline-realtime removal; this was not reproduced.
- **Tests.** `apps/app/src/views/ToolsView.plugin-detail.test.tsx:1805` ("plugin removal confirmation") renders `PluginsView detailKey="github"`, opens "Remove from Omnyo" and asserts the dialog heading and description. No test in `apps/app` or `packages` covers removal success: navigation, toasts or cache refresh. The search was `git grep -ln "Plugin uninstalled\|Plugin removed from Omnyo\|Uninstall plugin?" e9e1b74c3 -- apps packages`, and it matched only the two source files. No test mocks `removePlugin` for `ToolsView`.
- **Consumers.** `git grep -n "usePluginRemoval\|PluginRemovalDialog"` over the snapshot finds only `PluginsOverview.tsx` and the hook file. Both symbols are internal to `apps/app`: they are not exported through the SDK or the plugin SDK, and no plugin imports them.

Maintenance cost today: any change to uninstall copy, the confirmation dialog, cache refresh or a future "also delete data" option has to be made twice. The two copies have already drifted on cache handling and the `removable` guard.

**Proposed end state and preservation argument**

`usePluginRemoval` becomes the single owner of the uninstall flow for both surfaces.

- **What disappears from `ToolsView.tsx`:** the `deleteTarget` state, the `pluginDelete` mutation, the hand-written dialog and the five now-unused imports.
- **What remains in `ToolsView.tsx`:** the `pluginToggle` mutation, unchanged. Its error copy (`"Failed to enable plugin"` / `"Failed to disable plugin"`) and its `listQuery.refetch()` differ from other enable hooks, and merging them would change UI copy. That is out of scope.
- **Hook API change (additive):**

  ```ts
  export function usePluginRemoval(options?: {
    onRemoved?: (plugin: PluginListItem) => void;
  }) {
    // onSuccess: toast, setTarget(null), options?.onRemoved?.(plugin),
    //            invalidatePluginCatalogSearch, return invalidatePluginList
    return {
      target,
      pending: mutation.isPending,
      pendingPluginId: mutation.isPending ? (mutation.variables?.id ?? null) : null,
      open, close, confirm,
    };
  }
  ```

  TanStack Query's `useMutation` calls `observer.setOptions` on every render, so `onSuccess` reads the latest `options.onRemoved` closure.

- **Detail page wiring:**
  - `const removal = usePluginRemoval({ onRemoved: () => navigate(getToolsOwnedCollectionRoutePath("plugins")) });`
  - `onDelete={removal.open}`
  - `<PluginRemovalDialog removal={removal} />` in place of the old dialog
  - `pendingPluginId` falls back to `removal.pendingPluginId`
- **Why `pendingPluginId` and not `target`:** the hook clears `target` inside `onSuccess` before the list invalidation resolves. Reading `removal.target` would end the detail page's pending state earlier than today. That matters in split panes, where navigation may not unmount the pane. `mutation.variables` keeps today's semantics exactly.

Preserved contracts and UI states:

- the dialog title, description, confirm label, pending state and cancel behavior
- all four toast strings and their `"catalog"`/`"installed"` context arguments
- the server call (`createPluginsClient(fetch).remove({ pluginId })`)
- navigation to `SETTINGS_PLUGINS_ROUTE_PATH` after success, before the list refresh resolves
- the detail page's per-plugin pending state while the removal request runs

Intentional behavior changes, to be named in the commit message:

1. Removal from the detail page now also invalidates catalog search and every plugin-list key. This closes the realtime-down gap noted above.
2. The `removable` guard now also applies on the detail page. It is unreachable through the UI because the menu item is already disabled.

Non-goals: merging `pluginToggle`, changing any copy, and moving `pluginRemovalDescription` or `pluginRemovalLabel` out of `PluginDetail.tsx`.

This is the simplest sufficient option because the hook already exists and is used, and the only divergence is one navigation callback.

**Expected gain and cost**

These figures are projections from line ranges at the snapshot. The ranges were counted with `git show e9e1b74c3:apps/app/src/views/ToolsView.tsx | cat -n`.

| Item | Production lines |
|---|---|
| Removed from `ToolsView.tsx`: imports 22-25, 46-47, 54, 59, 69 | about 9 |
| Removed: state line 214 | 1 |
| Removed: mutation 255-280, including the trailing blank line | 26 |
| Removed: dialog 452-472 | 21 |
| Added to `ToolsView.tsx`: hook import, hook call with `onRemoved`, dialog element; `pendingPluginId` rewritten in place | about 9 |
| Added to `usePluginRemoval.tsx`: options parameter, callback call, `pendingPluginId` | about 6-8 |
| **Net handwritten production reduction** | **about 38-42** |

- **Tests:** plus about 40-60 lines for one new removal-success test. The flow has no success coverage today.
- **Mechanisms:** before, there were two removal flows with four toast strings and one dialog duplicated. After, there is one flow with one owner.
- **Performance:** neutral. The change adds one more `invalidateQueries` call on a rare user action.
- **Unknown:** whether a future product decision wants different post-removal behavior per surface. The `onRemoved` callback keeps that open.

**Execution steps**

1. **Reconfirm the baseline.**
   - Check out a fresh lane from current `main` and confirm that `apps/app/src/views/ToolsView.tsx` still contains `pluginDelete`, `deleteTarget` and the inline `ConfirmDeleteDialog`.
   - Confirm that `apps/app/src/components/plugin/management/usePluginRemoval.tsx` still has the same toast strings and the same dialog.
   - Re-plan if any of the following holds: the two copies' strings now differ; `PluginsOverview` no longer uses the hook; `PluginDetail` no longer disables Uninstall for non-removable plugins; or someone has added detail-page-only removal behavior (for example a "keep data" option).
2. **Add the missing behavioral evidence first**, in `apps/app/src/views/ToolsView.plugin-detail.test.tsx` next to `describe("plugin removal confirmation")` at line 1805.
   - Add a test that renders `PluginsView detailKey="github"` inside a `MemoryRouter` with a `/plugins/:pluginId` route and a route for `SETTINGS_PLUGINS_ROUTE_PATH` that renders a marker. Reuse the existing `localPlugin` fixture shape and `vi.stubGlobal("fetch", …)`.
   - Make the stubbed `fetch` answer the plugin remove request successfully. Read `createPluginsClient(...).remove` in the browser SDK to find its exact method and path.
   - Open "Remove from Omnyo", click the confirm button and assert three things: the remove request was sent for `github`, the marker route renders, and the list endpoint was requested again.
   - Run this test against the unchanged code and confirm it passes. It pins today's behavior.
3. **Extend the hook** in `usePluginRemoval.tsx`.
   - Add the optional `options?: { onRemoved?: (plugin: PluginListItem) => void }` parameter.
   - In `onSuccess`, call `options?.onRemoved?.(plugin)` after `setTarget(null)` and before `invalidatePluginCatalogSearch`, so navigation still happens before the list refresh resolves.
   - Add `pendingPluginId: mutation.isPending ? (mutation.variables?.id ?? null) : null` to the return object.
   - `PluginsOverview` passes no options and stays unchanged.
4. **Switch the detail page** in `ToolsView.tsx` `PluginDetailToolView`.
   - Delete line 214 (`deleteTarget`) and lines 255-280 (`pluginDelete`).
   - Add `const removal = usePluginRemoval({ onRemoved: () => navigate(getToolsOwnedCollectionRoutePath("plugins")) });`.
   - Change `pendingPluginId` (lines 298-303) to `pluginToggle.isPending && pluginToggle.variables ? pluginToggle.variables.id : removal.pendingPluginId`.
   - Change `onDelete={setDeleteTarget}` (line 377) to `onDelete={removal.open}`.
   - Replace lines 452-472 with `<PluginRemovalDialog removal={removal} />`.
   - Remove the now-unused imports: `ConfirmDeleteDialog`, `ConfirmDeleteDialogContent`, `pluginRemovalDescription`, `pluginRemovalLabel`, `removePlugin`, `pluginAdminErrorMessage` and `pluginToast`. Keep `pluginIsLocalSource`, `useMutation`, `useState` (used by `installTarget`) and `getToolsOwnedCollectionRoutePath`.
   - Checkpoint: run the typecheck and the focused tests below.
5. **Clean up.** Search `ToolsView.tsx` for leftover `deleteTarget`, `pluginDelete` or `ConfirmDeleteDialog` references; there should be none. No exports, registrations, docs or generated files change.
6. **Verify and recount.** Run the verification below and inspect the full diff, which should touch only the hook, `ToolsView.tsx` and the test file. Recount the removed and added lines against the snapshot ranges above. In the commit message, name both intentional changes: catalog-search invalidation and the `removable` guard.

**Verification and acceptance criteria**

Commands come from the snapshot's `apps/app/package.json` scripts (`test`: `vitest run --config vitest.config.ts`; `typecheck`; `lint`) and the root `package.json` (`format:check`: `oxfmt . --check`). They were not run, because the snapshot has no `node_modules`.

- From `apps/app`, run `pnpm exec vitest run --config vitest.config.ts src/views/ToolsView.plugin-detail.test.tsx`. All tests must pass, including the existing removal-confirmation and Uninstall-disabled tests and the new success test. Do not edit the existing assertions.
- From `apps/app`, run `pnpm typecheck`.
- From the repository root, run `pnpm exec oxlint --fix <changed files>`, then `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent`.
- Behavior acceptance:
  - The dialog heading, description and confirm label are unchanged for both a local plugin ("Remove plugin from Omnyo?" / "Remove from Omnyo") and an installed plugin ("Uninstall plugin?").
  - On success, the same toast appears and the app navigates to the Plugins settings route.
  - On failure, the "Plugin removal failed" or "Plugin uninstall failed" toast appears, the dialog stays open, and the app stays on the detail page.
  - While the request is pending, the confirm and cancel buttons are disabled, and `PluginDetail` shows `pending` for that plugin.
  - The Plugins overview's uninstall path behaves exactly as before.
- Manual UI check, which Alex does himself per repository policy: uninstall a removable plugin from its detail page in a split pane (thread split or settings split) and confirm the pane leaves the deleted plugin. A single screenshot does not verify the navigation timing.
- Performance: no comparison is needed. The flow is a rare user action with one extra query invalidation.

**Rollback and stop conditions**

- **Rollback:** revert the single commit. The change touches only client code, with no persisted data, server contract or SDK surface, so a revert is complete.
- **Stop and re-plan if:**
  - the new success test cannot be made to pass against the unchanged code, which would mean today's behavior differs from what is described here;
  - the detail page needs removal behavior the overview must not get, beyond navigation;
  - `PluginsOverview` tests or overview behavior change after step 3;
  - removing an import shows it is used elsewhere in `ToolsView.tsx`.
