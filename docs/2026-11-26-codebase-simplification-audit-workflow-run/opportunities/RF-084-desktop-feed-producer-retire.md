# RF-084 — Retire the `desktop:version-feed` producer, the `desktop-version*.json` schema and its file-name helper

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The opportunity is real, but the sweep missed a second effect of the generator and overstated the test removal. Besides writing `desktop-version*.json`, the generator rewrites the macOS electron-updater metadata (`latest-mac.yml` or `nightly-mac.yml`) to add `minimumSystemVersion: 22.0.0`. electron-updater enforces that field. The supported release paths do not run the generator, so they do not publish that field today either, but the retirement must be a conscious decision about that OS-floor field as well as about the JSON feed. One test file also holds two unrelated schema tests that must stay.
- **Potential:** low. About 160 handwritten production lines and one published release format (the JSON version feed) disappear. No runtime state or coordination is involved.
- **Confidence:** high for the in-repository facts (Proven by inspection). The only open point lies outside the repository: whether any still-run workflow publishes the feed.
- **Readiness:** decision-needed. Alex must confirm two things: (1) the BB-era GitHub workflows `build-desktop.yml` and `publish-bb-app.yml` are no longer an Omnyo release path; (2) Omnyo does not need a `minimumSystemVersion` field in its electron-updater metadata from this script. A later floor change belongs in the supported producer.
- **Effort:** small, about 1 to 2 hours after the decision and after RF-034 lands.
- **Risk:** low. The only consumer is an external workflow that this repository does not contain. A revert restores everything.
- **Prerequisites:** RF-034 "Delete the superseded desktop JSON version-feed checker" must land first. At the snapshot, `apps/desktop/src/desktop-update-check.ts:3,5,97` still imports `omnyoDesktopVersionFeedSchema` and `OmnyoDesktopVersionFeed`, and so does `apps/desktop/test/desktop-update-check.test.ts:2`. RF-034 deletes both files and the fake feed in `apps/desktop/scripts/smoke-packaged-app.mjs`.
- **Related:**
  - RF-034 handles the consumer side. Its card states that it leaves the producer, the contract and the README publication tables to this card.
  - RF-112 "Define desktop release-channel identity once" owns `apps/desktop/scripts/desktop-release-channel.mjs`. After this card, `updateMetadataFileNames` in that module has no production consumer (see step 7).
  - RF-017 (CI-only scripts) has the same root cause: release machinery whose workflows live outside this repository.
  - RF-057 places the private desktop publication writer.
- **Why it earns a place:** after RF-034, this generator is the last owner of a whole published format. Its schema is exported from a shared contract package that the app, mobile and client-core all depend on. Today any change to desktop release metadata must still keep this unused format and its validator working.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the audit brief no longer existed, so every file was read with `git show e9e1b74c3:<path>` and `git grep ... e9e1b74c3` from `$OMNYO_CHECKOUT`. No file was modified.

*What the mechanism is.* Omnyo desktop updates run through electron-updater, which reads YAML metadata (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`, or the `nightly-*` and `public-beta-mac.yml` variants). Upstream bb also published a lightweight JSON "version feed" per platform (`desktop-version.json`, `desktop-version-linux.json`, `desktop-version-windows.json`), which a renderer toast polled to say "update available". RF-034 shows that the app no longer constructs that poller.

*Producer (Proven by inspection).*

- `apps/desktop/scripts/generate-version-feed.mts` has 118 lines and runs through `apps/desktop/package.json:19` `"desktop:version-feed": "tsx scripts/generate-version-feed.mts"`. It reads `package.json` and `release/<channel>-<suffix>.yml` and checks that the versions match (lines 78-82). It then builds an `OmnyoDesktopVersionFeed` (lines 84-97), validates it with `omnyoDesktopVersionFeedSchema` (line 99) and writes `release/desktop-version*.json` (lines 112-116).
- **Second effect, missed by the sweep:** on macOS, lines 101-110 rewrite the electron-updater YAML so that it includes `minimumSystemVersion: "22.0.0"`. That value is the Darwin kernel version of macOS 13. electron-updater 6.8.3 (`apps/desktop/package.json` `"electron-updater": "^6.8.3"`; the lockfile resolves 6.8.3) checks this field in `AppUpdater.checkIfUpdateSupported` (`node_modules/.pnpm/electron-updater@6.8.3/.../out/AppUpdater.js:364-379`). The check compares `os.release()` with the field and refuses the update when the OS is older. electron-builder 26.15.7 does not write the field into update YAML. It uses `mac.minimumSystemVersion` (`apps/desktop/electron-builder.config.json:52` `"13.0.0"`) only for `LSMinimumSystemVersion` in the app plist (`app-builder-lib/out/macPackager.js:392-394`) and for pkg requirements. This was inspected in the main checkout's installed `node_modules`, at the same versions as the snapshot lockfile.

*Contract (Proven by inspection).* `packages/desktop-contract/src/version-feed.ts` has 50 lines:

- `omnyoDesktopVersionFeedFileSchema`, lines 5-9, is private.
- `omnyoDesktopVersionFeedPlatformSchema` and `OmnyoDesktopVersionFeedPlatform`, lines 11-19, must stay. `packages/desktop-contract/src/info.ts:6,23` uses the enum for `omnyoDesktopInfoSchema.platform`.
- `omnyoDesktopVersionFeedSchema` and `OmnyoDesktopVersionFeed` are at lines 21-38.
- `OMNYO_DESKTOP_VERSION_FEED_FILE_NAMES` and `createOmnyoDesktopVersionFeedFileName` are at lines 40-50.
- `packages/desktop-contract/src/index.ts:7` re-exports the module.

The package is `"private": true` and is used only through workspace links (`apps/app`, `apps/desktop`, `apps/mobile`, `packages/client-core`). It is not part of the published SDK. `git grep -n "desktop-contract\|VersionFeed" HEAD` in `$OMNYO_PLUGIN_CHECKOUT` returned nothing.

*Consumers at the snapshot.* Command: `git grep -n -i -E "version-feed|versionFeed|VersionFeed|desktop-version" e9e1b74c3 -- . ':!*.lock'`. Results:

- The generator and its package script.
- `apps/desktop/src/desktop-update-check.ts` and its test, both removed by RF-034.
- The fake feed in `apps/desktop/scripts/smoke-packaged-app.mjs:61-83,174-184,368` and `apps/desktop/scripts/measure-packaged-startup.mjs:573`, also RF-034. These files build their own literal and do not import the schema.
- `packages/desktop-contract/src/{index,info,version-feed}.ts`.
- Two tests: `apps/desktop/test/desktop-version-feed.test.ts` (104 lines) and `packages/desktop-contract/test/version-feed.test.ts` (81 lines).
- README prose in `apps/desktop/README.md` at lines 182, 234, 288-296, 331-333, 403 and 410. RF-034 rewrites lines 182, 234 and 410.

No turbo task, vitest config, electron-builder config, Containerfile or `.gitignore` names the feed. That was checked with `git grep` over `turbo.json`, `apps/desktop/{vitest.config.ts,electron-builder.config.json,tsconfig*.json}` and `.gitignore`, with no hits.

*Who runs the generator (Proven by inspection, with the stated search scope).*

- The snapshot has no `.github` directory (`git ls-tree` of the root), so no workflow in this repository invokes `desktop:version-feed`.
- In the retired private checkout `$ARCHIVED_OMNYO_CHECKOUT` (HEAD `52b7fdf0`, 2026-11-23), `git grep -n -E "version-feed|desktop-version" HEAD` finds invocations only in `.github/workflows/build-desktop.yml:132,207,289` and `.github/workflows/publish-bb-app.yml:631,740,829`. Both workflows publish to and print `https://github.com/get-bb/bb/releases/download/...` URLs (build-desktop.yml:496-499; publish-bb-app.yml:1052-1054). `apps/desktop/README.md:301-304` says that upstream get-bb/bb runs `publish-bb-app.yml`.
- The supported Omnyo release paths are `pnpm private:ship` (retired private `AGENTS.md:37`) and `pnpm public:mac-release` (`apps/desktop/README.md:568-596`). Both write electron-updater YAML with a different producer, `desktop:private-update-feed`. Its entry is retired private `apps/desktop/package.json:19`, called from `scripts/private-release-build.mjs:893-908`, and the public step 5 is README line 591. `git grep minimumSystemVersion` over the retired private `apps/desktop/scripts` and `scripts` finds only `generate-version-feed.mts` and the smoke fixture. So the supported producers write neither `desktop-version*.json` nor `minimumSystemVersion`.
- **Observed fact:** nothing that ships Omnyo today runs this generator.
- **Remaining uncertainty:** GitHub-side workflow state is not visible from a checkout. Whether a fork or the retired private repository still runs those workflows on a schedule was not checked, because that would mean contacting GitHub.

*Tests that encode this contract.*

- `apps/desktop/test/desktop-version-feed.test.ts` bundles the generator with esbuild and runs it. It asserts the YAML rewrite (lines 67-72) and the feed contents (lines 74-88). At lines 90-98 it also asserts `electron-builder.config.json` `mac.minimumSystemVersion === "13.0.0"`, and that is the only test in the snapshot pinning the plist OS floor (`git grep -n minimumSystemVersion e9e1b74c3 -- apps/desktop/test`).
- `packages/desktop-contract/test/version-feed.test.ts` lines 10-35 test `omnyoDesktopThemeSchema` and `omnyoDesktopWindowStateSchema`. That coverage is unique and must stay. Only lines 37-81 test the feed schema.

*Counterevidence considered.*

- Installed bb-era clients may still poll `desktop-version*.json`. They poll upstream's get-bb/bb release URLs, which upstream controls. The supported Omnyo producers already publish no JSON feed, so deleting the script changes no Omnyo publication.
- Keeping the file identical to upstream bb would ease backports. Omnyo has already diverged in this area (RF-034).
- The OS-floor field is the one real requirement the generator served. It does not affect current users: `LSMinimumSystemVersion` 13.0 already keeps the app off macOS 12, so every installed Omnyo client meets the 22.0.0 floor. If Omnyo raises its macOS floor later, the supported producer `desktop:private-update-feed` is where the field must be added. This script is not.

*Maintenance cost today.* Any change to the update YAML shape, the release-channel config (`createDesktopReleaseConfig`, `updateMetadataFileNames`) or the desktop-contract package must keep an unused producer, a 12-field zod schema and a subprocess-plus-esbuild test green. The shared contract package also exports a format with no reader, and the README documents it as live.

**Proposed end state and preservation argument**

*What disappears:*

- `apps/desktop/scripts/generate-version-feed.mts`.
- The `desktop:version-feed` script.
- From `packages/desktop-contract`: `omnyoDesktopVersionFeedFileSchema`, `omnyoDesktopVersionFeedSchema`, `OmnyoDesktopVersionFeed`, `OMNYO_DESKTOP_VERSION_FEED_FILE_NAMES`, `createOmnyoDesktopVersionFeedFileName` and the `version-feed.ts` module with its index export.
- The feed tests.
- The README "Version feed" column and the feed-file lists.

*What remains:*

- The platform enum moves into `packages/desktop-contract/src/info.ts`, its only user. It is renamed so that the name no longer refers to a removed format: `omnyoDesktopPlatformSchema = z.enum(["macos", "linux", "windows"])` and `type OmnyoDesktopPlatform`. `git grep` found no existing symbol with either name. The values and order are unchanged, so `omnyoDesktopInfoSchema` parses exactly as before.
- The electron-builder plist floor assertion moves to `apps/desktop/test/electron-builder-config.test.ts`.
- electron-updater YAML stays the single published update format, written by electron-builder and the supported private producers.

*Preserved contracts:* `OmnyoDesktopInfo` and its IPC payload, the preload API, the electron-updater YAML that the supported release paths produce, `LSMinimumSystemVersion` in the app plist and every UI state. Nothing at runtime imports the removed symbols once RF-034 has landed.

*Intentional non-goals:*

- Do not add `minimumSystemVersion` to the private producer here. That is a separate release decision, noted under Rollback.
- Do not rewrite the README's broader BB-era release sections, which describe `build-desktop.yml` and `publish-bb-app.yml` (RF-017 territory). Edit only the feed-specific text.
- Do not touch `semver`, `yaml` or `tsx`. `yaml` stays because `test/private-update-cache.test.ts` and `test/private-update-config.test.ts` use it.

*Why this is the simplest option:* the generator has no in-repository invoker and no reader, and its only externally meaningful output is already absent from supported releases. Deleting it beats keeping a dormant copy.

**Expected gain and cost**

Projections, counted with `git show e9e1b74c3:<file> | wc -l` against the same baseline:

| Item | Removed | Added/moved | Net |
| --- | --- | --- | --- |
| `apps/desktop/scripts/generate-version-feed.mts` | 118 | 0 | -118 production |
| `packages/desktop-contract/src/version-feed.ts` | 50 | about 7 moved into `info.ts` (enum and type); the moved code is not counted as a gain | about -43 production |
| `packages/desktop-contract/src/index.ts:7` and blank line | 2 | 0 | -2 production |
| `apps/desktop/package.json:19` | 1 | 0 | -1 production |
| **Production total** | | | **about -160 handwritten lines** |
| `apps/desktop/test/desktop-version-feed.test.ts` | 104 | about 8 (floor assertion in `electron-builder-config.test.ts`) | about -96 test |
| `packages/desktop-contract/test/version-feed.test.ts:37-81` and one import name | about 46 | 0 | about -46 test |
| `apps/desktop/README.md` feed rows and sentences | about 10 | about 2 | about -8 docs |
| Optional step 7 (`updateMetadataFileNames`) | about 16 production plus 1 test | 0 | about -16 production |

The sweep estimated about 185 test lines. That is corrected to about 140, because lines 10-35 of the contract test stay.

*Mechanisms:* published update formats go from two (electron-updater YAML plus the JSON feed) to one. The desktop contract loses one exported schema family.

*Causal maintenance gain:* release-metadata and channel-config changes stop needing a second format and its subprocess test. The contract package no longer advertises a feed that nothing reads.

*Performance:* neutral. The script is not part of any build, test-mode or runtime path in this repository. The desktop test suite drops one esbuild bundle and one Node subprocess per case (three cases).

*Cost:* about 1 to 2 hours, plus the decision.

**Execution steps**

1. **Investigation gate (do this before any edit).**
   - Ask the owner to confirm both points: (a) `build-desktop.yml` and `publish-bb-app.yml` from the retired private repository are not a supported Omnyo release path, and no supported release publishes `desktop-version*.json`; (b) Omnyo does not need `minimumSystemVersion` written into electron-updater YAML by this script. If Alex wants that OS floor in update metadata, it belongs in `desktop:private-update-feed`, which is a separate change.
   - **Stop** if either answer is no.
   - Confirm RF-034 has landed: `rg -n "desktop-update-check|omnyoDesktopVersionFeedSchema|OmnyoDesktopVersionFeed\b|DESKTOP_VERSION_FEED_URL" apps packages plugins scripts tests` must return only `packages/desktop-contract/src/version-feed.ts`, `packages/desktop-contract/test/version-feed.test.ts` and `apps/desktop/scripts/generate-version-feed.mts`. If more hits appear, finish RF-034 first or re-plan.
2. **Reconfirm the baseline.**
   - In a writable worktree on current `main`, run `git diff --stat e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e HEAD -- apps/desktop packages/desktop-contract`.
   - Re-run `rg -n -i "version-feed|desktop-version|createOmnyoDesktopVersionFeedFileName|omnyoDesktopVersionFeedPlatform" .`, excluding `node_modules`.
   - Check whether a `.github/` directory, a release script or a new package script now invokes `desktop:version-feed`. If one does, stop and re-plan.
3. **Preserve the unique plist-floor assertion.** In `apps/desktop/test/electron-builder-config.test.ts`, inside `describe("electron-builder signing config", ...)` (line 390), add one test. It reads `electron-builder.config.json` as raw JSON with `readFile(resolve(desktopPackageRoot, "electron-builder.config.json"), "utf8")` and `JSON.parse`, as `readStaticConfig` does at lines 371-378. Do not go through `readStaticConfig`, because its `electronBuilderConfigSchema` may strip unknown `mac` keys. It then asserts `expect(config).toMatchObject({ mac: { minimumSystemVersion: "13.0.0" } })`. Run that test file once and confirm it passes before deleting anything.
4. **Checkpoint A: delete the producer.**
   - Delete `apps/desktop/scripts/generate-version-feed.mts` and `apps/desktop/test/desktop-version-feed.test.ts`.
   - Remove line 19, `"desktop:version-feed": ...`, from `apps/desktop/package.json`. No lockfile change is needed because no dependency is removed.
5. **Checkpoint B: shrink the contract.**
   - In `packages/desktop-contract/src/info.ts`, replace the import at line 6 with a local definition placed above `omnyoDesktopInfoSchema`:
     ```ts
     export const omnyoDesktopPlatformSchema = z.enum(["macos", "linux", "windows"]);
     export type OmnyoDesktopPlatform = z.infer<typeof omnyoDesktopPlatformSchema>;
     ```
     Use it at line 23 (`platform: omnyoDesktopPlatformSchema`).
   - Delete `packages/desktop-contract/src/version-feed.ts` and the `export * from "./version-feed.js";` line (index.ts:7) with its blank line.
   - Re-run `rg -n "omnyoDesktopVersionFeedPlatform|OmnyoDesktopVersionFeedPlatform" apps packages`. Any hit, for example new code written after the snapshot, moves to the new names.
   - In `packages/desktop-contract/test/version-feed.test.ts`, delete the `describe("desktop version feed schema", ...)` block (lines 37-81) and drop `omnyoDesktopVersionFeedSchema` from the import (line 4). Keep lines 10-35 unchanged. Optionally rename the file with `git mv` to `test/info.test.ts`, because it now tests only info schemas. That is a pure move.
6. **Checkpoint C: README (feed text only).** Read `$HOME/.agents/skills/marketing-copywriting/SKILL.md` once first. In `apps/desktop/README.md`:
   - Drop the "Version feed" column from the table at lines 288-292.
   - Change the sentence before the table (lines 285-286) so it names only the electron-updater metadata file per platform.
   - Delete only the first sentence of the paragraph at lines 294-295 ("macOS keeps the unsuffixed feed name because released macOS builds already request it."). Keep the signing sentences that follow.
   - Delete the "version feeds" bullet at lines 331-333.
   - At line 403, remove "the release job publishes only `desktop-version.json` and".
   - If RF-034 did not already rewrite lines 182, 234 and 410, apply its README step 8 first. Do not rewrite the surrounding BB-era workflow prose.
7. **Optional checkpoint D, to coordinate with RF-112.** After step 4, `updateMetadataFileNames` in `apps/desktop/scripts/desktop-release-channel.mjs:98-102,117-121` and `DesktopUpdateMetadataFileNames` in `desktop-release-channel.d.mts:5-9,20` have no production consumer. Only the fixture assertion `apps/desktop/test/desktop-update-provider.test.ts:43` remains. Verify with `rg -n "updateMetadataFileNames|DesktopUpdateMetadataFileNames" apps scripts packages`.
   - If RF-112 has not already restructured this module, delete the field, its type and the test line.
   - If RF-112 is in flight, leave this to RF-112 and record that in its card.
8. **Final pass.**
   - Run `rg -n -i "desktop-version|version-feed|VersionFeed" apps packages plugins scripts tests docs`. It should return nothing, or only historical audit documents.
   - Inspect the full diff for unrelated changes and recount the removed lines against the step-2 baseline.

**Verification and acceptance criteria**

Run every command from the repository root of the writable worktree. The script names come from the snapshot's `apps/desktop/package.json` (`typecheck`, `test`, `test:prepare`), `packages/desktop-contract/package.json` (`typecheck`, `test`) and the root `package.json` (`format:check`, `typecheck`, `test`). None was executed in this audit, because the snapshot has no `node_modules`.

- **Typecheck:** `pnpm --filter @omnyo/desktop-contract typecheck` and `pnpm --filter @omnyo/desktop typecheck` must pass. Because `@omnyo/desktop-contract` is a workspace source package, also run `pnpm --filter @omnyo/app typecheck` and `pnpm --filter @omnyo/client-core typecheck` (both declare a `typecheck` script: `apps/app/package.json:17`, `packages/client-core/package.json:27`), or `pnpm typecheck` from the root, to catch any consumer of the renamed enum.
- **Focused tests:**
  - `pnpm --filter @omnyo/desktop-contract test` must pass, with the theme and window-state cases still present.
  - `pnpm --filter @omnyo/desktop exec vitest run --config vitest.config.ts test/electron-builder-config.test.ts` must pass, including the new floor assertion. That command shape is unconfirmed: `apps/desktop/vitest.config.ts` uses `sharedWorkerProjects`, and the desktop test task depends on `test:prepare` (`install-electron`). If the direct call fails for environment reasons, use `pnpm exec turbo run test --filter=@omnyo/desktop`.
- **Lint and format:** run `pnpm exec oxfmt <changed files>`, then `pnpm exec oxlint --deny-warnings --format=agent <changed files>` (the root has `.oxlintrc.json` and `.oxfmtrc.json`), then `pnpm format:check`.
- **Behavior and contract:** `omnyoDesktopInfoSchema` accepts exactly `macos`, `linux` and `windows` for `platform`, as before. The contract test or a one-line `safeParse` check confirms it. No IPC, preload or renderer file changes.
- **Release-output check (no publication):** optionally, on a Mac with a prepared build, run `pnpm public:mac-release --plan`. It must still list its step 5 `desktop:private-update-feed` and no `desktop:version-feed`. This command exists only in the private release tooling, not in this snapshot's root `package.json`. Skip it if that tooling is unavailable.
- **Structural completion:** `rg -n "desktop:version-feed|generate-version-feed|omnyoDesktopVersionFeedSchema|createOmnyoDesktopVersionFeedFileName" .` (excluding `node_modules` and the audit docs) returns nothing. `packages/desktop-contract/src` has no `version-feed.ts`. The README has one update-metadata column.
- **UI and performance:** neither is affected, so no visual or benchmark check is needed.

**Rollback and stop conditions**

- **Reversible boundary:** one local commit touching `apps/desktop` (one script, one test, `package.json` and README), `packages/desktop-contract` (two sources, one test) and one added test case. No persisted data, migration or IPC change is involved. `git revert` restores everything.
- **Stop conditions:**
  - Alex says a supported workflow still publishes `desktop-version*.json`, or wants this script to keep stamping `minimumSystemVersion` into update YAML.
  - Step 1 or step 2 finds a new invoker or reader of the feed or of `createOmnyoDesktopVersionFeedFileName`.
  - RF-034 has not landed.
  - A typecheck finds an external use of `omnyoDesktopVersionFeedPlatformSchema` under its old name. Rename that use rather than keeping an alias, unless it is a published package.
- **Safer smaller alternative:** if the publication question stays open, apply only step 3 (the floor assertion) and leave the producer in place until it is answered. If Alex wants the macOS update OS-floor gate kept, do not keep this script for that alone. Add `minimumSystemVersion` to the supported `desktop:private-update-feed` producer as a separate release-tooling change, then retire this script.
