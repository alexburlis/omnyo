# RF-035 — Retire the seven host `sidebar.*` layout preferences, the Thread list plugin's one-time import of them, and the installation-default fallback that only that import used

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The central claim holds: after the Thread list plugin's one-time import, nothing in Omnyo reads the seven host keys. This card corrects the sweep reports in five ways:
  - The import covers eight host keys, not seven. `sidebar.hiddenGroups` also has a `legacyKey`, and that host key stays live for the project rail.
  - Removing the host keys also leaves the `ui_preference_defaults` installation-fallback read path with no key to serve, so that path becomes dead machinery too.
  - The repository already has a test, and a precedent, for retiring host UI preference keys.
  - An older CLI talking to a newer server prints a crash in `omnyo settings ui list` after this change.
  - A vendored fork of the import in the private `omnyo-plugins` repository also reads these keys, and it tolerates their absence.
- **Potential:** medium. About 140 physical (126 non-blank) handwritten production lines go in the core change, plus about 40 more if the installation-default read path is removed. What actually disappears is a second registry for seven settings, with its own schemas, defaults and descriptions, which three guides document as live although writing to it does nothing.
- **Confidence:** high for reachability. Every consumer is listed below and was checked by inspection. The remaining uncertainty is product-level: how many installs have not started the Thread list plugin since 2026-09-21.
- **Readiness:** decision-needed. Alex must accept that an install upgrading directly from a build older than 2026-09-21, or one that has kept the bundled Thread list plugin disabled ever since, opens with the plugin's defaults instead of its old sidebar layout. He must also accept that the seven keys disappear from the public `omnyo settings ui`, SDK and HTTP preference surface.
- **Effort:** small to medium, about 3 to 4 hours. Most of the time goes on re-keying generic tests that use these keys as fixtures and on rewriting three guides.
- **Risk:** low to medium. There are four realistic risks:
  1. Lost layout for very old, never-upgraded installs. This is the accepted cost if Alex approves the change.
  2. Scripts that write these keys start failing with `404 ui_preference_not_found` instead of silently doing nothing. That is visible and arguably correct.
  3. An older CLI binary's plain-text `omnyo settings ui list` throws a TypeError against a newer server.
  4. Typechecks catch any missed TypeScript consumer.
- **Prerequisites:** the owner's decision (gate G0 below). No other RF item has to land first.
- **Related and overlapping items:**
  - RF-004 ("Delete client-core's orphaned sidebar model now owned by the Thread list plugin") is another remnant of the same September 2026 move into the plugin. The two items touch different files, and either can land first.
  - RF-040 ("Retire the plugin-local BB-to-Omnyo browser-storage imports in Thread list and Push notifications") also edits `plugins/thread-list`. It touches `app/preferences/preferences-sync.ts`, not `server.ts` or `shared/preferences.ts`. Rebase carefully if the two land together.
  - RF-041 ("Execute the scheduled SDK next-major removal batch") is the alternative home if Alex wants public-surface removals batched.
  - RF-006 ("Retire the stopped-state BB-to-Omnyo identity adoption") owns `apps/server/src/services/plugins/omnyo-plugin-state-v1.ts`, which runs SQL against the `ui_preference_defaults` table. This card keeps that table, so the two items do not conflict.
  - Out of scope: `sidebar.hiddenGroups` has its own two-store split between the host key and the plugin's `hiddenGroups`. This card keeps the host key.
- **Why this deserves its place:** this removes dead machinery and duplicated knowledge with a clean reachability proof. The decision is a narrow upgrade-cutoff choice with a repository precedent: `sidebar.navigationProvider` and `sidebar.headerProvider` were retired the same way. It also ends a user-visible trap: documentation tells users to run `omnyo settings ui set sidebar.organizationMode machine`, which succeeds and changes nothing.
- **Smaller alternative if Alex defers the deletion:** fix the documentation only (see the incidental issue reported with this card) and reword the seven host descriptions to "Legacy: copied once into the Thread list plugin; use `omnyo thread-list prefs`". That fix deletes nothing.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The named snapshot worktree no longer existed during verification, so every file was read with `git show e9e1b74c3:<path>` and searched with `git grep <pattern> e9e1b74c3 -- <paths>`. The cited files are byte-identical at local `main` `5f2d3f895` (checked with `git diff --stat e9e1b74c3 5f2d3f895 -- <file>`, which produced no output). Every path below is repository-relative. The snapshot has no `node_modules`, so no test was run. All evidence is **Proven by inspection** unless labeled otherwise.

*What the subsystem is.* The host keeps a keyed, revisioned registry of UI preferences in the `ui_preferences` SQLite table. The registry is served at `GET/PUT/DELETE /api/v1/preferences/ui[/:key]` and exposed as `sdk.system.uiPreferences` and `omnyo settings ui`. Until 2026-09-21 the built-in sidebar read seven layout keys from it. Private-history commit `38657df20c` (2026-09-21, "Scaffold the thread-list plugin with synced layout preferences") moved the thread list into the bundled Thread list plugin. That plugin stores its own preferences in plugin KV and copies the old host values across once. The built-in sidebar was deleted the same week (see RF-004). The private history lives at `$ARCHIVED_OMNYO_CHECKOUT`.

*Host side, the registry entries that would go:*
- `packages/domain/src/ui-preferences.ts:8-25`. The schemas `sidebarOrganizationModeSchema`, `sidebarChronologicalSortSchema` and `sidebarThreadGroupingSchema`, and the exported type `SidebarOrganizationMode`. `git grep -n -E 'SidebarOrganizationMode|sidebarOrganizationModeSchema|sidebarChronologicalSortSchema|sidebarThreadGroupingSchema' e9e1b74c3` finds no user outside this file. The plugin files that use the name `SidebarOrganizationMode` alias the plugin's own `OrganizationMode`.
- `packages/domain/src/ui-preferences.ts:92-98`. The seven `UI_PREFERENCE_KEYS` entries `sidebar.organizationMode`, `sidebar.threadGrouping.environment`, `sidebar.chronologicalSort`, `sidebar.sortDirection`, `sidebar.sectionOrder`, `sidebar.manualSectionOrder` and `sidebar.machineSectionOrder`.
- `packages/domain/src/ui-preferences.ts:134-168`. The seven `uiPreferenceDefinitions` entries. The description at line 137 still says the key controls "How the sidebar groups threads".

*Host side, the generic consumers. These need no logic change because they iterate `UI_PREFERENCE_KEYS`:*
- `apps/server/src/services/system/ui-preferences.ts:60` `readUiPreferences`. It drops stored rows whose key fails `isUiPreferenceKey` (line 71) and emits only `UI_PREFERENCE_KEYS` (line 75).
- `apps/server/src/routes/ui-preferences.ts:26`. Unknown keys return `404 ui_preference_not_found`, as `apps/server/test/public/public-ui-preferences.test.ts:600-603` shows.
- `apps/cli/src/commands/settings.ts:366` `requireUiPreferenceKey` and `:770` (`ui list`).
- `apps/app/src/hooks/cache-owners/boot-cache-owner.ts:59` `isUiPreferencesResponse`.
- The type-level SDK surface: `packages/sdk/src/areas/system.ts:198-218` and `packages/server-contract/src/api/ui-preferences.ts`, both keyed by `UiPreferenceKey`.

*Plugin side, the import that would go:*
- `plugins/thread-list/server.ts:26` `MIGRATION_KV_KEY = "migration:ui-preferences:v1"`.
- `plugins/thread-list/server.ts:141-193` `migrateFromUiPreferences`. It reads `api.sdk.system.uiPreferences.list()` once, then copies each host value that parses and differs from the plugin default into `preference:<key>`, unless the plugin already holds a value. It then sets the guard. If the read fails, it returns without setting the guard.
- `plugins/thread-list/server.ts:338-344`, the call at the end of plugin start.
- `plugins/thread-list/shared/preferences.ts:111-118` `definePreference(schema, defaultValue, description, legacyKey)`, plus the 20 `legacyKey` argument lines (125, 131, 141, 147, 153, 159, 165, 171, 177, 183, 189, 195, 207, 213, 219, 225, 231, 237, 243 and 249). Eight of these name a host key: the seven above plus `sidebar.hiddenGroups` at line 195. Twelve are `null`. `legacyKey` is read only at `server.ts:170`, as `git grep -n legacyKey e9e1b74c3 -- plugins/thread-list` shows.
- `plugins/thread-list/skills/thread-list/SKILL.md:32-33`: "On first load the plugin copies any non-default `sidebar.*` values from `omnyo settings ui` once; after that the two are independent."

*Reachability searches:*
- `git grep -n -E 'sidebar\.(organizationMode|threadGrouping\.environment|chronologicalSort|sortDirection|sectionOrder|manualSectionOrder|machineSectionOrder)' e9e1b74c3 -- .` over the whole tree, outside the audit docs, finds four groups of files:
  - Production code: only `packages/domain/src/ui-preferences.ts` and the plugin's `legacyKey` literals.
  - Fixtures: `apps/demo-server/fixtures.mjs:175-181` and `apps/demo-server/test.mjs:157` and `:229`.
  - Applied migration history: `packages/db/drizzle/0129_sidebar_installation_defaults.sql:7`.
  - Docs, listed below, and tests, listed in the execution steps.
  - There are no hits in `apps/mobile`, `apps/desktop`, `apps/host-daemon` or `apps/cli`.
- `git grep -l -E 'threadGrouping\.environment|machineSectionOrder' e9e1b74c3` lists only those files, plus the plugin's own `machineSectionOrder` preference in `plugins/thread-list/app/preferences/atoms.ts:40`.
- Dynamic addressing: ``git grep -n -E '`sidebar\.\$\{|"sidebar\." *\+' e9e1b74c3 -- apps packages plugins`` finds nothing.
- App readers: `git grep -n 'createSyncedPreferenceAtom(' e9e1b74c3 -- apps ':!*.test.*' ':!*.stories.*'` shows that the app syncs only model-picker keys, nav-panel keys, `infoPanel.collapsedSections`, `sidebar.hiddenGroups` (`apps/app/src/components/sidebar/projectRailPreferences.ts:7-8`), the footer keys and `sidebar.threadListProvider`.
- Plugin readers: in `plugins/thread-list`, the only `uiPreferences` reference outside tests is `server.ts:151`, inside the import.

*Persisted data:*
- `packages/db/drizzle/0129_sidebar_installation_defaults.sql` (private commit `c1104a2635`, 2026-09-21) created `ui_preference_defaults` and, on installs that already had work, seeded `sidebar.organizationMode = "project"`.
- `git grep -n -E 'INSERT INTO .?ui_preference_defaults' e9e1b74c3` finds no other production writer.
- The only readers are `apps/server/src/services/system/ui-preferences.ts:29-40` `installationDefault`, `:61-66`, `:116-119`, and `packages/db/src/data/ui-preferences.ts:28-43` `listStoredUiPreferenceDefaults` / `getStoredUiPreferenceDefault`. `apps/server/src/services/plugins/omnyo-plugin-state-v1.ts:327` also runs SQL against the table, but only to rename BB-era values of five other keys.
- Today the `"project"` fallback reaches users only through the plugin import, which sees `{ revision: 0, value: "project" }` and copies it because it differs from the plugin default `"chronological"`. Once the seven keys are gone, no defined key has a row in this table, so the installation-default read path can never change a result.

*Precedent and existing coverage:*
- Private commit `ff94848832` (2026-10-08) retired the host keys `sidebar.navigationProvider` and `sidebar.headerProvider`.
- `apps/server/test/public/public-ui-preferences.test.ts:66` ("ignores stored rows for retired sidebar provider preferences") writes rows for those keys into both `ui_preferences` and `ui_preference_defaults`, then asserts that the listing omits them.
- `:665-681` ("falls back to the default when a stored value no longer parses") also checks that the listing omits the key `sidebar.unknownKey`.
- The S17 request to "add a test that readUiPreferences ignores rows for undefined keys" is therefore already covered. Extend the existing test instead.

*External and older consumers. These come from read-only `rg` over `$OMNYO_PLUGIN_CHECKOUT` at `7edbc502`:*
- `alex-fixes/sidebar/vendor/server.ts:135-190` and `alex-fixes/sidebar/vendor/shared/preferences.ts:142-190` are a vendored fork of the same import. They run under the `alex-fixes` plugin id, with their own KV. That code reads `entries[legacyKey]` as possibly undefined and skips it (`if (legacy === undefined) continue;`), so it keeps working and imports nothing.
  - A plain `rg -l` from the repository root missed these files because they are ignored by a `.gitignore` rule. They are nevertheless tracked (`git ls-files alex-fixes/sidebar/vendor`) and were found only by searching the explicit path.
- `branch-tree/app.tsx`, `branch-tree/server.ts` and `chat-groups/app.tsx` use only `sidebar.threadListProvider`.
- An older `@omnyo/cli` running the plain-text `omnyo settings ui list` against a newer server crashes. The loop at `apps/cli/src/commands/settings.ts:770-775` iterates its own compiled key list and reads `entry.value` with no undefined check. `--json` output and the `get`/`set` of surviving keys are unaffected. Whether such version skew happens in practice is a **Hypothesis**: per `docs/configuration.md`, daemons auto-update to newer server protocols.
- Older app bundles only reject a stale boot cache (`isUiPreferencesResponse` returns false) and then fetch normally.

*Documentation that describes the host keys as live:*
- `docs/configuration.md:1578-1583` (table rows), `:1621-1625` (installation fallback), `:1650-1660` (`sidebar.threadGrouping.environment`) and `:1673-1674` (CLI examples).
- `plugins/omnyo-guide/skills/omnyo-cli/references/app-settings.md:41-46` and `:61-70`.
- `packages/templates/src/templates/omnyo-guide-customization.md:530-534` and `:552-560`.

*Schema drift (observed):* the plugin's section-order defaults add `"shelf"`, for example `["pinned","projects","threads","shelf"]` in `shared/preferences.ts:175` against `["pinned","projects","threads"]` in `ui-preferences.ts:156`. The plugin's `hiddenGroups` also accepts `"threads"`, which the domain schema does not. The two registries already describe different products.

*Maintenance cost today.* A maintainer who adds or renames a thread-list layout preference has to decide whether it needs a host `legacyKey`, and finds a second host definition with a different default. Each guide edit has to keep describing seven host keys that no code reads. Users and agents following the guides change a value that has no effect.

**Proposed end state and preservation argument**

*What disappears:*
- The seven host keys and their three schemas and one exported type.
- The plugin import (`migrateFromUiPreferences`, `MIGRATION_KV_KEY`, the call and its log line).
- The `legacyKey` parameter and its 20 arguments.
- The seven demo-server fixture entries.
- The guide text that teaches the host keys.
- Optionally, checkpoint D: the installation-default read path in the server service and the two `@omnyo/db` read functions.

*What remains:*
- The Thread list plugin is the single owner of thread-list layout. Its storage is plugin KV `preference:<key>`, and its interfaces are `omnyo thread-list prefs ...` and the `listPreferences`/`setPreference`/`resetPreference` RPCs. None of these change.
- The host registry keeps its ten other keys, including `sidebar.hiddenGroups`, and all of its routes, revision semantics and broadcast behavior.
- Migration `0129` and the `ui_preference_defaults` table and its `packages/db/src/schema.ts:260` definition stay as applied history. Dropping the table would need a new migration and would conflict with `omnyo-plugin-state-v1.ts`.
- Stored `ui_preferences` rows for the retired keys stay on disk. `readUiPreferences` ignores them, as it does today for `sidebar.navigationProvider`.
- The plugin's stale KV row `migration:ui-preferences:v1 = true` stays. Nothing reads it, and deleting it would need new code.

*How current semantics survive:* every install that has started the bundled, default-enabled Thread list plugin since 2026-09-21 (`apps/server/src/services/plugins/builtin-registry.ts:188-192`, `defaultEnabled: true`) already has the guard set and its values copied. For those installs nothing changes, because the plugin never reads the host keys again. The UI cannot write the host keys, because no app component syncs them.

*Intentional behavior changes, which need the owner's approval:*
1. An install that upgrades directly from a pre-2026-09-21 build, or one that kept the Thread list plugin disabled the whole time and enables it later, starts with plugin defaults. For an install with existing work that means `chronological` instead of `project`.
2. `omnyo settings ui get|set|reset` for the seven keys, `sdk.system.uiPreferences.set` for them, and `PUT /api/v1/preferences/ui/<key>` return `ui_preference_not_found` (HTTP 404) instead of silently storing a value that has no effect. `omnyo settings ui list` stops listing them.
3. The `UiPreferenceKey` union narrows in the `@omnyo/sdk` and `@omnyo/plugin-sdk` type surface. A plugin that names one of these keys in TypeScript stops compiling against the new SDK. None does in either repository; the `alex-fixes` fork casts to `Record<string, …>`.

*Non-goals:*
- Any change to `sidebar.hiddenGroups` or its project-rail consumer.
- Dropping `ui_preference_defaults`.
- Changing plugin preference defaults.
- The browser-storage imports covered by RF-040.

*Why this is the simplest sufficient option:* keeping the host keys as a read-only migration source (the X1 option (a)) leaves the whole second registry in place indefinitely. Making the plugin follow the host keys again (X1 option (c)) reverses the plugin move. Deleting them is the only option that removes the duplicated registry.

**Expected gain and cost**

These figures were measured on the snapshot with `git show` and a Python line counter (`python3 -I -c …` over the stated ranges). They are projections of the deletion, not measured diffs.

| Area | Physical lines removed | Non-blank |
|---|---|---|
| `plugins/thread-list/server.ts` (lines 26, 141-193, 337-344 and adjacent blank lines) | about 63 | 48 |
| `plugins/thread-list/shared/preferences.ts` (the `legacyKey` parameter and 20 arguments; the return object is edited) | 21 | 21 |
| `packages/domain/src/ui-preferences.ts` (8-25, 92-98, 134-168) | 60 | 57 |
| **Core production total** | **about 144** | **about 126** |
| Optional checkpoint D: `apps/server/src/services/system/ui-preferences.ts` `installationDefault` and the defaults map (about 20), plus `packages/db/src/data/ui-preferences.ts:28-43` and two re-exports in `packages/db/src/data/index.ts:189-190` (about 18) | about 38 | about 33 |
| Fixture: `apps/demo-server/fixtures.mjs:175-181` | 7 | 7 |

The other changes are not counted as production code:

- **Tests:**
  - About 42 lines go from `plugins/thread-list/server.test.ts`: the `describe("migration from Omnyo's sidebar preferences")` block at 293-335, the call at 121, and the `uiPreferences`/`uiPreferencesFail` setup options at 13-25 if nothing else uses them.
  - About 75 lines of installation-fallback tests go from `apps/server/test/public/public-ui-preferences.test.ts:473-545`, if checkpoint D lands.
  - Generic sync and revision tests are re-keyed, not deleted.
- **Docs:** about 40 to 60 lines are rewritten or removed across three guides and the skill.
- **Additions:** about 10 lines of test changes (the extended retired-key list) and the replacement guide sentences.
- **Performance:** one `uiPreferences.list()` RPC and up to 21 KV reads disappear from the plugin's start until the guard is set. After that, one KV read per start disappears. The effect is negligible, and no benchmark is needed.
- **Maintenance effect:** thread-list layout preferences then live only in `plugins/thread-list/shared/preferences.ts`. There is no host twin to keep in step, and the guides describe one interface.

**Execution steps**

0. **Gate G0, the owner decision. Do not edit code before it is resolved.** Ask the owner to approve this statement: "Installs that have not started the bundled Thread list plugin since 2026-09-21 may lose their old sidebar organization, sort and section order on upgrade. The seven `sidebar.*` layout keys leave `omnyo settings ui`, the SDK and the HTTP API." Also ask whether checkpoint D (the installation-default read path) is in scope; this card recommends yes.
   - If Alex declines, stop. Implement only the documentation fix from the incidental issue, and reword the seven descriptions in `packages/domain/src/ui-preferences.ts:134-168` to point at `omnyo thread-list prefs`.
   - If Alex wants public removals batched, hand this card to RF-041.
1. **Reconfirm the baseline.**
   - Run `git grep -n -E 'sidebar\.(organizationMode|threadGrouping\.environment|chronologicalSort|sortDirection|sectionOrder|manualSectionOrder|machineSectionOrder)' HEAD -- . ':!docs/2026-*'` from the repository root, and compare the hits with the list in Context.
   - Re-run `rg -n -E 'sidebar\.(organizationMode|sectionOrder|chronologicalSort)' $OMNYO_PLUGIN_CHECKOUT --no-ignore -g '!node_modules'`.
   - Re-plan if a new production reader of a host key appears: an app atom, a mobile reader, a CLI command, or a plugin in either repository that does more than skip a missing key. Re-plan too if a second writer of `ui_preference_defaults` appears.
2. **Checkpoint B, the plugin (`plugins/thread-list`).** This checkpoint is self-contained and changes no host contract.
   - In `server.ts`, delete `MIGRATION_KV_KEY` (line 26), `migrateFromUiPreferences` (141-193) and the call and log at 338-344. Drop imports that become unused; `getPreferenceDefault` may still be used elsewhere, so let `tsc` and `oxlint` decide.
   - In `shared/preferences.ts`, change `definePreference(schema, defaultValue, description, legacyKey)` to `definePreference(schema, defaultValue, description)`, returning `{ schema, defaultValue, description }`, and delete the 20 `legacyKey` argument lines.
   - In `server.test.ts`:
     - Delete the `migration from Omnyo's sidebar preferences` describe block (293-335).
     - Delete the `await migrateFromUiPreferences(api);` line at 121; the assertions after it still check the written value.
     - Remove `migrateFromUiPreferences` from the import at line 3.
     - Remove the `uiPreferences`/`uiPreferencesFail` options of `setup` (13-25) if nothing else uses them.
   - In `skills/thread-list/SKILL.md`, delete lines 32-33.
   - Verify with the plugin commands below.
3. **Checkpoint C, the host registry.**
   - In `packages/domain/src/ui-preferences.ts`, delete lines 8-25 (the three schemas and `SidebarOrganizationMode`), the seven `UI_PREFERENCE_KEYS` entries (92-98) and the seven `uiPreferenceDefinitions` entries (134-168). Keep `sidebar.hiddenGroups` and everything after it. The `satisfies Record<UiPreferenceKey, …>` clause keeps the two lists in step.
   - In `apps/server/test/public/public-ui-preferences.test.ts`, make these changes. Do not weaken any assertion.
     - Line 66: add the seven retired keys to the `retired` array of "ignores stored rows for retired sidebar provider preferences". It then proves that stored rows and default rows for them are ignored.
     - Re-key the revision, conflict, reset and broadcast cases at 117, 164, 417-446 and 552-590 to surviving keys of the same shape. Use `sidebar.footerOrder` or `sidebar.pluginPanelOrder` for list cases. For enum-or-string cases, use `sidebar.threadListProvider`; it accepts any non-empty string and maps `__builtin__`.
     - Re-key the invalid-value cases. At 605-610, use `modelPicker.footerFavorites` with the value `"by-color"`, which still expects 400. At 665-681, store `'"by-color"'` for `modelPicker.footerFavorites` and expect `{ revision: 4, value: true }`.
     - Leave 473-545 to checkpoint D.
   - In `apps/app/src/lib/ui-preferences/ui-preferences-sync.test.ts`, re-key `createHarness` (82-83) and every `sidebar.organizationMode`/`sidebar.sectionOrder` literal (82-590) to `sidebar.threadListProvider` and `sidebar.footerOrder`. These tests cover generic sync, pending-write and conflict behavior, and the assertions must keep their meaning. Check that no case depended on enum rejection, and keep it on a key that rejects the value if one did.
   - Leave `packages/db/test/data/ui-preferences.test.ts` as it is. The data layer takes `key: string`, so typechecks pass without re-keying. Leave `packages/db/test/sidebar-installation-defaults.test.ts` as it is too; it tests applied migration `0129`.
   - In `apps/demo-server/fixtures.mjs`, delete lines 175-181. In `apps/demo-server/test.mjs`, change line 157 to `body.preferences["sidebar.threadListProvider"].revision === 0`, and change the PUT path at 229 to `/api/v1/preferences/ui/sidebar.threadListProvider`. The read-only 501 assertion keeps its meaning.
   - Run `pnpm exec turbo run typecheck` to find any consumer missed here; the stories and `.ladle` fixtures iterate `UI_PREFERENCE_KEYS` and adapt by themselves.
4. **Checkpoint D, the installation-default read path. Do this only if Alex approved it at G0.**
   - In `apps/server/src/services/system/ui-preferences.ts`:
     - Delete `parseStoredJson` only if nothing else uses it; `toEntry` uses it, so keep it.
     - Delete `installationDefault` (29-40) and the `defaults` map (61-66).
     - Pass `getUiPreferenceDefault(key)` to `toEntry` at line 80.
     - In `resetUiPreference` (112-129), use `const value = getUiPreferenceDefault(key);`.
     - Remove the `getStoredUiPreferenceDefault` and `listStoredUiPreferenceDefaults` imports.
   - In `packages/db/src/data/ui-preferences.ts`, delete `listStoredUiPreferenceDefaults` and `getStoredUiPreferenceDefault` (28-43) and drop `uiPreferenceDefaults` and `eq` from the imports if they become unused. Remove both names from `packages/db/src/data/index.ts:189-190`.
   - Keep the `uiPreferenceDefaults` table in `packages/db/src/schema.ts:260`. Removing it would make the next `drizzle-kit generate` emit a DROP.
   - Delete the three installation-fallback tests at `apps/server/test/public/public-ui-preferences.test.ts:473-545`. Keep the retired-key test, which still inserts into `ui_preference_defaults` and proves those rows are ignored.
5. **Checkpoint E, the documentation.**
   - In `docs/configuration.md`:
     - Remove the six table rows at 1578-1583.
     - Replace 1621-1625 with one sentence: thread-list layout is owned by the Thread list plugin, defaults to chronological, and is changed with `omnyo thread-list prefs`.
     - Rewrite 1650-1660 to use `omnyo thread-list prefs set environmentGrouping true|false|auto` and Organize → Groups → By environment.
     - Change the CLI examples at 1673-1674 to surviving keys, for example `omnyo settings ui set sidebar.threadListProvider thread-list/thread-list` and `omnyo settings ui set sidebar.footerOrder '[…]'`.
     - Reword the registry introduction at 1565-1570 so that it no longer claims sidebar layout lives there.
   - Make the same edits in `plugins/omnyo-guide/skills/omnyo-cli/references/app-settings.md:41-46` and `:61-70`, and in `packages/templates/src/templates/omnyo-guide-customization.md:530-534` and `:552-560`. Point the `sortDirection` example at `omnyo thread-list prefs set sortDirection ascending`.
   - Read `$HOME/.agents/skills/marketing-copywriting/SKILL.md` before rewriting these guides, as the global instructions require for reader-facing prose.
6. **Final pass.**
   - Format the changed files (`pnpm exec oxfmt <files>`, then `pnpm exec oxlint --deny-warnings --format=agent`).
   - Run the verification below, and inspect the full diff for unrelated changes.
   - Re-run the step 1 `git grep`. The only remaining hits should be `packages/db/drizzle/0129_sidebar_installation_defaults.sql`, `packages/db/test/**` and, if checkpoint D was skipped, the installation-fallback tests.
   - Recount the removed lines with `git diff --numstat` against the same baseline.

**Verification and acceptance criteria**

All commands run from the repository root. The package names come from each `package.json` at the snapshot. The `test`, `typecheck` and `lint` scripts were confirmed to exist, but none was run here because the snapshot has no `node_modules`.

- Plugin: `pnpm --filter omnyo-plugin-thread-list test`, `pnpm --filter omnyo-plugin-thread-list typecheck` and `pnpm --filter omnyo-plugin-thread-list lint`. Expect "lists defaults on a fresh install and round-trips a valid write" and the other preference tests to pass unchanged.
- Domain and its consumers: `pnpm --filter @omnyo/domain typecheck`, `pnpm --filter @omnyo/server test -- public-ui-preferences` (the Vitest name filter is assumed to be passed through) and `pnpm --filter @omnyo/server typecheck`. Then run `pnpm --filter @omnyo/cli typecheck`, `pnpm --filter @omnyo/cli test`, `pnpm --filter @omnyo/app typecheck` and `pnpm --filter @omnyo/app test -- ui-preferences-sync boot-cache-owner` (the same filter assumption applies).
- Database, if checkpoint D lands: `pnpm --filter @omnyo/db typecheck` and `pnpm --filter @omnyo/db test`. `sidebar-installation-defaults.test.ts` must still pass unchanged.
- Guides: `pnpm --filter @omnyo/templates test` and `pnpm --filter omnyo-plugin-omnyo-guide test`.
- Cross-package typecheck: `pnpm exec turbo run typecheck`. This is the root `typecheck` script.
- Demo server: `cd apps/demo-server && node test.mjs`. The command comes from `apps/demo-server/README.md` step 3. It may need the built `public/` assets that the README describes, so build them first or label the check as not run.
- Formatting: `pnpm exec oxfmt --check <changed files>` (the root `format:check` script runs `oxfmt . --check`) and `pnpm exec oxlint --deny-warnings --format=agent`.

The change is accepted when all of these hold:

- **Contract:**
  - `GET /api/v1/preferences/ui` returns exactly the ten surviving keys.
  - `PUT /api/v1/preferences/ui/sidebar.organizationMode` returns 404 `ui_preference_not_found`.
  - A database that still holds `ui_preferences` rows for the seven keys, and a `ui_preference_defaults` row for `sidebar.organizationMode`, lists cleanly. The extended retired-key test proves this.
  - Revision conflicts, reset and the `ui-preferences-changed` broadcast still pass on the re-keyed tests.
- **Plugin:**
  - On a fresh KV, plugin start makes no `system.uiPreferences` call. The plugin's `setup()` mock exists to observe this if a test is wanted.
  - `listPreferences` returns `defaultPreferences()`.
  - Stored `preference:*` values are read exactly as before.
- **Structure:** `git grep -n -E 'migrateFromUiPreferences|legacyKey|MIGRATION_KV_KEY' -- plugins/thread-list` returns nothing. No production file names the seven host keys.
- **UI:** none is affected, because no app component reads these keys. Alex tests UI changes himself, so no screenshot round is required.

**Rollback and stop conditions**

- *Change boundary:* each checkpoint is one revertible commit: B for the plugin, C for the host registry and its tests and fixtures, D for the installation-default read path, and E for the docs. No migration is added and no stored row is deleted, so reverting C or D brings the old behavior back, including any stored values. A reverted B import would run again only on installs whose guard is unset.
- *Stop and re-plan if any of these happens:*
  - A production reader of a host key turns up, in this repository or in `$OMNYO_PLUGIN_CHECKOUT`, that does more than skip a missing key.
  - A second production writer of `ui_preference_defaults` exists, which would make checkpoint D unsafe.
  - Alex reports supported installs that still run pre-2026-09-21 builds, or have the Thread list plugin disabled, and must keep their layout.
  - Re-keying a generic sync test would require weakening an assertion; pick another key of the same shape instead.
  - A published external plugin is found that types against one of the seven keys.
- *Safer smaller alternative:* land only the documentation and description fix, and keep the import and the keys until RF-041's next-major batch.

On the older-CLI crash: if Alex considers mixed CLI and server versions supported, make the CLI's `ui list` loop skip missing entries in the same change. That is a one-line `if (!entry) continue;` at `apps/cli/src/commands/settings.ts:771`. It helps only CLIs built after the change, so tell Alex that older binaries still crash until they update.
