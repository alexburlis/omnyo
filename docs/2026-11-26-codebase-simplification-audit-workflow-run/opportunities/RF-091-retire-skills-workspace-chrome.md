# RF-091 — Remove the Skills-workspace sidebar, breadcrumbs, header meta and `"skills"` shell mode that only render on redirect routes

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: every path that turns on the Skills-workspace chrome renders only `<LegacySkillsPathRedirect />`. The sweep undercounted the gain and missed some consumers. Rewriting `tools-navigation.ts` for one workspace removes about 155 lines there, not about 60. The sweep also missed four consumers: `useRouteState().isSkillsView`, the `"/skills"` entry in `AppLayout`'s `routeTitles`, the Ladle story helper `shellModeForPath`, and the two callers of `getToolsOwnedCollectionRoutePath`. Its main counterevidence does not hold: the chrome is keyed on the URL path, not on whether the skill-discovery plugin has loaded.
- **Potential:** medium. About 160–175 handwritten production lines go, and so does one of two resource-workspace definitions. About 85 test lines go with them.
- **Confidence:** high. Reachability is proven by inspection. Test suites were not run, because the snapshot has no `node_modules`.
- **Readiness:** ready. Alex already retired the built-in Skills workspace: the private-history commit `ede5f2215f` (2026-11-23) is titled "Remove the retired built-in Skills workspace". This change removes what that commit left behind. The only visible effect is on the single committed render before the redirect, and after the change that render matches the destination's chrome instead of flashing a different sidebar. If the index owner treats any change to that render as a product decision, reclassify this card as decision-needed. The code plan stays the same.
- **Effort:** S. About 2–4 hours, mostly test edits.
- **Risk:** low. No persisted data, API, SDK export or plugin contract is involved. The realistic regressions are a broken Plugins breadcrumb or Plugins sidebar active state from the rewrite, and the existing Plugins tests cover both.
- **Prerequisites:** none.
- **Related and overlapping:** RF-026 deletes the retired skill detail UI (`SkillDetailView`, `ProvenancePill`, `SkillsCollection`). Both cards finish the same retirement, they touch disjoint files, and either can land first. RF-063 changes the server and SDK skills-registry routes and does not touch this UI.
- **Why it deserves its place:** this removes dead machinery cleanly. Every edit to Plugins breadcrumbs or to the Plugins sidebar currently has to go through a two-section abstraction (`TOOLS_SECTIONS`, `DETAIL_ROUTES`, `collectionCrumb`) whose second section can never be seen, and the tests for that section have to be kept green.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The cited files are the same at local `main` `5f2d3f895`: `git diff --stat e9e1b74c3 5f2d3f895 -- apps/app/src/components/tools apps/app/src/components/layout apps/app/src/lib/route-paths.ts apps/app/src/App.tsx apps/app/src/hooks/useRouteState.ts apps/app/src/lib/visible-app-context.ts apps/app/src/components/sidebar/SidebarShell.stories.tsx packages/client-core/src/routes` printed nothing. The scope is the web app (`apps/app`), which the desktop app also loads. Mobile has no copy of this code: `git grep` for the symbols below found matches only under `apps/app`.

Background. The web app used to have a built-in Skills workspace: a page at `/skills` with its own sidebar ("Browse skills", "My skills"), breadcrumbs and a header title. The skill-discovery plugin now owns that surface at `/plugins/skill-discovery/browse` (`SKILLS_PANEL` in `apps/app/src/lib/route-paths.ts:83`). On 2026-11-23 the workspace pages were deleted. The layout chrome for them was not.

Observed facts (all Proven by inspection unless labelled otherwise):

1. Every Skills route renders a redirect. `apps/app/src/App.tsx:498-513` maps `SKILLS_ROUTE_PATH` (`/skills`), `SKILL_DETAIL_ROUTE_PATH` (`/skills/library/:skillId`), `REGISTRY_SKILLS_ROUTE_PATH` (`/skills/registry`) and `REGISTRY_SKILL_DETAIL_ROUTE_PATH` to `<LegacySkillsPathRedirect />` (`App.tsx:244`). That component renders `NavigatePreservingLocation` (`App.tsx:144`), a `<Navigate replace>`. The `/extensions/skills*` routes (`App.tsx:470-489`) redirect the same way.
2. The chrome switch is `isSkillsRoutePath` (`apps/app/src/lib/route-paths.ts:123`). It matches exactly those four route patterns. React Router 7.18.2's `Navigate` (checked in the installed `node_modules/.pnpm/react-router@7.18.2…/dist/development/chunk-HHGH3NKS.js:6994`) calls `navigate` inside `useEffect`. So `AppLayout` commits once with the `/skills…` pathname, and on the next render the pathname is `/plugins/skill-discovery/browse…`. Whether the browser paints that first commit is a Hypothesis; it depends on React's effect-flush timing.
3. On the destination path the layout is in `"app"` mode with no `AppHeader`. `isPluginsRoutePath` (`route-paths.ts:116`) does not match `/plugins/:pluginId/:panelPath/*`, and `showHeader` (`AppLayout.tsx:852`) is false when `pluginPanelMatch` is set. The chrome therefore depends on the pathname and does not wait for the plugin to load. The sweep's counterevidence ("the Skills mode may show while the plugin loads") is refuted.
4. Skills-only code that can render only on that redirect commit:
   - `apps/app/src/components/tools/tools-navigation.ts` (353 lines, 293 non-blank). This covers the `ToolsSectionId = "skills" | "plugins"` union (:21), `TOOLS_SECTIONS.skills` (:32), `TOOLS_OWNED_COLLECTION_LABEL` and `TOOLS_OWNED_COLLECTION_VIEW` (:44-52), the skills branch of `getToolsOwnedCollectionRoutePath` (:54), `resolveToolsSection` (:136, which returns `"skills"` for every non-Plugins path), `sectionCrumb` and `collectionCrumb` (:155-167), both skills entries of `DETAIL_ROUTES` (:169-187), the `REGISTRY_SKILLS_ROUTE_PATH` branch and skills loop iteration of `resolveToolsBreadcrumbs` (:213-229), `SKILL_PAGES` (:279), the skills branches of `resolveToolsActivePage` (:292-323) and `resolveSkillsWorkspaceHeaderMeta` (:347).
   - `apps/app/src/components/tools/ResourceSidebar.tsx:19,25,31`: the `workspace` prop, `workspace === "plugins" ? PLUGIN_PAGES : SKILL_PAGES`, and `testIdPrefix={workspace}`.
   - `apps/app/src/components/layout/AppLayoutSidebar.tsx:12` `AppLayoutSidebarMode` includes `"skills"`. Line 58 checks `renderedMode === "plugins" || renderedMode === "skills"`, and lines 60-61 pass `key={renderedMode}` and `workspace={renderedMode}`.
   - `apps/app/src/components/layout/AppLayout.tsx`: the import of `resolveSkillsWorkspaceHeaderMeta` (:43) and `isSkillsRoutePath` (:105); `routeTitles["/skills"]` (:524); `isSkillsWorkspace` (:742) and its use in `backToAppRoutePath` (:746); the `?? resolveSkillsWorkspaceHeaderMeta(...)` fallback (:909); and the `"skills"` branch of the `AppShellFrame` `mode` (:1119-1120).
5. Redundant flag, found in the same search: `apps/app/src/hooks/useRouteState.ts:75` `isSkillsView: isSkillsRoutePath(...)`. Its only reader is `apps/app/src/lib/visible-app-context.ts:125` `route.isToolsView || route.isSkillsView`. `isToolsView` (`useRouteState.ts:74`) already includes `isToolsRoutePath`, which calls `isSkillsRoutePath` (`route-paths.ts:110`), so `isSkillsView` never changes the result.
6. Story-only consumer: `apps/app/src/components/sidebar/SidebarShell.stories.tsx:238-246` `shellModeForPath` returns `"skills"`, but no story routes to `/skills` (`grep -n skills` on the file matches only lines 35 and 245).
7. Callers of `getToolsOwnedCollectionRoutePath` pass only `"plugins"`: `apps/app/src/components/sidebar/SidebarPluginAttentionGlyph.tsx:63` and `apps/app/src/views/ToolsView.tsx:266`. For `"plugins"` the function returns `SETTINGS_PLUGINS_ROUTE_PATH` (`tools-navigation.ts:55-56`).

Search scope for consumers: `git grep -n -E 'tools-navigation|resolveToolsBreadcrumbs|resolveToolsActivePage|resolveToolsSection|SKILL_PAGES|PLUGIN_PAGES|resolveSkillsWorkspaceHeaderMeta|resolvePluginsWorkspaceHeaderMeta|getToolsOwnedCollectionRoutePath|ToolsSectionId|isSkillsRoutePath|isSkillsWorkspace|isSkillsView|AppLayoutSidebarMode' e9e1b74c3 -- .` over the whole repository. The results are the files listed above and their tests. `rg -l -e tools-navigation -e resolveSkillsWorkspaceHeaderMeta -e SKILL_PAGES -e AppLayoutSidebarMode $OMNYO_PLUGIN_CHECKOUT --glob '!**/node_modules/**'` found nothing, and `docs/forkable-plugins.md` forbids plugins from importing `apps/app` internals anyway. `git grep` for `skills-sidebar|Browse skills|"My skills"|skills-library|skills-browse` found only these files and their tests, with no e2e or QA script. `git grep -i 'skills workspace|skills sidebar|My skills' -- '*.md'` found nothing. None of these symbols is exported from `@omnyo/sdk`, the plugin SDK or `@omnyo/client-core`.

What must stay (kept by live links and tests): the route constants in `packages/client-core/src/routes/route-paths.ts` (:23-44) and their `ROUTE_PATTERNS` entries (:310-319); every `LegacySkillsPathRedirect` route; `isSkillsRoutePath` inside `isToolsRoutePath`. `useAppSettingsRouteMemory` (`apps/app/src/hooks/useAppSettingsRouteMemory.ts:35`) uses `isToolsRoutePath` to keep "back to app" pointing at the last core route. The rail's Skills item, which targets `/skills` (`sidebarNavigationItems.ts:337` `open-skills`), and its active-item rule (`sidebarNavigationItems.ts:307-311`) also stay. `apps/app/src/App.legacy-skill-route.test.tsx` (for example :56 and :121) pins the redirect targets.

Maintenance cost today: the Plugins breadcrumb and sidebar logic is written as a generic two-section table, so any Plugins change has to keep an invisible Skills section type-correct and keep its tests green: about 45 lines in `AppLayout.tools-breadcrumbs.test.ts` and 28 in `ResourceSidebars.test.tsx`. A reader also cannot tell from the code that the Skills section is dead.

**Proposed end state and preservation argument**

What remains:

- `tools-navigation.ts` describes only the Plugins workspace. `resolvePluginCreateBreadcrumbs`, `resolveAutomationBreadcrumbs`, `belongsToRoute`, `routeResourceLabel`, `PLUGIN_PAGES`, `resolvePluginsWorkspaceHeaderMeta` and `TOOLS_PAGE_BAND_CLASSES` stay unchanged. `resolveToolsBreadcrumbs` becomes a direct Plugins resolver, and `resolveToolsActivePage` reads only the `view` query parameter.
- `ResourceSidebar` renders `PLUGIN_PAGES` with `testIdPrefix="plugins"`, so `data-testid="plugins-sidebar-body"` is unchanged.
- `AppLayoutSidebarMode` is `"app" | "settings" | "plugins"`.
- The redirects, route constants, `isSkillsRoutePath` and `isToolsRoutePath` are unchanged.

What disappears: `ToolsSectionId`, `TOOLS_SECTIONS`, `TOOLS_OWNED_COLLECTION_LABEL`, `TOOLS_OWNED_COLLECTION_VIEW`, `getToolsOwnedCollectionRoutePath`, `resolveToolsSection`, `sectionCrumb`, `collectionCrumb`, `DETAIL_ROUTES`, `SKILL_PAGES`, `resolveSkillsWorkspaceHeaderMeta`, the `"skills-browse" | "skills-library"` page ids, the `"skills"` shell mode, `isSkillsWorkspace`, `routeTitles["/skills"]` and `RouteState.isSkillsView`.

Preservation argument:

- Plugins breadcrumbs keep exactly these outputs, which the current tests at `AppLayout.tools-breadcrumbs.test.ts:19-30` and `:61-81` pin:
  - `/plugins` gives `[{Plugins,/plugins},{Browse}]`.
  - `?view=installed` gives `{Installed}`.
  - `?view=create` gives `{Create a plugin}`.
  - `/plugins/:id` gives `[{Plugins,/plugins},{Browse,/plugins},{label}]`.
  - `/plugins/:id?view=installed` gives `[{Plugins,/plugins},{Installed,/settings/plugins},{label}]`.
  - `/plugins/automations/automations/...` gives `null`.
  - `/plugins/` (trailing slash) gives `null`, because neither `pathname === "/plugins"` nor `matchPath("/plugins/:pluginId", "/plugins/")` matches.
- The Plugins sidebar active page depends only on `view === "installed"` for every path where the sidebar renders. Today the sidebar renders only when `isPluginsRoutePath` is true, and on those paths both the `DETAIL_ROUTES` branch and the `resolveToolsSection` branch of `resolveToolsActivePage` reduce to that test.
- The document title on Plugins routes still comes from `toolsBreadcrumbs` (`AppLayout.tsx:905`, `:958-965`).
- `visible-app-context` still reports `view: "tools"` on the redirect commit, because `isToolsView` is already true there.
- The redirect commit: today it shows the Skills `ResourceSidebar`, an `AppHeader` titled "Skills" and a document title of "Browse · Skills", then switches to the app sidebar with no header. After the change, that commit shows the app sidebar (the destination's sidebar) and an `AppHeader` with an empty title, and the document title falls back to "Omnyo". The commit lasts one render. `BackToAppCommandHandler` is no longer mounted during that one render; it registers `app.back` and does nothing else.
- On compact viewports, `AppLayoutSidebar`'s `holdCurrentMode` logic (`AppLayoutSidebar.tsx:27-35`) is unchanged.

Deleting `key={renderedMode}` on `ResourceSidebar` is safe. It existed to remount the sidebar when switching between the two resource workspaces, and only one remains. Switching to or from settings or app mode already swaps the element type.

Non-goals: changing the rail Skills link to target the plugin panel directly; removing the `/skills` redirects or route constants; renaming `ResourceSidebar`, `resolveToolsBreadcrumbs` or `resolveToolsActivePage` (optional, and not needed for the gain); anything in RF-026's files.

Remaining uncertainty: whether the redirect commit is ever painted (a Hypothesis). This does not affect correctness, because after the change both commits use the same sidebar.

**Expected gain and cost**

Projections from reading the code. They are not measurements.

- `tools-navigation.ts`: a line-range count (`sed -n` over the ranges, piped to `wc -l`) puts 148 lines in blocks that stay verbatim and 204 lines in blocks that are skills-only or generic two-section machinery. The replacement adds about 45 lines (the direct `resolveToolsBreadcrumbs` and `resolveToolsActivePage`, plus one view constant), so the file goes from 353 to about 195 lines (**about −155**).
- `AppLayout.tsx` about −8, `ResourceSidebar.tsx` about −5, `AppLayoutSidebar.tsx` about −2 and `useRouteState.ts` about −2. `visible-app-context.ts`, `SidebarPluginAttentionGlyph.tsx` and `ToolsView.tsx` have net-zero edits.
- **Total: about 160–175 handwritten production lines.** Stories lose about 2 lines. Tests lose about 85 lines (about 45 in breadcrumbs, about 28 in ResourceSidebars and about 10 in AppLayoutSidebar). Nothing generated, no docs and no assets change.
- Mechanisms: before, there were two resource-workspace definitions (Plugins and Skills) across breadcrumbs, sidebar pages, active-page logic, header meta and shell mode, plus a redundant `isSkillsView` route flag. After, there is one (Plugins).
- Performance: neutral by inspection. The change removes a few `matchPath` calls per `AppLayout` render and was not measured.
- Cost: a one-time rewrite of two small functions, with a small risk of breadcrumb regressions that the existing tests catch.

**Execution steps**

1. **Reconfirm.** On a fresh checkout, run `git grep -n -E 'isSkillsRoutePath|isSkillsWorkspace|isSkillsView|SKILL_PAGES|resolveSkillsWorkspaceHeaderMeta|ToolsSectionId|getToolsOwnedCollectionRoutePath|AppLayoutSidebarMode'`. The hits should be the files named in Context and nothing new. Confirm that every route whose path matches `isSkillsRoutePath` in `apps/app/src/App.tsx` still renders `LegacySkillsPathRedirect`. **Re-plan if** any Skills route renders a real page again, if a new caller passes `"skills"` to a tools-navigation helper, or if a plugin or host feature now selects a `"skills"` shell mode.
2. **No new behavioral evidence is needed.** The existing Plugins assertions in `AppLayout.tools-breadcrumbs.test.ts`, `ResourceSidebars.test.tsx`, `AppLayoutSidebar.test.tsx` and `App.legacy-skill-route.test.tsx` are the independent baseline. Do not edit their Plugins expectations.
3. **Rewrite `apps/app/src/components/tools/tools-navigation.ts`.**
   - Remove the imports of `getRegistrySkillsRoutePath`, `getSkillsRoutePath`, `REGISTRY_SKILLS_ROUTE_PATH`, `REGISTRY_SKILL_DETAIL_ROUTE_PATH`, `SKILL_DETAIL_ROUTE_PATH` and `isSkillsRoutePath`.
   - Delete `ToolsSectionId`, `ToolsSectionDefinition`, `TOOLS_SECTIONS`, `TOOLS_OWNED_COLLECTION_LABEL`, `TOOLS_OWNED_COLLECTION_VIEW`, `getToolsOwnedCollectionRoutePath`, `resolveToolsSection`, `sectionCrumb`, `collectionCrumb`, `DETAIL_ROUTES`, `SKILL_PAGES` and `resolveSkillsWorkspaceHeaderMeta`.
   - Add `const PLUGINS_INSTALLED_VIEW = "installed";`.
   - In `resolvePluginCreateBreadcrumbs`, replace `TOOLS_SECTIONS.plugins.to` with `getPluginsRoutePath()`. In `PLUGIN_PAGES`, use `getPluginsRoutePath()` and `` `${getPluginsRoutePath()}?view=${PLUGINS_INSTALLED_VIEW}` ``.
   - Rewrite `resolveToolsBreadcrumbs(pathname, search = "", resourceLabel?)` as follows. Return `resolvePluginCreateBreadcrumbs(...)` if it is not null. Let `installed = new URLSearchParams(search).get("view") === PLUGINS_INSTALLED_VIEW` and `root = { label: "Plugins", to: getPluginsRoutePath() }`. If `pathname === getPluginsRoutePath()`, return `[root, { label: installed ? "Installed" : "Browse" }]`. Otherwise `match = matchPath(PLUGIN_DETAIL_ROUTE_PATH, pathname)`; if there is no match, return `null`. Otherwise return `[root, installed ? { label: "Installed", to: SETTINGS_PLUGINS_ROUTE_PATH } : { label: "Browse", to: getPluginsRoutePath() }, { label: resourceLabel ?? routeResourceLabel(match.params.pluginId, "Plugin") }]`. Build fresh objects on every call, as the current code does.
   - Narrow `ResourcePageDefinition["id"]` to `"plugins-browse" | "plugins-installed"`.
   - Rewrite `resolveToolsActivePage(search = "")` to return `new URLSearchParams(search).get("view") === PLUGINS_INSTALLED_VIEW ? "plugins-installed" : "plugins-browse"`. This drops the unused `pathname` parameter.
   - Keep `ResourceWorkspaceHeaderMeta` and `resolvePluginsWorkspaceHeaderMeta` as they are.
4. **Update consumers.**
   - `apps/app/src/components/tools/ResourceSidebar.tsx`: drop the `workspace` prop, the `SKILL_PAGES` and `ToolsSectionId` imports, and the pages ternary. Render `PLUGIN_PAGES`, call `resolveToolsActivePage(location.search)`, and pass `testIdPrefix="plugins"`.
   - `apps/app/src/components/layout/AppLayoutSidebar.tsx`: set `AppLayoutSidebarMode = "app" | "settings" | "plugins"`. The branch becomes `renderedMode === "plugins" ? <ResourceSidebar onResizeMouseDown={…} isResizing={…} /> : null`, with no `key` and no `workspace`.
   - `apps/app/src/components/layout/AppLayout.tsx`:
     - Remove the `resolveSkillsWorkspaceHeaderMeta` import (:43) and the `isSkillsRoutePath` import (:105). Confirm with a search that the file has no other use of either.
     - Delete `isSkillsWorkspace` (:742).
     - Change `backToAppRoutePath` (:744-748) to `isGlobalSettingsView ? appRoutePath : isPluginsWorkspace ? toolsBackRoutePath : null`.
     - Change `resourceWorkspaceHeaderMeta` (:907-909) to `resolvePluginsWorkspaceHeaderMeta(location.pathname, location.search)`.
     - Change the `AppShellFrame` `mode` (:1114-1122) to `isGlobalSettingsView ? "settings" : isPluginsWorkspace ? "plugins" : "app"`.
     - Delete `"/skills": { title: "Skills" }` from `routeTitles` (:524).
   - `apps/app/src/hooks/useRouteState.ts`: remove `isSkillsView` from `RouteState` (:12) and from the returned object (:75), and remove `isSkillsRoutePath` from the import (:3). In `apps/app/src/lib/visible-app-context.ts:125`, change `route.isToolsView || route.isSkillsView` to `route.isToolsView`.
   - `apps/app/src/components/sidebar/SidebarPluginAttentionGlyph.tsx:7,63` and `apps/app/src/views/ToolsView.tsx:66,266`: replace `getToolsOwnedCollectionRoutePath("plugins")` with `SETTINGS_PLUGINS_ROUTE_PATH` imported from `@/lib/route-paths`. `ToolsView.tsx` already imports from that module at :65, so merge it into that import.
   - `apps/app/src/components/sidebar/SidebarShell.stories.tsx:238-246`: make `shellModeForPath` return `"app"` after the Plugins check, and drop the `isSkillsRoutePath` import (:35).
   - Checkpoint: run `pnpm --filter @omnyo/app typecheck`. It must pass before you touch the tests, because the narrowed union will flag any missed consumer.
5. **Update the tests, keeping every Plugins assertion.**
   - `apps/app/src/components/layout/AppLayout.tools-breadcrumbs.test.ts`:
     - Remove the `resolveSkillsWorkspaceHeaderMeta` import (:5).
     - Remove the two `/skills` expectations (:11-18), the test "resolves the Skills registry path as Browse" (:33-38), the two Skills detail expectations (:41-60) and the test "gives Skills ownership of only the Skills header" (:186-192).
     - Remove `resolveSkillsWorkspaceHeaderMeta("/")` (:208).
     - Keep `resolvePluginsWorkspaceHeaderMeta("/skills/registry")` returning null (:183).
     - Add `expect(resolveToolsBreadcrumbs("/skills")).toBeNull()` so that redirect paths claim no tools breadcrumbs.
   - `apps/app/src/components/tools/ResourceSidebars.test.tsx`: drop the `ToolsSectionId` import and the `workspace` parameter of `renderSidebarAt`, delete `describe("Skills sidebar")` (:58-85), and keep the Plugins negative assertions (:41-43).
   - `apps/app/src/components/layout/AppLayoutSidebar.test.tsx`:
     - Make the `ResourceSidebar` mock (:94-100) take no props and render `data-testid="plugins-sidebar-body"`.
     - Delete the "Navigate to skills" button (:151-153), the assertion at :240 and the skills step at :331-333.
     - Change the assertion at :339 to `queryByTestId("plugins-sidebar-body")` being null.
   - `apps/app/src/components/layout/AppLayout.test.tsx:441`: keep the `"/skills"` case. It now exercises app mode on a path with no route, which is still valid. Drop it only if it fails for reasons unrelated to this change.
6. **Finish.**
   - Format and lint the changed files with `pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent`.
   - Run the verification below.
   - Inspect the full diff. It must contain no edits to `App.tsx` routes, `route-paths.ts` or `packages/client-core`.
   - Recount with `git diff --stat` against the same baseline.

**Verification and acceptance criteria**

None of these commands was run for this card, because the snapshot has no `node_modules`. The scripts exist in `apps/app/package.json` (`test`: `vitest run --config vitest.config.ts`; `typecheck`; `lint`) and in the root `package.json` (`lint`, `typecheck`, `format:check`).

- From the repository root, run the targeted tests:
  `pnpm --filter @omnyo/app test -- src/components/layout/AppLayout.tools-breadcrumbs.test.ts src/components/tools/ResourceSidebars.test.tsx src/components/layout/AppLayoutSidebar.test.tsx src/components/layout/AppLayout.test.tsx src/App.legacy-skill-route.test.tsx src/lib/route-paths.test.ts src/lib/app-route-history.test.tsx`
  Expected: all pass. Every Plugins breadcrumb, sidebar and active-state expectation is unchanged, and the redirect targets are still `/plugins/skill-discovery/browse…`.
- From the repository root, run `pnpm --filter @omnyo/app typecheck` (expected: no errors) and `pnpm --filter @omnyo/app lint` (expected: clean).
- Structural checks:
  - `git grep -n -E 'isSkillsWorkspace|isSkillsView|SKILL_PAGES|resolveSkillsWorkspaceHeaderMeta|ToolsSectionId|getToolsOwnedCollectionRoutePath|"skills-browse"|"skills-library"'` returns nothing.
  - `git grep -n '"skills"' apps/app/src/components/layout apps/app/src/components/tools` returns nothing from mode or section code.
  - `isSkillsRoutePath` is still used in `route-paths.ts` (inside `isToolsRoutePath`) and in its test.
- Manual check (Alex tests UI himself; optional during dev):
  - In the web app, click the rail's Skills item. The skill-discovery panel opens, the Skills rail item stays active, and no Plugins or Skills section sidebar flashes.
  - Open `/plugins`, `/plugins?view=installed` and `/plugins/<id>?view=installed`. The breadcrumbs, header title "Plugins", sidebar rows and their active state should match current main.
  - Press the app-back command on `/plugins`. It should still return to the last core route.

**Rollback and stop conditions**

Rollback: the change is one self-contained commit in `apps/app` with no persisted data, migrations, settings keys, API or SDK surface. Reverting that commit restores the previous behavior exactly.

Stop and re-plan if:

- A Skills route renders a real page again, or Alex wants a Skills section sidebar for the rail's Skills item. In that case keep the Skills section and close this card.
- A plugin or host feature has started selecting the `"skills"` shell mode or calling a tools-navigation helper with `"skills"`.
- Any existing Plugins breadcrumb or sidebar test needs its expected values changed to pass. That means the rewrite changed Plugins behavior: fix the rewrite, and do not edit the expectation.
- `AppLayout.test.tsx`'s `"/skills"` mobile case fails in a way that shows app mode misbehaves on unmatched paths. Investigate that failure separately rather than restoring the Skills mode.

Safer smaller alternative: if the index owner rejects any change to the redirect render, keep `"skills"` in `AppLayoutSidebarMode` and `isSkillsWorkspace`, and land only the `useRouteState.isSkillsView` removal and the two `getToolsOwnedCollectionRoutePath` call-site changes. That alternative removes only about 5 lines and is not worth an RF of its own.
