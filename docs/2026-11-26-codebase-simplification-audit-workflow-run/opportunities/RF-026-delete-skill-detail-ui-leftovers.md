# RF-026 — Delete the retired Skills workspace's skill detail UI (`SkillDetailView`, `ProvenancePill`, `SkillsCollection`) and its story, test and review-manifest upkeep

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds. Three changes from the sweep reports: the story-line count was overstated (about 246 story lines, not 500–540); the "Detail page header slots" test has to be moved onto `ResourceDetailPage`, not dropped, because it is the only test of that shared component's action and overflow-menu slots; and there are four polish-review manifest entries, not three.
- **Potential:** medium. The change removes 517 handwritten production lines (474 non-blank) across three files, which no route, plugin or SDK export reaches. It also removes about 246 story lines, about 200 net test lines and 87 lines of review-manifest data.
- **Confidence:** high. Reachability is proven by inspection (see below).
- **Readiness:** ready.
- **Effort:** S, about 1–2 hours. Most of the work is partial edits to one story file, one test file and one manifest.
- **Risk:** low. No production surface changes. The one realistic regression is losing the only test of the header slots on `ResourceDetailPage`, and step 4 below prevents it.
- **Prerequisites:** none.
- **Related and overlapping:** RF-091 removes the Skills-workspace chrome that only renders on redirect routes. It finishes the same retirement and does not depend on RF-026. RF-047 retires the whole Polish review story and manifest; if RF-047 lands first, skip step 5 here. RF-012 retires the rename tooling, and its test `packages/scripts/test/omnyo-selected-path-edges.test.mjs` uses `apps/app/src/components/tools/SkillsCollection.tsx` only as a literal string. The audit's incidental finding ISS-002 (a code-fence split in `splitMarkdownIntoChunks`) is in this dead code and closes with this deletion.
- **Why it deserves its place:** this is a clean case of verified dead code. A complete detail-page recipe, its provenance pill and its provider-logo helpers still compile against shared-ui resource-list and `FilePreview` APIs, and design-review stories and tests keep them green, but no user can reach them.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The three files and their story, test and manifest consumers are identical at local `main` `5f2d3f895` (`git diff --stat e9e1b74c3 5f2d3f895 -- apps/app/src/components/tools apps/app/src/polish-review apps/app/src/App.tsx` printed nothing).

Background. Omnyo used to have a built-in Skills workspace in the web app (`apps/app`). Private-history commit `ede5f2215f` (2026-11-23, "Remove the retired built-in Skills workspace", in `$ARCHIVED_OMNYO_CHECKOUT`) deleted `SkillsBrowse.tsx`, `SkillsLibrary.tsx`, `skill-taxonomy.ts`, `skills-queries.ts`, `skills-registry.ts` and the skills cache effects, and cut `SkillsCollection.tsx` by 817 lines (Proven by inspection with `git show --stat ede5f2215f`). The skill-discovery plugin now owns skills, including its own detail inspector (`$OMNYO_PLUGIN_CHECKOUT/skill-discovery/skill-inspector.tsx`). That commit left behind the detail view and two helpers.

Files to delete (line counts from `git show e9e1b74c3:<path> | wc -l`; non-blank counts from `grep -c -v '^\s*$'`):

| File | Lines | Non-blank | Exports |
|---|---|---|---|
| `apps/app/src/components/tools/SkillDetailView.tsx` | 403 | 374 | `splitMarkdownIntoChunks` (:221), `SkillDetailView` (:308) |
| `apps/app/src/components/tools/ProvenancePill.tsx` | 45 | 42 | `ProvenancePill` (:10) |
| `apps/app/src/components/tools/SkillsCollection.tsx` | 69 | 63 | `ProviderLogo` (:7), `SkillProvenanceTooltip` (:37) |
| **Total** | **517** | **474** | |

Reachability, all Proven by inspection:

- A search for the symbols, `git grep -n -w -e SkillDetailView -e ProvenancePill -e SkillProvenanceTooltip -e ProviderLogo -e SkillsCollection -e splitMarkdownIntoChunks e9e1b74c3 -- .`, returns only:
  - the three files themselves (`SkillDetailView.tsx:27` imports `ProvenancePill`);
  - `apps/app/src/components/tools/PluginsAndSkillsDetailStates.stories.tsx:28-34`, a Ladle story;
  - `apps/app/src/components/tools/detail-page-recipes.test.tsx:22`, a test;
  - `apps/app/src/polish-review/polish-review-manifest.ts:3858, 3949, 8561, 8802`, file-path strings in a review fixture;
  - `packages/scripts/test/omnyo-selected-path-edges.test.mjs:64, 71, 92`, literal `ownerFile` strings for the pure function `resolveSelectedMetadataEdge`. `scripts/omnyo-rename/selected-path-edges.mjs` imports only `node:path`, so it never reads the file.
- Every skills route renders a redirect. `apps/app/src/App.tsx:470-512` maps `TOOLS_SKILLS_ROUTE_PATH`, `TOOLS_SKILL_DETAIL_ROUTE_PATH`, `LEGACY_TOOLS_SKILL_DETAIL_ROUTE_PATH`, `TOOLS_REGISTRY_SKILLS_ROUTE_PATH`, `TOOLS_REGISTRY_SKILL_DETAIL_ROUTE_PATH`, `SKILLS_ROUTE_PATH`, `SKILL_DETAIL_ROUTE_PATH`, `REGISTRY_SKILLS_ROUTE_PATH` and `REGISTRY_SKILL_DETAIL_ROUTE_PATH` to `<LegacySkillsPathRedirect />`. That component sends users to the skill-discovery plugin panel (`apps/app/src/lib/route-paths.ts:83` `SKILLS_PANEL = { pluginId: "skill-discovery", path: "browse" }`).
- External plugins: `rg -l -w -e SkillDetailView -e ProvenancePill -e SkillProvenanceTooltip -e 'components/tools/Skills' $OMNYO_PLUGIN_CHECKOUT --glob '!**/node_modules/**'` found no matches. Plugins also cannot import `apps/app` internals (`docs/forkable-plugins.md`). None of these symbols is part of the SDK or plugin SDK.
- Config, docs and data: `git grep` over `*.md`, `*.json`, `*.yml`, `*.mjs` and `*.cjs` found only the scripts-test strings above. The data attribute `data-skill-content-viewport` appears only in `SkillDetailView.tsx:273` and `detail-page-recipes.test.tsx:657`. The attribute `data-provider-icon` has independent production owners (`UpdatesSettingsSection.tsx`, `SidebarUpdatesBadge.tsx`, `MachineSettingsView.tsx`). Nothing is persisted, and no migration is involved.
- No cascade: every dependency of the deleted files has other production consumers. These are `ResourceDetailPage`, `ResourceDetailStack`, `ResourceDetailPanel`, `ResourceDefinitionSection`, `ResourceDetailIncludesSection` (`PluginCapabilities.tsx`), `ResourceDetailCollection` (`plugins/automations/detail-view.tsx`), `ResourceInfiniteScrollSentinel` (`PluginsOverview.tsx`, `PluginCatalogCard.tsx`), `FilePreview`, `ProviderIconMark` (`SidebarUpdatesBadge.tsx`, `MachineSettingsView.tsx`), `getProviderIconInfo`, `OmnyoLogo`, `useClipboardCopy`, and `CopyGlyph` (still used inside `apps/app/src/components/ui/copy-button.tsx:96,134`). The type `SkillProvider` stays in use in `apps/server/src/services/skills/skill-listing.ts`.

Story file anatomy (`PluginsAndSkillsDetailStates.stories.tsx`, 1,355 lines, Ladle title `"Plugins and Skills/Detail states"` at :41):

- Lines 160–349 contain `SKILL_PATH`, `SkillLeading`, `Skill` and `export function SkillDetailStates` (:202–348), with Ladle id `plugins-and-skills--detail-states--skill-detail-states`. This story also renders `ResourceListState` skill error states (:320–346), but `ResourceListState` stays in use at :832 and :843.
- Lines 1175–1222 contain the `ControlTable` titled `"Owned detail-page badges"` inside `ResourceControlStates`. It is the only story use of `ProvenancePill` and `SkillProvenanceTooltip`.
- The imports used only by the code above are `SkillProvider` (:3), `ProviderLogo` and `SkillProvenanceTooltip` (:28–31), `OmnyoLogo` (:32, used only at :164), `ProvenancePill` (:33) and `SkillDetailView` (:34).
- The exports that stay are `PluginDetailStates`, `PluginBannerStates`, `PluginReleaseStates` and `ResourceControlStates`. The manifest addresses them by story id (for example `plugins-and-skills--detail-states--plugin-release-states`), so the file name and the Ladle `title` must not change.

Test file anatomy (`detail-page-recipes.test.tsx`, 750 lines):

- `describe("Detail page header slots")` at :534–559 renders `SkillDetailView` with `headerActions`, `titleBadge` and `overflowMenu`. A search for `ResourceDetailPage` and `overflowMenu` across `*.test.tsx` shows this is the only test of the `actions` and `overflowMenu` slots of the shared `ResourceDetailPage` (`packages/shared-ui/src/components/ui/resource/detail-sections.tsx:67`). Production uses those slots in `PluginDetail.tsx:523` and `plugins/automations/detail-view.tsx:901`. That coverage is a unique obligation to keep.
- `renderSkill` (:561) and `describe("Skill detail recipe")` (:574–750) cover only the deleted code, including `splitMarkdownIntoChunks` (:738).
- The imports that become unused are `SkillDetailView, splitMarkdownIntoChunks` (:22), `buildMarkdownFileImageRouting` (:29, used only at :608) and `act` (:4, used only at :709). `SkillSummary`, `projectSkillsQueryKey`, `sdk`, `vi`, `screen` and `renderedRecipe` remain in use by the plugin tests.

Polish-review manifest (`apps/app/src/polish-review/polish-review-manifest.ts`): four `POLISH_CHANGES` entries point `storyId` and `beforeStoryId` at the story being deleted. They are `home-tools-skill-file-heading` (:3843–3866), `home-tools-skill-loading-error` (:3935–3955), `sidebar-onboarding-skill-loading-reveal` (:8548–8567) and `integration-skill-path-copy-glyph` (:8788–8809), 87 lines in total. `PolishReview.stories.tsx:572` builds the "after" iframe from `storyId`, so after the deletion these four entries would show a missing story. Nothing asserts on the entry count. A separate entry, `home-tools-skills-browse-type-token` (:4089, `storyId: null`), still names the already-deleted `SkillsBrowse.tsx`. It does not break anything, and this plan leaves it alone.

Counterevidence considered: a future in-app skill detail page could want this code back. That is speculative, the plugin owns the surface today, and Git history keeps the code. No current requirement was found.

Maintenance cost today (Proven by inspection): any change to the props of `ResourceDetailPage`, `ResourceDetailIncludesSection`, `ResourceInfiniteScrollSentinel` or `FilePreview` must keep this unreachable recipe, its six-state story and its eight tests compiling and passing. The audit also spent effort finding and reproducing a defect in it (ISS-002) that no user can hit.

**Proposed end state and preservation argument**

- **What disappears:** the three files; the `SkillDetailStates` story and its helpers; the "Owned detail-page badges" control table; the "Skill detail recipe" tests; and the four manifest entries that point at the deleted story.
- **What remains:** the plugin detail stories (`PluginDetailStates`, `PluginBannerStates`, `PluginReleaseStates`) and the rest of `ResourceControlStates` stay in the same file, with the same title and story ids. All plugin detail tests stay. All shared-ui resource-list primitives and `CopyGlyph` stay. The legacy skills redirects in `App.tsx` stay; they are a live compatibility path for old links, and RF-091 owns related chrome.
- **Canonical owner:** skill detail UI is owned by the skill-discovery plugin (`skill-inspector.tsx`). After this change, core has no second, dead copy.
- **Preservation:** no route, user-visible state, API, persisted format, plugin contract or SDK export changes. The only distinct behavior covered by the deleted tests that stays live, the header slots of `ResourceDetailPage`, keeps its coverage through a direct test (step 4).
- **Non-goals:** do not touch the `"Skill · Fork"`, `"Skill · forking"` and `"Skill ownership actions"` rows in `ResourceControlStates`. They render only shared-ui controls (`ResourceInstallControl`, `ResourceOverflowMenu`). Their stale wording belongs to RF-047 or RF-091. Also leave alone the `omnyo-selected-path-edges` fixture strings (RF-012 owns that test), the stale `SkillsBrowse.tsx` manifest string, the `export` on `CopyGlyph`, and the legacy redirect routes.
- **Remaining uncertainty:** none material. Reachability rests on static imports. These are React component modules, not discovered by id or manifest, and no dynamic `import()` or glob in `apps/app` matches `components/tools/Skill*` (Ladle globs only `*.stories.tsx`, and the edit keeps that story file).

**Expected gain and cost**

Counts are against the snapshot. Projections are marked as such.

| Category | Removed | Added | Net |
|---|---|---|---|
| Handwritten production (three files) | 517 (474 non-blank) | 0 | −517 |
| Stories (`PluginsAndSkillsDetailStates.stories.tsx`) | about 246 (190 + 48 + 8 import lines) | 0 | about −246 |
| Tests (`detail-page-recipes.test.tsx`) | about 219 (217 in describes and `renderSkill`, plus import lines) | about 20 (ported header-slot test) | about −200 |
| Review fixture data (`polish-review-manifest.ts`) | 87 | 0 | −87 |

- **Mechanisms removed:** one unreachable detail-page recipe (file list, chunked lazy Markdown viewer, copy and open path control, loading and error states); one provenance pill component; and the provider-logo and provenance-tooltip helpers.
- **Maintenance effect:** future shared resource-list and `FilePreview` changes update only live consumers (`PluginDetail`, Automations).
- **Performance:** neutral at runtime, because the files are in no production chunk. The effect on Ladle build and type-check time is expected to be slightly positive but has not been measured.
- **Cost:** losing the skill-detail design-review story. That is acceptable because the plugin has its own UI.

**Execution steps**

1. **Reconfirm the baseline.** Run all commands from the repository root.
   - Run `git log -1 --format=%H` and record the commit.
   - Run `wc -l apps/app/src/components/tools/{SkillDetailView,ProvenancePill,SkillsCollection}.tsx`. The expected total at the snapshot is 517.
   - Run `rg -n -w 'SkillDetailView|ProvenancePill|SkillProvenanceTooltip|ProviderLogo|splitMarkdownIntoChunks' apps packages plugins`. Expect hits only in the three files, the story file, `detail-page-recipes.test.tsx` and nowhere else. Run `rg -n 'components/tools/(SkillDetailView|ProvenancePill|SkillsCollection)' apps packages plugins scripts` and expect only the manifest and the scripts-test fixture.
   - Run `rg -l -w 'SkillDetailView|ProvenancePill|SkillProvenanceTooltip' $OMNYO_PLUGIN_CHECKOUT --glob '!**/node_modules/**'` and expect no output.
   - **Re-plan if** any new production importer, route `element`, lazy import or plugin reference appears, or if `App.tsx` skills routes render anything other than `LegacySkillsPathRedirect`.
   - Check `git status --porcelain` on the five touched paths. If another agent has uncommitted changes in any of them, stop and work around those changes; do not overwrite them.
2. **Behavioral evidence.** No new characterization is needed. The deleted code is unreachable, and the one live obligation is handled in step 4. Optionally, record a baseline run of `pnpm --filter @omnyo/app test src/components/tools/detail-page-recipes.test.tsx` to confirm the plugin tests pass before editing.
3. **Edit the story file** `apps/app/src/components/tools/PluginsAndSkillsDetailStates.stories.tsx`.
   - Delete `SKILL_PATH`, `SkillLeading`, `Skill` and `export function SkillDetailStates` (snapshot lines 160–349, up to the blank line before `const PLUGIN`).
   - Inside `ResourceControlStates`, delete the whole `<ControlTable title="Owned detail-page badges" …>…</ControlTable>` block (snapshot 1175–1222).
   - Remove the imports `type SkillProvider` (:3), `{ ProviderLogo, SkillProvenanceTooltip }` (:28–31), `OmnyoLogo` (:32), `ProvenancePill` (:33) and `SkillDetailView` (:34).
   - Keep `ResourceListState`, `ResourceInstallControl`, `ResourceOverflowMenu`, `noop`, `Story`, `State`, `skillLocalItems` and the default-export `title` unchanged.
4. **Edit the test file** `apps/app/src/components/tools/detail-page-recipes.test.tsx`.
   - Inside the existing `describe("Resource detail header")` (:92–117), add one `it` that renders `ResourceDetailPage` directly. Give it `title="writing-voice"`, `titleMeta={<span>Imported</span>}`, `actions={<button type="button">Fork</button>}` and `overflowMenu={<button type="button">More</button>}`, with `<div>Content</div>` as its children. Assert the same three facts as the old test: `screen.getByRole("button", { name: "Fork" })`, `screen.getByText("Imported")` and `screen.getByRole("button", { name: "More" })`. Also assert that the Fork and More buttons share one parent element, the actions container: `expect(screen.getByRole("button", { name: "Fork" }).parentElement).toBe(screen.getByRole("button", { name: "More" }).parentElement)`. Do not weaken this assertion.
   - Delete `describe("Detail page header slots")` (:534–559), `function renderSkill` (:561–572) and `describe("Skill detail recipe")` (:574–750).
   - Remove the now-unused imports `SkillDetailView, splitMarkdownIntoChunks` (:22), `buildMarkdownFileImageRouting` (:29) and `act` from the `@testing-library/react` import (:4).
   - Checkpoint: `pnpm --filter @omnyo/app test src/components/tools/detail-page-recipes.test.tsx` passes, including the new header test.
5. **Edit the manifest** `apps/app/src/polish-review/polish-review-manifest.ts`. Skip this step if RF-047 has already removed the file. Delete the four `POLISH_CHANGES` objects whose `id` is `home-tools-skill-file-heading`, `home-tools-skill-loading-error`, `sidebar-onboarding-skill-loading-reveal` or `integration-skill-path-copy-glyph`, from each `{` to its matching `},`. Find them by `id`, not by line number. Leave every other entry, including `home-tools-skills-browse-type-token`, unchanged.
6. **Delete the three files.** They are clean tracked files inside the requested change; name them in the commit and report.
   - `apps/app/src/components/tools/SkillDetailView.tsx`
   - `apps/app/src/components/tools/ProvenancePill.tsx`
   - `apps/app/src/components/tools/SkillsCollection.tsx`
7. **Format, lint and inspect.** Format and lint only the touched files (commands below). Review `git diff --stat` and the full diff for unrelated changes. Recount with `git diff --numstat` and compare against the gain table. If ISS-002 in `docs/2026-11-26-codebase-simplification-audit/incidental-findings.md` is being tracked, mark it resolved by deletion.

**Verification and acceptance criteria**

Run all commands from the repository root with dependencies installed. The scripts below come from `apps/app/package.json` (`test`, `typecheck`, `lint`, `storybook:build`) and the root `package.json`; none was executed during this audit, because the snapshot has no `node_modules`.

- `pnpm --filter @omnyo/app typecheck`: must pass. It proves no remaining importer and that the story file still compiles.
- `pnpm --filter @omnyo/app test src/components/tools/detail-page-recipes.test.tsx`: all `Plugin detail recipe` tests and both `Resource detail header` tests pass, and no skipped or `.only` tests were introduced.
- `pnpm exec oxfmt apps/app/src/components/tools/PluginsAndSkillsDetailStates.stories.tsx apps/app/src/components/tools/detail-page-recipes.test.tsx apps/app/src/polish-review/polish-review-manifest.ts`, then `pnpm exec oxlint --deny-warnings --format=agent apps/app/src/components/tools apps/app/src/polish-review`: no warnings. In particular, no unused imports remain.
- `pnpm --filter @omnyo/app lint`: passes.
- Optional, because it is heavier: `pnpm --filter @omnyo/app storybook:build` (runs `ladle build`) succeeds. In `ladle serve`, the remaining stories `plugins-and-skills--detail-states--plugin-detail-states`, `--plugin-banner-states`, `--plugin-release-states` and `--resource-control-states` render as before. The only intended visual difference is the missing "Owned detail-page badges" table in Resource control states. The Polish review story shows no entry whose after frame is a missing story. Alex tests UI himself, so this check is not a completion gate.
- Structural completion:
  - `rg -n -w 'SkillDetailView|ProvenancePill|SkillProvenanceTooltip|ProviderLogo|splitMarkdownIntoChunks|skill-detail-states' apps packages plugins` returns nothing.
  - `rg -n 'components/tools/(SkillDetailView|ProvenancePill|SkillsCollection)' apps packages plugins scripts` returns only `packages/scripts/test/omnyo-selected-path-edges.test.mjs`, an inert fixture owned by RF-012.
  - `ls apps/app/src/components/tools/` no longer lists the three files.
- Performance: no runtime check is needed, because no production chunk contains these files. Do not claim a typecheck or Ladle speedup without measuring it.

**Rollback and stop conditions**

- **Rollback:** the change is one commit of deletions and partial edits. `git revert <commit>` restores it fully. There is no data, persisted-format or compatibility impact, because nothing outside the app source tree referenced these modules.
- **Stop and re-plan if:**
  - step 1 finds a new production consumer, such as a route, lazy import or plugin reference;
  - Alex has decided to bring back an in-app skill detail page that should reuse `SkillDetailView`;
  - another agent has uncommitted work in any of the five touched files;
  - the ported header test fails against the unchanged `ResourceDetailPage`. In that case, fix the test to match the existing layout; do not change the shared component.
- **Safer smaller alternative:** if the manifest or story edit is contested, for example while RF-047 is in flight, delete the three components and the skill-only test blocks, port the header test, and keep the story file compiling by removing only the skill sections. Leave the manifest for RF-047. The after frames of those four entries would then point at a missing story, which is acceptable for a finished review artifact.
