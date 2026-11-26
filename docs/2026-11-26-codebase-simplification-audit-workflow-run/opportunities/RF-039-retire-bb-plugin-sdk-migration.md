# RF-039 — Retire the BB-era SDK conversion inside `omnyo plugin migrate` (TypeScript import rewriter, vendored-declaration archive, tsconfig path-map removal and `bb` manifest import)

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** medium. About 530 to 590 handwritten production lines leave `packages/templates` and `apps/cli`, together with the only runtime use of the TypeScript compiler in `@omnyo/templates` and roughly 650 to 850 test lines. The plugin SDK then has one layout to plan and write instead of two.
- **Confidence:** medium. The code, its callers and the absence of legacy-layout plugins in both first-party plugin trees are Proven by inspection. Whether any third-party plugin written for the retired BB product still needs automated conversion cannot be established from the repository.
- **Readiness:** decision-needed. Alex must decide that BB-era plugins (those that depend on `@get-bb/plugin-sdk` or `@bb/plugin-sdk`, vendor `types/bb-plugin-sdk*.d.ts`, or map those names in `tsconfig.json`) no longer get an automated in-product conversion. This card keeps their runtime loading; it removes only the converter.
- **Effort:** about one day: half a day for the source edits, half a day to re-home the surviving test cases onto current-layout fixtures and update the guide and skill text.
- **Risk:** low to medium. The affected contract is the `omnyo plugin migrate` CLI for BB-era plugin sources. After the change such a plugin gets a clear refusal that explains the manual steps, instead of an automatic rewrite. No persisted data, wire format, SDK export or runtime loading path changes. Rollback is a revert of one commit.
- **Prerequisites:** the owner's decision (gate in step 1). No other RF must land first.
- **Related or overlapping opportunities:**
  - RF-012 retires the one-time BB-to-Omnyo source rename tooling in `scripts/`. Its card explicitly leaves this converter to RF-039. The tooling's `scripts/omnyo-guide-map.mjs:239` regex and the `packages/scripts/test/omnyo-guide-map.test.mjs:30,42` strings mention `omnyo plugin migrate`; they do not import anything from this card's files, so the two cards can land in either order.
  - RF-006 (identity adoption), RF-015 (mobile storage), RF-040 (browser storage) and RF-043 (attention adoption) are other BB-era retirements with no shared files.
  - RF-041 (scheduled SDK next-major removal batch) is a natural release in which to announce this retirement, but neither card depends on the other. The migration is not listed in `docs/api_to_audit.md` "Scheduled removals (next major)".
  - Out of scope and retained: the runtime BB manifest import in `packages/domain/src/plugin-manifest.ts` (`pluginManifestV1ImportSchema` at line 217, `importLegacyPluginManifestV1` at line 249), `apps/server/src/services/plugins/legacy-npm-plugin-engines-v1.ts`, and the build-time refusal of `@get-bb/plugin-sdk` runtime imports in `packages/plugin-build/src/build-plugin-host.ts:607`. The RF-006 card also classifies the domain `importLegacy*V1` helpers as ongoing compatibility.
- **Why it deserves its place:** it is a self-contained second code path, built on a TypeScript program and type checker, that every change to plugin manifest, tsconfig or SDK layout handling must keep consistent. It serves only inputs that no longer exist in either first-party plugin tree. It ranks below the large dead-machinery deletions because it is a supported upgrade path that needs an owner decision, and because the command itself must stay for its current-layout job.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main on 2026-11-26). The snapshot worktree named in the audit brief no longer existed, so every file was read with `git show <commit>:<path>` and searched with `git grep <commit>` from `$OMNYO_CHECKOUT`. No tests, builds or linters were run, because the snapshot has no `node_modules`. Line counts come from `git show <commit>:<path> | wc -l`.

*What the subsystem is.* Omnyo is a fork of BB. Plugins written for BB depended on `@get-bb/plugin-sdk` (or the older `@bb/plugin-sdk`), sometimes vendored its declarations as `types/bb-plugin-sdk.d.ts` and `types/bb-plugin-sdk-app.d.ts`, sometimes mapped those names through `compilerOptions.paths`, and described themselves under a `bb` key with `engines.bb` and `engines.bbPluginSdk`. Current plugins pin the private `@omnyo/plugin-sdk` archive in `devDependencies` and describe themselves under `omnyo`. `omnyo plugin migrate` converts the first form to the second and, for a plugin that is already current, raises its `engines.omnyoPluginSdk` floor and normalizes the SDK pin.

*Files and sizes (Proven by inspection).*

| File | Lines | Role |
| --- | --- | --- |
| `packages/templates/src/legacy-plugin-sdk-layout-v1.ts` | 206 | Legacy constants, `rewriteLegacySdkSourceV1` (lines 34-155, built on `ts.createProgram` and `program.getTypeChecker()`), `importLegacySdkManifestV1` (lines 157-206) |
| `packages/templates/src/plugin-scaffold.ts` | 1,988 | Layout detection, migration planner and writer, `setPluginSdkPin`, scaffolding |
| `apps/cli/src/commands/plugin.ts` | 2,494 | `omnyo plugin migrate`, `types`, `build` and `dev` commands |

*Legacy-only code in `packages/templates/src/plugin-scaffold.ts` (Proven by inspection).*

- Lines 30-35: import of the four legacy symbols. Lines 87-89: `SDK_PATH_MAP_PREFIXES` and `VENDORED_DECLARATIONS` aliases. Lines 91-101: `PLUGIN_SOURCE_EXTENSIONS`, `UNSCANNED_DIRECTORIES`, `MAX_SOURCE_SCAN_DEPTH`, used only by the source scan.
- `PluginPackageLayoutMigration` (line 109) fields `removedPathMaps`, `removedIncludes`, `archivedFiles`, `removedTypesDir`, `rewrittenImports`, and the `RewrittenSdkImportFile` interface (line 123).
- `migratePluginToPackageLayout` (line 129): the `typesPlan`, `tsconfigPlan` and `importPlan` steps (lines 145-151), their terms in `changed` and the result (lines 162-173), the `tsconfig`, `declarations` and `imports` parts of `inputDigest` (lines 179-187), and all of the apply phase after the manifest write (lines 201-266: archive copy into `vendor/legacy-plugin-sdk-v1/`, `rmdir` of `types/`, tsconfig rewrite, import rewrite).
- `rewriteSdkImportsInFile` (line 271), `planSdkImportRewrites` (line 287), `assertInsidePlugin` (line 340).
- `TsconfigPlan` (line 654) and `planTsconfig` (line 666). `planTsconfig` only removes BB path maps and `types` includes. `isSdkPathMapKey` (line 660) is also used by detection and stays.
- `planLegacyDeclarationArchiveV1` (line 745) and `assertWritableTypesDir` (line 885). The second is called only from the migration (lines 204, 240, 751).
- In `planManifest` (line 420), which `setPluginSdkPin` (line 377) also uses: the `importLegacySdkManifestV1` call (line 456) and the legacy names in the dependency-deletion loop (line 468).
- After the removal, the `node:fs/promises` imports `copyFile`, `readdir`, `realpath` and `rmdir`, the `node:fs` `constants` import, and the `node:path` imports `isAbsolute` and `relative` have no other user (checked with `grep -n` over the extracted file; their only uses are at lines 218, 241, 300, 346-352, 787 and 897-903).

*Shared, current-layout code that must stay (Proven by inspection).* `planManifest` with `raiseFloor: true` writes the SDK pin, moves `@omnyo/plugin-sdk` from `dependencies` to `devDependencies` and raises `engines.omnyoPluginSdk` (lines 486-497). `installPrivateSdkArtifact` and `privateSdkArtifactCopyNeeded` (from `private-sdk-artifact.ts`) copy the private archive. `setPluginSdkPin` (the `omnyo plugin types` engine) uses the same `planManifest` with `raiseFloor: false`. So the engines-floor raise is the only effect that `migrate` has and `types` lacks for a current-layout plugin. The tests "raises an older engines floor but never lowers a newer one" (`packages/templates/test/plugin-migrate-layout.test.ts:142`), "moves an exact pin out of dependencies and collapses a duplicate" (line 344), "adds the pin and floor to a plugin with no vendored artifacts left" (line 371) and the CLI test "pins a package-layout plugin that never got the devDependency" (`apps/cli/src/__tests__/command-output/plugin-migrate.test.ts:227`) encode that current contract.

*CLI side in `apps/cli/src/commands/plugin.ts` (Proven by inspection).*

- `LEGACY_PLUGIN_SDK_LAYOUT_MESSAGE` (line 212) and `checkPluginSdkLayout` (line 216). `omnyo plugin build` (line 1918) and `omnyo plugin dev` (line 1950) warn and continue; `omnyo plugin types` (lines 1808-1811) refuses a vendored layout with that message.
- `printMigrationPlan` (line 224) prints pin, dependency move, engines floor, then the five legacy-only lists (lines 243-263). `samePlan` (line 266) compares the bound plans.
- The `migrate` command (lines 1842-1904): plan, confirm, re-plan, apply, then legacy-only messages at lines 1892-1899.
- The CLI loads `commands/plugin.js` lazily through `apps/cli/src/command-groups.ts:128`, and `scripts/build-utils.mjs` bundles dependencies (`bundle: true`; only native packages are external). So the TypeScript compiler is bundled into the chunk that every `omnyo plugin ...` command loads (Proven by inspection of the build configuration; the chunk size was not measured).

*Dependency.* `packages/templates/package.json` lists `"typescript": "npm:@typescript/typescript6@^6.0.2"` under `dependencies`. `git grep` for `from "typescript"`, `require("typescript")` and `import("typescript")` under `packages/templates` finds only `legacy-plugin-sdk-layout-v1.ts:1`. The package's `typecheck` script (`tsc --noEmit`) still needs the compiler, so the end state moves it to `devDependencies`, matching every other workspace package; it does not drop it.

*Consumer searches.*

- `git grep -n -E 'legacy-plugin-sdk-layout-v1|LEGACY_SDK_PACKAGE_NAMES_V1|LEGACY_VENDORED_DECLARATIONS_V1|rewriteLegacySdkSourceV1|importLegacySdkManifestV1|migratePluginToPackageLayout|resolvePluginSdkLayout|checkPluginSdkLayout|LEGACY_PLUGIN_SDK_LAYOUT_MESSAGE' <commit> -- . ':!*.md'`: the only production consumers are `plugin-scaffold.ts` and `apps/cli/src/commands/plugin.ts`. `@omnyo/templates` is `"private": true`; its `./plugin-scaffold` export is consumed by `apps/cli` and by tests in `apps/cli` and `apps/server` (`plugin-install.test.ts` uses only `resolvePrivateSdkArtifact` and `scaffoldPlugin`). It is not part of the public SDK or the plugin SDK.
- `git grep -n -E '"plugin",\s*"migrate"|plugin.?migrate|pluginMigrate' <commit> -- apps packages plugins scripts ':!*.md'`: no programmatic invocation from the server, app, desktop or scripts; only CLI messages and RF-012's rename tooling tests.
- `git grep -n -E 'plugin migrate|legacy-plugin-sdk-v1|vendored SDK|bb-plugin-sdk|@get-bb/plugin-sdk|@bb/plugin-sdk' <commit> -- .`: every other hit is documentation (below), RF-012 rename tooling, the server fixture `apps/server/test/fixtures/plugins/bb-plugin-sdk-0.4.8-scaffold/`, or `plugin-build` tests. No first-party plugin under `plugins/` uses a legacy SDK name, vendored declarations or a BB path map.
- Private plugins: `rg -l -g '*.{json,ts,tsx,mjs,js}' -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/docs/**' -e '@get-bb/plugin-sdk' -e '@bb/plugin-sdk' -e 'bb-plugin-sdk' .` in `$OMNYO_PLUGIN_CHECKOUT` returned no files (exit 1), and `find` found no `bb-plugin-sdk*.d.ts` and no `legacy-plugin-sdk-v1` directory. The only hits without the `dist` exclusion are git-ignored October build outputs (for example `quiet-notifications/dist/server.js`, ignored by `quiet-notifications/.gitignore:2`), not sources.
- The plugin registry under `packages/plugin-registry` has no legacy SDK names (same `git grep`).

*Documentation that describes the converter.* `packages/templates/src/templates/omnyo-guide-plugins.md:418-423` (command list) and `:950-957` (the "finite legacy layout importer" paragraph); `plugins/omnyo-guide/skills/omnyo-cli/references/plugins.md:234-241`; `plugins/omnyo-guide/skills/omnyo-cli/references/command-index.md:359` (command name only, which stays); `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/distribution.md:15-18`; `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/testing.md:12-13` and `:300-301`. `apps/cli/src/__tests__/plugin-guide-docs.test.ts` requires the guide chapter to mention every `omnyo plugin` subcommand and flag, so the guide must keep naming `migrate` and `--yes`.

*Counterevidence: BB-era plugins are still a supported runtime input.* The domain manifest parser still imports `bb` metadata and `engines.bb`/`engines.bbPluginSdk` (`packages/domain/src/plugin-manifest.ts:217` and `:249`), and `apps/server/test/services/plugins/plugin-service.test.ts:786` "keeps a persisted 0.4.8 scaffold plugin running after an SDK upgrade" proves that a plugin depending on `@get-bb/plugin-sdk` 0.4.8 keeps running. The converter is therefore the documented companion path for plugins that the runtime still supports, not an orphan. No repository document records a support window for it (`git grep -i` for BB-era support wording over `docs`, `README.md` and `AGENTS.md` found none). This is why the card is decision-needed and why its end state keeps a visible refusal rather than letting `types` half-convert such a plugin.

*Maintenance cost today.* Any change to how plugins declare or pin the SDK, how `tsconfig.json` is treated, or how the manifest is planned must be checked against two layouts, a source scanner with depth limits and symlink rules, a declaration archive with collision rules, and a TypeScript-program-based rewriter whose rename table (`legacyExportNamesV1`) mirrors the BB-era export names. Its 841 + 249 + 113 + 33 test lines in `packages/templates/test` and most of the 482-line CLI test run with every templates and CLI test run.

**Proposed end state and preservation argument**

What disappears:

- `rewriteLegacySdkSourceV1`, `canonicalSdkModuleV1`, `legacyExportNamesV1` and `importLegacySdkManifestV1`, with the `typescript` import.
- In `plugin-scaffold.ts`: `planLegacyDeclarationArchiveV1`, `assertWritableTypesDir`, `planTsconfig`, `TsconfigPlan`, `planSdkImportRewrites`, `rewriteSdkImportsInFile`, `assertInsidePlugin`, the scan constants, the legacy apply phase of `migratePluginToPackageLayout`, the five legacy result fields and `RewrittenSdkImportFile`, and the legacy branches in `planManifest`.
- In the CLI: the five legacy loops in `printMigrationPlan` and the archive and `types/` messages in the `migrate` action.
- `typescript` moves from `dependencies` to `devDependencies` of `@omnyo/templates`.

What remains, with its owner:

- `resolvePluginSdkLayout` stays the single detector, unchanged in behavior, so a BB-era plugin is still recognized. It keeps `LEGACY_SDK_PACKAGE_NAMES_V1`, `LEGACY_VENDORED_DECLARATIONS_V1`, `isSdkPathMapKey`, `tsconfigMapsSdk`, `readJsonFile` and `pathExists`. Move the two constants into `plugin-scaffold.ts` (about 9 lines) and delete `legacy-plugin-sdk-layout-v1.ts`.
- `migratePluginToPackageLayout` keeps its name and export and becomes: refuse when `resolvePluginSdkLayout(rootDir).kind === "vendored"`, otherwise plan the manifest with `raiseFloor: true`, check whether the private artifact copy is needed, compute `inputDigest` over `package.json` bytes, and on apply call `installPrivateSdkArtifact` and write the manifest. Its result type becomes `{ changed, pin, movedFromDependencies, enginesFloor, inputDigest, artifactCopyRequired }`.
- `omnyo plugin migrate` keeps its name, `--yes`, plan, confirmation, re-plan comparison (`samePlan`) and apply sequence for current-layout plugins. `omnyo plugin types`, `build` and `dev` keep their current refusal and warnings.
- The refusal message (`LEGACY_PLUGIN_SDK_LAYOUT_MESSAGE` and the new error thrown inside `migratePluginToPackageLayout`) states the manual conversion: replace `@get-bb/plugin-sdk` and `@bb/plugin-sdk` with `@omnyo/plugin-sdk`, rename the seven BB-era exports (the current `legacyExportNamesV1` table: `BbPluginApi`→`PluginApi`, `PluginBbSdk`→`PluginSdk`, `useBbContext`→`experimental_useAppContext`, `useBbNavigate`→`experimental_useAppNavigate`, `BbContext`→`experimental_AppContext`, `BbNavigate`→`experimental_AppNavigate`, `PluginBrowserBbSdk`→`experimental_PluginBrowserSdk`), remove the BB `compilerOptions.paths` entries and `types/bb-plugin-sdk*.d.ts`, then run `omnyo plugin migrate`. The same text goes into the guide paragraph, so the knowledge survives as documentation rather than code. Wording of user-facing copy should follow the repository's product copy conventions.

Preservation argument:

- Current-layout plugins: every current effect of `migrate` (pin, dependency move, engines floor, artifact copy, dry-run plan, confirmation, plan-drift refusal) is computed by the same `planManifest` and artifact helpers as today. The four current-layout tests named above must pass unchanged.
- `omnyo plugin types`: it already refuses vendored layouts before `setPluginSdkPin` runs, so removing the legacy branches from `planManifest` changes nothing for any plugin `types` accepts, with one narrow exception. A hand-edited plugin that has the current `@omnyo/plugin-sdk` pin but still carries a `bb` manifest key would no longer have that key rewritten to `omnyo` by `types` or `migrate`. The runtime still accepts such a manifest through `importLegacyPluginManifestV1`, so the plugin keeps loading. Record this as an intentional behavior change in the commit message.
- Runtime: no change to manifest parsing, plugin loading, artifact validation or the `@get-bb/plugin-sdk` build refusal. The `bb-plugin-sdk-0.4.8-scaffold` server test keeps passing.
- Data: the command writes only plugin source files on the author's machine. No database, persisted format or migration is involved. Previously written `vendor/legacy-plugin-sdk-v1/` archives are user files and are left alone.
- UI: none. CLI output loses only the five legacy plan lines and the archive message.

Reachability proof for the deleted code: the only entry point is `migratePluginToPackageLayout`, reached only from `omnyo plugin migrate` (`apps/cli/src/commands/plugin.ts:1854`, `:1876`, `:1887`). The legacy branches inside it run only for inputs that `resolvePluginSdkLayout` classifies as vendored, or for `bb` manifest keys and BB source imports. None exist in `plugins/` or in `$OMNYO_PLUGIN_CHECKOUT` sources. Remaining uncertainty: third-party BB-era plugin sources outside these trees, which only the owner's support decision can settle.

Non-goals: do not remove the runtime BB manifest import, `legacy-npm-plugin-engines-v1.ts`, the server fixture, or the `plugin-build` refusal; do not delete the `migrate` command or fold the engines-floor raise into `types` (a separate product decision); do not change `setPluginSdkPin`'s shim-pin policy; do not touch RF-012's rename tooling.

Simpler alternatives considered: (a) keep everything and record a support window, which is the right answer if Alex wants BB-era authors to keep automated conversion; (b) delete the `migrate` command entirely, which would save about 80 more CLI lines and about 90 more templates lines but would remove the engines-floor raise for current plugins and change a documented command, so it needs its own decision; (c) remove the detector as well, which would let `types` mix `@get-bb/plugin-sdk` and `@omnyo/plugin-sdk` pins silently and violates the visible-failure rule.

**Expected gain and cost**

Projected counts, from the line ranges cited above. They are estimates; recount after the edit.

| Scope | Removed | Added | Net |
| --- | --- | --- | --- |
| `legacy-plugin-sdk-layout-v1.ts` (whole file; constants move) | ~206 | ~9 (constants in `plugin-scaffold.ts`) | ~-197 |
| `plugin-scaffold.ts` legacy helpers, apply phase, fields and imports | ~340-370 | ~8-15 (vendored refusal and message) | ~-330 to -360 |
| `apps/cli/src/commands/plugin.ts` | ~25-35 | ~0-5 (message wording) | ~-25 to -32 |
| **Handwritten production total** | **~570-610** | **~17-30** | **~-530 to -590** |
| Tests | ~750-900 | ~80-120 (re-homed current-layout fixtures) | ~-650 to -800 |
| Docs (guide chapter and four skill references) | ~25 | ~15 (manual conversion note) | ~-10 |
| Dependencies | `typescript` leaves `dependencies` of `@omnyo/templates` (moves to `devDependencies`) | | |

Test detail: delete `packages/templates/test/plugin-migrate-types-dir.test.ts` (113) and `packages/templates/test/legacy-sdk-source-v1.test.ts` (33). In `plugin-migrate-layout.test.ts` (841), remove the legacy cases at lines 110, 192, 231, 269, 295, 314, 396, 469, 486, 513, 558 (reshape to a current-layout dry run), 576 and 604, about 450 lines; keep lines 142, 344, 371 and the whole `setPluginSdkPin` block from line 629. In `plugin-private-migration.test.ts` (249), whose `beforeEach` builds a BB-era plugin, remove the five legacy cases and re-home "types repins current SDK bytes idempotently" (line 179) and "check reports a missing owned copy" (line 194) onto a current-layout fixture. In `apps/cli/src/__tests__/command-output/plugin-migrate.test.ts` (482), remove or replace the legacy cases at lines 138, 167 and 205 and move the "private plugin SDK digest checks" (line 277) off the legacy manifest; keep the "legacy vendored SDK layout" refusal and warning block (line 348) and the `types` block (line 423).

Mechanisms before and after: two SDK layouts planned and written becomes one layout planned and written, plus a read-only detector; one TypeScript-program-based source rewriter becomes none; one declaration archive format (`vendor/legacy-plugin-sdk-v1/`) stops being produced; `planManifest` stops carrying two package identities.

Maintenance example: today, changing the shape of `PluginPackageLayoutMigration`, the manifest planner or the tsconfig handling requires reasoning about the scanner, the archive collision rules, the `types/` removal race (`plugin-migrate-types-dir.test.ts`) and the rename table. Afterwards the migration is the manifest planner plus the artifact copy, the same helpers `types` uses.

Performance: Hypothesis. The CLI chunk loaded by every `omnyo plugin ...` command should shrink by roughly the size of the bundled TypeScript 6 compiler, and parse time for that chunk should fall. Not measured; measure as described below before claiming it.

Cost: one day of work; the loss of automated conversion for BB-era sources, mitigated by the refusal text and guide note.

**Execution steps**

1. **Decision gate (required before any edit).** Ask the owner: "BB-era plugins still load in Omnyo. Should `omnyo plugin migrate` keep converting their sources automatically, or may it refuse them with manual instructions?" Proceed only on an explicit retire answer. If Alex wants a support window, stop and record it in the guide paragraph instead. Also confirm the default sub-choice: keep the `migrate` command for current-layout plugins (this card) rather than deleting it.
2. **Reconfirm the snapshot.** From the canonical checkout, run `git log --oneline e9e1b74c3..HEAD -- packages/templates apps/cli/src/commands/plugin.ts plugins/omnyo-guide/skills packages/domain/src/plugin-manifest.ts`. Re-plan if any of these changed the migration, `planManifest`, `setPluginSdkPin` or the detector. Re-run the consumer `git grep` commands from Context at `HEAD`, and the `rg` search in `$OMNYO_PLUGIN_CHECKOUT`. Stop if a source plugin now uses a legacy SDK name.
3. **Baseline.** In a worktree with dependencies installed, run the verification commands below once and record results, so pre-existing failures are separated from regressions.
4. **Checkpoint A: templates source.**
   1. Move `LEGACY_SDK_PACKAGE_NAMES_V1` and `LEGACY_VENDORED_DECLARATIONS_V1` into `packages/templates/src/plugin-scaffold.ts` as non-exported constants and delete `packages/templates/src/legacy-plugin-sdk-layout-v1.ts`. Replace the aliases at lines 87-89 by direct use.
   2. Delete `PLUGIN_SOURCE_EXTENSIONS`, `UNSCANNED_DIRECTORIES`, `MAX_SOURCE_SCAN_DEPTH`, `RewrittenSdkImportFile`, `rewriteSdkImportsInFile`, `planSdkImportRewrites`, `assertInsidePlugin`, `TsconfigPlan`, `planTsconfig`, `planLegacyDeclarationArchiveV1` and `assertWritableTypesDir`. Keep `isSdkPathMapKey`, `tsconfigMapsSdk`, `readJsonFile`, `pathExists`, `statNoFollow`, `reserialize`, `writeJsonFileAtomically` and `writeFileAtomically`.
   3. Rewrite `migratePluginToPackageLayout`:
      ```ts
      export interface PluginPackageLayoutMigration {
        changed: boolean;
        pin: { from: string | null; to: string } | null;
        movedFromDependencies: boolean;
        enginesFloor: { from: string | null; to: string } | null;
        inputDigest: string;
        artifactCopyRequired: boolean;
      }
      // body: if ((await resolvePluginSdkLayout(rootDir)).kind === "vendored")
      //   throw new Error(LEGACY_LAYOUT_REFUSAL);   // manual steps, see end state
      // manifestPlan = planManifest(rootDir, sdkPin, version, { raiseFloor: true, shimmedTypePins: "none" })
      // artifactCopyRequired = privateSdkArtifactCopyNeeded(rootDir, sdkArtifact)
      // changed = artifactCopyRequired || manifestPlan.text !== null
      // inputDigest = sha256(JSON.stringify({ manifest: <package.json bytes> }))
      // dryRun → return; else installPrivateSdkArtifact, then write package.json if text !== null
      ```
      Keep the order of `installPrivateSdkArtifact` before the manifest write, as today. Export the refusal text (or a small `legacyPluginSdkLayoutMessage` constant) from `plugin-scaffold.ts` so the CLI uses the same copy for `types`, `build` and `dev`.
   4. In `planManifest`, drop the `importLegacySdkManifestV1` call (line 456) and delete only `@omnyo/plugin-sdk` in the loop at line 468. Leave `readSdkPinFrom`'s legacy names in place, because `resolvePluginSdkLayout` uses it for the pin of a vendored plugin and its conflict check still guards that read.
   5. Remove the now-unused imports `copyFile`, `readdir`, `realpath`, `rmdir`, `constants`, `isAbsolute` and `relative`, after confirming with `rg` that nothing else in the file uses them.
   6. In `packages/templates/package.json`, move `typescript` from `dependencies` to `devDependencies` and update `pnpm-lock.yaml` through the repository's normal `pnpm install` (a lockfile change; do not hand-edit).
   Verify: `pnpm --filter @omnyo/templates typecheck`.
5. **Checkpoint B: CLI.** In `apps/cli/src/commands/plugin.ts`, delete the loops for `removedPathMaps`, `removedIncludes`, `archivedFiles`, `removedTypesDir` and `rewrittenImports` from `printMigrationPlan`; delete the archive message and the `removedTypesDir` warning at lines 1892-1899, keeping "Run `pnpm install`…"; change the success line to a current-layout message; update the command description at line 1845 to describe the current-layout job and the refusal. Point `LEGACY_PLUGIN_SDK_LAYOUT_MESSAGE` at the shared refusal text so the warning no longer promises an automatic migration. Verify: `pnpm --filter @omnyo/cli typecheck`.
6. **Checkpoint C: tests.** Apply the test plan from "Expected gain and cost". Do not weaken the kept current-layout assertions. The "legacy vendored SDK layout" block in `apps/cli/src/__tests__/command-output/plugin-migrate.test.ts:348` asserts the exact old message ("Please run `omnyo plugin migrate` to update to the latest SDK types."). Update only that expected string to the new refusal text, which is the one intentional copy change; keep every other assertion in the block (exit code, `types` refusing for both `--check` values, declaration bytes unchanged, `build` and `dev` warning and continuing). Add one templates test and one CLI test that a vendored plugin (fixture with `devDependencies["@get-bb/plugin-sdk"]` and `types/bb-plugin-sdk.d.ts`) makes `migratePluginToPackageLayout` and `omnyo plugin migrate --yes` throw the refusal, with `package.json`, `types/` and sources byte-identical afterwards.
7. **Checkpoint D: documentation.** Update `packages/templates/src/templates/omnyo-guide-plugins.md:418-423` and `:950-957`, `plugins/omnyo-guide/skills/omnyo-cli/references/plugins.md:234-241`, `plugins/omnyo-guide/skills/omnyo-plugin-authoring/references/distribution.md:15-18` and `testing.md:12-13` and `:300-301` to describe `migrate` as the current-layout pin and engines-floor normalizer and to give the manual BB-era conversion steps once (in the guide). Keep the words `omnyo plugin migrate` and `--yes` in the guide so `plugin-guide-docs.test.ts` still passes. Follow the repository's rules for reader-facing prose.
8. **Structural check and recount.** `git grep -n -E 'rewriteLegacySdkSourceV1|importLegacySdkManifestV1|legacy-plugin-sdk-layout-v1|planLegacyDeclarationArchiveV1|planSdkImportRewrites|legacy-plugin-sdk-v1' -- packages apps plugins` must return only the guide's mention of the old archive directory, if kept, and no code. `git grep -n 'from "typescript"' -- packages/templates/src` must be empty. Recount with `wc -l` against the snapshot numbers and report the actual reduction.

**Verification and acceptance criteria**

Run from the repository root after `pnpm install`. The script names below exist in the snapshot's `package.json` files (`packages/templates/package.json`: `typecheck`, `test`; `apps/cli/package.json`: `typecheck`, `test`; root: `format:check`, `typecheck`). The `pnpm --filter <pkg> <script> -- <path>` file filters are standard pnpm and Vitest usage, not repository-specific scripts.

- `pnpm --filter @omnyo/templates typecheck` and `pnpm --filter @omnyo/cli typecheck`: pass.
- `pnpm --filter @omnyo/templates test`: passes, including the kept cases at `plugin-migrate-layout.test.ts` "raises an older engines floor but never lowers a newer one", "moves an exact pin out of dependencies and collapses a duplicate", "adds the pin and floor to a plugin with no vendored artifacts left", the `setPluginSdkPin` block, `plugin-scaffold.test.ts` "resolvePluginSdkLayout" (all three cases still report `vendored` for legacy fixtures), and the new refusal test.
- `pnpm --filter @omnyo/cli test -- src/__tests__/command-output/plugin-migrate.test.ts src/__tests__/plugin-guide-docs.test.ts src/__tests__/omnyo-cli-skill-coverage.test.ts`: passes. The kept "legacy vendored SDK layout" block must still show `types` refusing and `build`/`dev` warning; "pins a package-layout plugin that never got the devDependency" and the `types` block must pass unchanged.
- `pnpm --filter @omnyo/server test -- test/services/plugins/plugin-service.test.ts`: the "keeps a persisted 0.4.8 scaffold plugin running after an SDK upgrade" case still passes, which shows runtime support is unchanged.
- Formatting and lint: `pnpm exec oxfmt --check <changed files>` and `pnpm exec oxlint --deny-warnings <changed files>` from the root (root `devDependencies` include `oxfmt` and `oxlint`; `.oxlintrc.json` and `.oxfmtrc.json` exist).
- Manual CLI check (optional, since tests cover it): in a scratch copy of `apps/server/test/fixtures/plugins/bb-plugin-sdk-0.4.8-scaffold`, `omnyo plugin migrate --yes` exits non-zero with the manual-steps message and leaves every file byte-identical (`shasum` before and after). In a scratch plugin made by `omnyo plugin new`, after lowering `engines.omnyoPluginSdk`, `omnyo plugin migrate --yes` raises it as before.
- Performance claim (only if the card's report states one): build the CLI before and after with `pnpm run cli:prepare`, then compare the size of the `apps/cli/dist` chunk that contains `commands/plugin` and the wall time of `node apps/cli/dist/index.js plugin --help` over repeated runs on the same machine. Report the measured numbers or say the effect is unmeasured.
- Structural completion: the greps in step 8 are clean; `legacy-plugin-sdk-layout-v1.ts` and the two deleted test files are gone; `PluginPackageLayoutMigration` has no legacy fields; `typescript` is no longer a runtime dependency of `@omnyo/templates`.

**Rollback and stop conditions**

Rollback: the change is one commit (or one per checkpoint) touching `packages/templates`, `apps/cli`, the guide template, four skill reference files and the lockfile. Reverting it restores the converter exactly. Nothing persisted changes, and archives already written to `vendor/legacy-plugin-sdk-v1/` by earlier runs stay valid user files either way.

Stop conditions:

- Alex does not explicitly approve retiring automated BB-era conversion, or asks for a support window.
- A first-party or Alex-owned plugin source (in `plugins/` or `$OMNYO_PLUGIN_CHECKOUT`) still uses `@get-bb/plugin-sdk`, `@bb/plugin-sdk`, `types/bb-plugin-sdk*.d.ts` or a BB path map: convert that plugin first with the current command, or keep this card on hold.
- A kept current-layout test needs its expected output changed: that means the refactor altered current behavior; fix the code, not the assertion.
- Another tool, script or agent skill turns out to drive `omnyo plugin migrate` on BB-era input (for example a marketplace upgrade flow added after the snapshot): stop and re-plan.
- Removing `typescript` from `dependencies` breaks a consumer that relied on it transitively at runtime: keep it in `dependencies` and record why; the source simplification still stands.

Safer smaller alternative if the decision is "keep": leave the code, add a dated support-window sentence to the guide paragraph at `omnyo-guide-plugins.md:950`, and revisit at the next SDK major (RF-041).
