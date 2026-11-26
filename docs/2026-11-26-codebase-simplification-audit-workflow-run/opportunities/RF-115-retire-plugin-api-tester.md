# RF-115 — Retire the placeholder Plugin API Tester bundled plugin and its eight registration entries

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: the plugin is a 40-line placeholder that still occupies a slot in every bundled-plugin list. Three parts of the sweep report were corrected:
  - The investigation gate is already answered. Omnyo has a tested cleanup path for a bundled plugin that is no longer shipped (`removeUnbundledBuiltins`, described below), so retirement needs no migration or consolidation entry.
  - A plugin-local test does exist (`plugins/plugin-api-tester/app.test.tsx`, 23 lines). It checks that the panel registers and renders. It is not a host loading smoke test, so the sweep's point stands in substance.
  - The "fork-check CI run" cost is smaller than stated. The snapshot has no `.github/workflows`, so `pnpm check:plugin-forks` only runs when someone starts it locally (see RF-017).
- **Potential:** low. No user-facing capability of substance disappears. The gain is one fewer plugin package to keep building, typechecking, linting, fork-checking and listing.
- **Confidence:** high on the mechanics: every consumer was found and the upgrade path is tested. Medium on value, because Alex may want to keep a minimal plugin as a manual check.
- **Readiness:** decision-needed. The plugin is a shipped catalog entry. Every install auto-registers it (disabled), and any user can enable it from the Plugins page, so retiring it removes a user-visible option. Only Alex can decide that.
- **Effort:** small, about 1 to 2 hours including verification. Delete one directory, edit eight list sites, refresh the lockfile and run the focused tests.
- **Risk:** low. Affected contracts: the bundled catalog (`BUILTIN_PLUGINS`, `plugins/omnyo-official.json`) and existing `installed_plugins` rows for `plugin-api-tester`. Startup deletes those rows automatically and logs the removal at info level. A user who had enabled the plugin loses a placeholder page and nothing else, because the plugin has no settings, secrets, schedules, tools or data.
- **Prerequisites:** the owner's decision, either (a) retire the plugin or (b) keep it and fix its copy (incidental issue ISS-S13-03).
- **Related and overlapping RF ids:**
  - RF-020 ("Derive plugin-SDK turbo task dependencies from defaults instead of 93 per-plugin entries") removes this plugin's two `turbo.json` entries anyway. Count those 10 lines once.
  - RF-047 ("Retire the finished Polish review Ladle story and manifest") deletes the whole manifest that holds this plugin's 20-line review record. Count those lines once.
  - RF-017 decides whether the fork-check CI job is published. That decision changes how much CI time this retirement saves.
  - RF-116 ("Decide whether to keep three manual-only demo examples") is the same kind of owner decision about manual-only artifacts.
- **Why it deserves its place:** retirement is cheap, certain and self-cleaning on upgrade. It removes a whole plugin package from the bundled build, the fork list and the catalog. The value is modest, so it belongs low in the ranking, but it is a clear decision to put to Alex.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The read-only snapshot worktree had been removed by the time of verification. Every citation below was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3…:<path>` and `git grep … e9e1b74c3…`. `git diff --stat e9e1b74c3 5f2d3f895` over every path this card edits returned no changes, so local `main` at `5f2d3f895` holds the same content. The snapshot has no `node_modules`, so nothing was built or run.

How bundled plugins work: `apps/server/src/services/plugins/builtin-registry.ts` lists the plugins shipped with Omnyo. Entries in `BUILTIN_PLUGINS` (lines 27–236) get `autoInstall: true`. At every startup, `reconcileBundled` in `apps/server/src/services/plugins/plugin-registration.ts:848` writes an `installed_plugins` row for each one, enabled or disabled according to `defaultEnabled`. `packages/bundled-plugins/build.ts:27` builds each `BUNDLED_PLUGINS` entry into the shipped bundle. `apps/server/scripts/generate-omnyo-official-marketplace.ts` builds the "Omnyo Official" catalog, and `parseOmnyoOfficialCatalogFields` (line 78) throws when `plugins/omnyo-official.json` has a block missing or extra relative to `BUNDLED_PLUGINS`.

Observed facts (Proven by inspection):

- The plugin is 7 tracked files (`git ls-tree -r --name-only e9e1b74c3 plugins/plugin-api-tester`), counted with `git show … | wc -l`:
  - Production source: `app.tsx` (35 lines) registers one `app.slots.navPanel` with id `plugin-api-tester`, path `plugin-api-tester` and icon `Beaker`. Its component `PluginApiTesterPanel` renders a static card titled "Plugin API Tester is active". `server.ts` (5 lines) is a no-op `plugin(api)` that only runs `void api`.
  - Test: `app.test.tsx` (23 lines) uses `loadPluginApp` and `renderSlot` from `@omnyo/plugin-sdk/testing/app` to assert the one nav panel and its title text.
  - Config: `package.json` (53 lines, scripts `test`, `typecheck`, `lint`, `prepare:bundled`), `tsconfig.json` (14) and `vitest.config.ts` (10).
  - Doc: `PLUGIN_OVERVIEW.md` (16 lines). The marketplace generator reads it as the catalog overview text.
- Registration and list sites (a whole-repository `git grep -n -I -i -e 'plugin-api-tester' -e 'Plugin API Tester' -e pluginApiTester -e plugin_api_tester e9e1b74c3` found exactly these outside the plugin directory):
  1. `apps/server/src/services/plugins/builtin-registry.ts:108-112`: the `BUILTIN_PLUGINS` entry `{ name: "plugin-api-tester", pluginId: "plugin-api-tester", defaultEnabled: false }`. The list is mapped to `autoInstall: true` at lines 233–236.
  2. `packages/bundled-plugins/package.json:32`: the dependency `"omnyo-plugin-plugin-api-tester": "workspace:*"`.
  3. `plugins/omnyo-official.json:30-33`: the catalog block `{ "category": "plugin-development", "screenshots": [] }`. The category survives the removal, because `plugins/plugin-api-docs` also uses it (`plugins/omnyo-official.json:71`).
  4. `scripts/forkable-plugins.json:23`: `"plugins/plugin-api-tester"`.
  5. `turbo.json:1455-1464`: the tasks `omnyo-plugin-plugin-api-tester#typecheck` and `#test`.
  6. `apps/server/test/services/plugins/builtin-plugins.test.ts:959`: the key `"plugin-api-tester": false` in the test "ships each product builtin with its deliberate default".
  7. `apps/server/test/services/plugins/builtin-registry.test.ts:37`: the entry in `UNPREFIXED_BUNDLED_PLUGIN_IDS`, compared with `toEqual` at line 60, so the entry must be removed.
  8. `apps/app/src/polish-review/polish-review-manifest.ts:4002-4021`: the dev-only review record `home-tools-api-tester-placeholder`.
  - Generated: `pnpm-lock.yaml:1690-1692` and `pnpm-lock.yaml:4780-4821` (about 45 lines).
- The upgrade path for existing installs is already implemented and tested:
  - `apps/server/src/services/plugins/plugin-service.ts:657` `isOrphanedBuiltinRow` marks a row whose `sourceKind` is `builtin` and whose `sourceBuiltinName` no longer appears in `bundledPlugins`.
  - `removeUnbundledBuiltins` (line 1514) runs at startup right after `reconcileBundled` (line 1742) and again on resume (line 3221). For each orphaned row it calls `deleteRemovedPluginData` and `deleteInstalledPlugin`, then logs at info level: "plugin <id> removed because Omnyo no longer bundles <source>; its settings, secrets, and schedules were deleted".
  - `apps/server/test/services/plugins/builtin-plugins.test.ts:639` "removes a builtin and its data once Omnyo no longer bundles it" covers this path with a fixture, and the test that follows covers a retry after a failed secret removal.
  - `reconcileBundled` itself only iterates `bundledPlugins`, so it never touches the removed row and never logs the "bundled plugin … is unavailable" warning for it. That warning (line 862) only fires for a listed plugin whose root is missing.
  - No `plugin-consolidations.ts` entry is needed: consolidation maps an old plugin id to a successor, and this plugin has no successor.
- No dynamic consumer depends on this plugin. Checked:
  - `apps/web/src/plugin-guide/plugin-directory.ts:11` globs `plugins/*/package.json` and looks plugins up by directory name. No list asserts this plugin's presence.
  - `apps/web/src/plugin-guide/plugin-guide.test.ts:93` and `packages/scripts/test/plugin-guide-first-party.test.mjs` read the `plugins/` directory, but each only checks the entries it finds.
  - `plugins/plugin-api-docs/src/first-party-plugins.json` does not list this plugin.
  - `packages/scripts/test/plugin-forks.test.mjs:339` iterates the fork list, so it shrinks automatically.
  - `providerInstallRank` in `apps/server/src/services/plugins/plugin-runtime.ts:1972` uses the `BUNDLED_PLUGINS` index. Removing a non-provider entry keeps the relative order of every provider.
  - A search of `$OMNYO_PLUGIN_CHECKOUT` (excluding `node_modules`) found no reference.
  - No doc, skill, CLI command or QA proof names the plugin.
- The plugin's copy is wrong (incidental issue ISS-S13-03). Three places say it is on by default in development: `app.tsx:18-19`, `PLUGIN_OVERVIEW.md:10` and the review record at `polish-review-manifest.ts:4010`. No such development default exists. `isBundledPluginEnabledByDefault` (`builtin-registry.ts:279`) depends only on `defaultEnabled` and `DISABLED_BY_DEFAULT_PLUGIN_IDS`, and a search of `apps/server/src`, `apps/desktop/src` and `scripts` for `defaultEnabled` found no development override.
- Persisted sidebar preferences need nothing new (Proven by inspection for the default state; an inference for enabled users). `sidebar.pluginPanelOrder` and `sidebar.visiblePluginPanels` (`apps/app/src/components/plugin/pluginNavSidebarAtoms.ts`) may hold this panel's key. `useSidebarNavigationArrangement` arranges only the panels currently present (`rows`). Because the plugin is disabled by default, most installs already run with its panel absent, which exercises the same code path.

Counterevidence and current requirement: the overview text says to "use it as a smoke test when you change how Omnyo loads bundled plugins". That is a manual check only: no script, QA recipe or test outside the plugin opens its panel. Other options already cover the need:
- `tests/qa/plugin-loading/proof.mjs` builds its own `loading-proof` nav panel to prove plugin loading.
- Many default-enabled bundled plugins (Plugin Guide, Tasks, Workflows) mount nav panels on every run.
- `packages/templates/src/plugin-scaffold.ts:1317` generates a navPanel scaffold for new plugin authors.
- `examples/plugins/` holds eight example plugins.

Maintenance cost today: any change to the bundled-plugin lists, the SDK `navPanel` signature, plugin `package.json` conventions (engines, TypeScript pins, lint script), the fork-check tooling or the catalog generator has to cover this package as well. Each `pnpm check:plugin-forks` run installs, typechecks, tests and builds it from published packages.

**Proposed end state and preservation argument**

Option (a), retire:
- The directory `plugins/plugin-api-tester/` and its eight list entries disappear.
- The bundled catalog, the Plugins page and the Omnyo Official marketplace stop offering "Plugin API Tester".
- On the first startup after the upgrade, `removeUnbundledBuiltins` deletes each existing install's `installed_plugins` row and logs the info line quoted above.
- The `plugin-development` category keeps Plugin Guide. The tested orphaned-row path remains the owner of upgrade cleanup, and no new code is added.

Preservation: no other plugin, API, SDK export, CLI command, persisted format or UI state changes. The only behavior change is the retirement itself, which is the owner's decision. Users who enabled the plugin see its sidebar entry disappear. A stale sidebar-preference key is ignored, as it already is while the plugin is disabled.

Option (b), keep: change nothing structural. Fix ISS-S13-03 separately by correcting the three development-default sentences and, optionally, the `package.json` description "Exercise and inspect Omnyo plugin API surfaces during development", which describes surfaces the plugin does not exercise.

Non-goals:
- Do not change `removeUnbundledBuiltins`, `reconcileBundled` or plugin consolidations.
- Do not add a migration.
- Do not touch `plugin-api-docs` (Plugin Guide).
- Do not retire other `plugin-development` plugins.

Remaining uncertainty: whether Alex uses the panel as a manual check. No artifact suggests that he does.

**Expected gain and cost**

Line counts use `git show e9e1b74c3:<path> | wc -l` or the cited line ranges.

| Kind | Removed | Notes |
| --- | --- | --- |
| Handwritten production source | 40 lines (`app.tsx` 35, `server.ts` 5), plus 5 lines in `builtin-registry.ts` | No lines added |
| Package config | 77 lines (`package.json` 53, `tsconfig.json` 14, `vitest.config.ts` 10) | |
| List and config entries | 16 lines: `bundled-plugins/package.json` 1, `omnyo-official.json` 4, `forkable-plugins.json` 1, `turbo.json` 10 | The `turbo.json` lines overlap RF-020 |
| Tests | 23 lines (`app.test.tsx`) plus 2 assertion lines in the server tests | No distinct host behavior loses coverage |
| Docs | 16 lines (`PLUGIN_OVERVIEW.md`) | |
| Dev-only review manifest | 20 lines | Overlaps RF-047 |
| Generated lockfile | about 45 lines | |

- **Mechanisms (before → after):** 37 → 36 entries in `BUILTIN_PLUGINS`, 36 → 35 forkable plugins, one fewer workspace package with its own `test`, `typecheck`, `lint` and `prepare:bundled` tasks, and one fewer catalog block for the generator to validate.
- **Maintenance:** a change to plugin `package.json` conventions or the `navPanel` signature has one fewer package to update and verify. This is a projection, not a measurement.
- **Performance:** slightly less work per bundled-plugin build and per fork-check run (Hypothesis, not measured). App runtime is neutral, because the plugin is disabled by default and its panel never mounts.
- **Cost:** Plugin API Tester leaves the product, and the trivial manual smoke page is lost.

**Execution steps**

Investigation gate (finish before step 2):

1. Ask the owner to choose: (a) retire Plugin API Tester, or (b) keep it and fix its copy under ISS-S13-03. If he chooses (b), stop here: this card does not apply, and the copy fix is its own change. If he wants a host-level loading smoke test, note that `tests/qa/plugin-loading/proof.mjs` already exists.

Implementation (option a only):

2. Reconfirm the anchors on the working branch. From `$OMNYO_CHECKOUT`, run `git grep -n -I -i -e 'plugin-api-tester' -e 'Plugin API Tester' -- . ':!docs/2026-11-26-codebase-simplification-audit'`. The output should list the 8 sites above plus `pnpm-lock.yaml` and the plugin's own files. A new consumer, such as a QA recipe, a doc that tells users to enable the plugin, or a test that loads the plugin's root, invalidates this plan: re-plan. Check `git status` for uncommitted foreign edits in any file listed below, and edit around them.
3. Delete the 7 tracked files under `plugins/plugin-api-tester/` with `git rm -r plugins/plugin-api-tester`. In an installed checkout, an ignored `plugins/plugin-api-tester/node_modules` symlink tree may remain. Step 9's `pnpm install` stops linking it. Removing the leftover ignored directory is deletion of untracked content, so ask Alex before removing it. While it remains it is harmless: every directory scanner above skips directories without `package.json`.
4. Edit `apps/server/src/services/plugins/builtin-registry.ts`: remove the `BUILTIN_PLUGINS` object at lines 108–112 (`name: "plugin-api-tester"`). Leave the order of the other entries unchanged.
5. Edit `packages/bundled-plugins/package.json`: remove line 32, `"omnyo-plugin-plugin-api-tester": "workspace:*",`.
6. Edit `plugins/omnyo-official.json`: remove the `"plugin-api-tester"` block at lines 30–33. This must land in the same commit as step 4, because `parseOmnyoOfficialCatalogFields` rejects any mismatch.
7. Edit `scripts/forkable-plugins.json`: remove line 23, `"plugins/plugin-api-tester",`.
8. Edit `turbo.json`: remove the `omnyo-plugin-plugin-api-tester#typecheck` and `#test` task entries (lines 1455–1464). Skip this step if RF-020 has already removed per-plugin entries.
9. Refresh the lockfile with the repository's package manager, `pnpm install`, from the repository root. This is an install and needs network access. It removes `pnpm-lock.yaml` lines 1690–1692 and the `plugins/plugin-api-tester:` importer block. Never hand-edit the lockfile.
10. Update the tests that encode the list:
    - `apps/server/test/services/plugins/builtin-plugins.test.ts:959`: remove the `"plugin-api-tester": false,` key.
    - `apps/server/test/services/plugins/builtin-registry.test.ts:37`: remove `"plugin-api-tester",` from `UNPREFIXED_BUNDLED_PLUGIN_IDS`.
    - Do not weaken either assertion in any other way.
11. Edit `apps/app/src/polish-review/polish-review-manifest.ts`: remove the record with `id: "home-tools-api-tester-placeholder"` (lines 4002–4021), because its `files` entry would point at a deleted file. Skip this step if RF-047 has already removed the manifest. Before deleting, confirm with `git grep -n home-tools-api-tester-placeholder` that nothing else references the id.
12. Format the edited files with the repository formatter: `pnpm exec oxfmt <changed files>` from the repository root. Do not reformat unrelated files.
13. Inspect `git diff --stat`. Expect only the deletions above and the lockfile change. Confirm that the step 2 `git grep` now returns nothing outside the audit docs.

No migration step: existing rows are removed by `removeUnbundledBuiltins` at the first startup after the upgrade.

**Verification and acceptance criteria**

Run from `$OMNYO_CHECKOUT` after `pnpm install`. Script names were read from the relevant `package.json` files at the snapshot. The commands themselves were not run during this audit, because the snapshot had no `node_modules`.

- Server registry, upgrade cleanup and catalog parity: `pnpm --filter @omnyo/server exec vitest run --config vitest.config.ts test/services/plugins/builtin-plugins.test.ts test/services/plugins/builtin-registry.test.ts test/services/plugins/official-plugins.test.ts test/services/plugin-catalog/omnyo-official-generator.test.ts`. Expect all to pass. The orphaned-builtin tests at `builtin-plugins.test.ts:639` and `official-plugins.test.ts:368` are the behavioral proof of the upgrade path.
- Catalog generation: `pnpm --filter @omnyo/server generate:omnyo-official-marketplace` (a script defined in `apps/server/package.json`, also run by the root `prepare`). Expect no "missing bundled plugin blocks" or "unknown bundled plugin blocks" error.
- Bundled build: `pnpm --filter @omnyo/bundled-plugins build`. Expect it to finish without a reference to `plugin-api-tester`.
- Fork list and Plugin Guide tables: `pnpm --filter @omnyo/scripts test` (covers `plugin-forks.test.mjs` and `plugin-guide-first-party.test.mjs`) and `pnpm --filter @omnyo/web exec vitest run --config vitest.config.ts src/plugin-guide/plugin-guide.test.ts src/explore/plugin-identity.test.ts`.
- Types and lint: `pnpm --filter @omnyo/server typecheck`, plus `pnpm --filter @omnyo/app typecheck` and `pnpm --filter @omnyo/app lint` if step 11 ran. Finish with `pnpm exec oxlint --deny-warnings --format=agent` on the changed TypeScript files.
- Upgrade behavior on a real data directory (manual, optional; Alex tests UI himself): start a development server against a data directory created before the change. Expect one info log line "plugin plugin-api-tester removed because Omnyo no longer bundles builtin:plugin-api-tester; …". Expect no warning or error about `plugin-api-tester`, and expect the Plugins page not to list it. If the plugin was enabled there, expect its sidebar entry to disappear with no broken placeholder.
- Structural completion: `git grep -n -I -i -e 'plugin-api-tester' -e 'Plugin API Tester' -- . ':!docs/2026-11-26-codebase-simplification-audit'` returns nothing. The `plugin-development` category still has Plugin Guide (`plugins/omnyo-official.json`).

**Rollback and stop conditions**

- Rollback: the change is one commit of tracked-file deletions and list edits. Reverting it restores the plugin, and `reconcileBundled` auto-installs it again, disabled, on the next startup. A user who had enabled it before the retirement gets it back disabled, because `removeUnbundledBuiltins` deleted the old row along with its enabled state. The plugin has no data, so nothing else is lost.
- Stop if Alex chooses to keep the plugin. Do the copy fix under ISS-S13-03 instead.
- Stop if step 2 finds a consumer outside the eight sites, such as a QA recipe, a release checklist, a doc telling users to enable the plugin, or a test that loads `resolveBuiltinPluginRootPath("plugin-api-tester")`. Re-plan to cover or replace that consumer first.
- Stop if the upgrade check shows a warning or error, rather than the single info line, for the removed row. That would contradict the tested `removeUnbundledBuiltins` path. Investigate the startup sequence in `plugin-service.ts` around line 1741 before shipping.
- Stop if the catalog generator or the bundled build still expects the plugin after steps 4–6. Find the list that was missed rather than adding an exception.
