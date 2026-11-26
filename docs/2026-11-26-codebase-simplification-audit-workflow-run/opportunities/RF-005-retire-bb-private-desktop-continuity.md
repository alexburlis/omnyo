# RF-005 — Retire the BB Private to Omnyo Private desktop profile adoption, protected-store (keychain) transfer and browser-origin adoption

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** high. About 8,000 to 8,900 handwritten production lines across desktop, server, app and one contract package, plus two native executables and a Node addon compiled with clang and code-signed on every private Mac build.
- **Confidence:** medium-high that the mechanism is real, one-time and inert on the machines that can be inspected; medium that no install anywhere still needs it (one machine cannot be inspected, see the gate).
- **Readiness:** decision-needed. Alex must confirm that no desktop install or browser profile still needs the BB-to-Omnyo transfer, and must agree to change the private release tooling, which lives outside this repository.
- **Effort:** large, 2 to 4 days: desktop removal (1 to 1.5 days), server and app removal (1 day), private-ship tooling change in the `omnyo-private` store (0.5 day), and one packaged private-channel Mac smoke.
- **Risk:** medium. Deletion does not touch persisted data, but a mistake in the retained profile check can stop the private desktop app from starting. The blast radius is the private `latest` and `nightly` desktop channels and the private Mac release command; the public channel and public self-hosted installs never run this code.
- **Prerequisites:** (1) the investigation gate below; (2) the private release tooling change in step 3.4; (3) for the app part, RF-008 lands first or in the same change, because RF-008's restore engine imports two of the app modules this card deletes.
- **Related and overlapping:** RF-008 (never-wired native origin first-entry: `apps/desktop/src/desktop-origin-first-entry-v1.ts`, `desktop-final-runtime-v1.ts`, `apps/app/src/lib/origin-native-session-restore-v1.ts`; its lines are counted there, not here; `packages/desktop-contract/src/internal/origin-adoption-v1.ts` is counted here and goes when both land). RF-006 (stopped-state identity adoption, the same BB-to-Omnyo family; independent code). RF-012, RF-015, RF-039, RF-040 (other BB-era migrations). RF-112 (release-channel identity in `apps/desktop/scripts/desktop-release-channel.mjs`; edit conflicts only). RF-057 (private desktop publication-retention writer).
- **Why this rank:** this is the largest single body of dead-or-finished migration machinery in the desktop shell. Every private desktop start, window load and Mac build pays for it, and its strict origin and keychain literals force coordinated edits across five packages whenever the private origin, Electron version or profile layout changes.

**Context and evidence**

Snapshot: commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 26 November 2026). The snapshot worktree named in the audit brief was no longer on disk, so the files were read with `git show`, `git grep` and a `git archive` extract of the snapshot into disposable scratch. No tests ran: the snapshot has no `node_modules`.

*What the mechanism does (Proven by inspection).* The private desktop app used to be named "BB Private", with its profile at `~/Library/Application Support/BB Private`, a macOS keychain item "BB Private Safe Storage", and a server origin of `$LEGACY_ORIGIN`. When it was renamed "Omnyo Private", three one-time migrations were built:

1. **Profile adoption.** A stopped "BB Private" profile is copied into "Omnyo Private". A journal and marker record the result, and a fence file stops the old profile from starting. Owners: `apps/desktop/src/desktop-profile-adoption-v1.ts` (`prepareDesktopProfileAdoptionV1`, `acceptDesktopProfileAdoptionV1`, `rollbackDesktopProfileAdoptionV1`, `readAdoptedDesktopProfileV1Sync`:1093, `assertDesktopProfileSourceNotFencedV1`:1433, `desktopProfileStorageNameV1`:1476), `desktop-profile-catalog-v2.mjs`, `desktop-profile-continuity-v2.ts` and `desktop-profile-continuity-entry-v2.ts`. The hard-coded legacy names are at `desktop-profile-adoption-v1.ts`:67-71 (`legacy`) and `desktop-profile-v1.ts`:35-40 (`legacyProfileNamesV1`); the production source must be `/Applications/BB Private.app` or `/Applications/BB Private VPS.app` (`preSealInputSchemaV2`, `desktop-profile-adoption-v1.ts`:223-252).
2. **Protected-store (keychain) transfer.** Signed native helpers move the Electron safe-storage key from "BB Private Safe Storage" to "Omnyo Private Safe Storage": `desktop-protected-store-closed-v2.ts`, `desktop-protected-store-closed-v2.m` (keychain service name at :209), `desktop-keychain-query-guard-v1.m/.h`, and `desktop-keychain-ui-fence-v1.c`, which is compiled to a `.node` addon. They are compiled and signed by `apps/desktop/scripts/prepare-protected-store-consumers.mjs` (`compileDesktopProtectedStoreConsumersV1`:272 runs `/usr/bin/clang`; `signDesktopProtectedStoreConsumersV1`:352 runs `/usr/bin/codesign`).
3. **Browser-origin adoption.** Windows that were saved on `$LEGACY_HOST` are walked through a ticketed page (`/origin-adoption-v1.html`), which copies browser storage to the new origin and rewrites saved server URLs. On the desktop side: `main.ts`:4181-4283 (`onNavigation`, `resolveInitialUrl` in `createDesktopWindowFactory`) and `server-target.ts`:74-89 (`admittedOriginSchema`) and :175-249 (`adoptOriginV1`, `originAdoptionHeld`/`assertMutable`:143-150). On the server side: `apps/server/src/services/maintenance/origin-adoption-v1.ts` (377 lines; `fromOrigin: z.literal("$LEGACY_ORIGIN")`, `toOrigin: z.literal("https://app.example.invalid")`), `apps/server/src/server.ts`:28, 388-529 (`originBundleRootV1`, `originBundleManifestV1`, `registerOriginAdoptionStaticRoutesV1`), :858-872 (host-guard bypass), :1397-1404 (`createServerMaintenance` option and route registration), :1476-1500 (origin-guard bypass), `apps/server/src/browser-request-guard.ts`:238-259 (`originAdoptionRequestUrlV1`, hard-coded host list), `apps/server/src/routes/server-maintenance.ts` (the `origin-adoption-v1/prepare` and `/check` routes), `apps/server/src/services/maintenance/server-maintenance.ts`:1, 64, 181-188, and `apps/server/scripts/build-origin-adoption-v1.mjs`, run by the `build` script in `apps/server/package.json`. On the app side: `apps/app/src/origin-adoption-v1.ts` (701 lines), `apps/app/src/lib/origin-storage-transfer-v1.ts`, `origin-window-state-v1.ts`, `origin-database-inventory-v1.ts`, `origin-native-completion-v1.ts`, `apps/app/origin-adoption-v1.html`, `apps/app/vite.origin-adoption-v1.config.ts`, and the `originAdoption` input in `apps/app/vite.config.ts`:41. Contracts: `packages/desktop-contract/src/internal/origin-adoption-v1.ts`, exported as `./internal/origin-adoption-v1`, and `packages/server-archive/src/origin-adoption-metadata-v1.ts` (`createOriginAdoptionMetadataV1`, re-exported from `packages/server-archive/src/index.ts`:8-10).

*Wiring that runs today (Proven by inspection).*
- `apps/desktop/scripts/desktop-release-channel.mjs`:126-146 `desktopBuildSelection` sets `privateContinuity: channel !== "public-beta"`, and `resolveDesktopReleaseChannel` defaults to `latest`. Every default build, including `pnpm exec turbo run dev --filter=@omnyo/desktop` from `apps/desktop/README.md`:13, therefore takes the private path.
- `apps/desktop/scripts/build.mjs`:111-149 bundles `desktop-profile-adoption-v1.cjs` and `desktop-profile-continuity-entry-v2.cjs` and, on darwin, compiles the protected-store consumers. Lines 218-228 copy `scripts/private-electron-trust-probe.cjs`.
- `apps/desktop/src/startup.ts`:8-64 holds two reserved startup modes: `--omnyo-profile-continuity*`, which loads `desktop-profile-continuity-entry-v2.cjs`, and `--omnyo-electron-trust-probe`, which loads `private-electron-trust-probe.cjs`. A public-beta build refuses both, plus `--omnyo-profile-adoption`.
- `apps/desktop/src/main.ts`:22-33 holds the imports. `runDesktopApp` at :3362-3400 calls `prepareDesktopProfilePathV1` and `desktopProfileStorageNameV1`, and :3515-3526 calls `initializeDesktopProfileStorageV1`. On every private start, `prepareDesktopProfilePathV1` reads the fence and marker. On every `did-finish-load`, the `onNavigation` hook in `apps/desktop/src/desktop-window-factory.ts`:119-123 and 292-298 calls `desktopProfileOriginWindowV1Sync`, which reads the marker again. Those two hooks (`resolveInitialUrl` and `onNavigation` in `DesktopWindowFactoryArgs`) have no other caller. Search: `rg -n "onNavigation|resolveInitialUrl" apps/desktop/src apps/desktop/test` over the extract.
- `apps/desktop/scripts/run-electron-builder.mjs`:1 imports the consumer signer. :245-252 filters `asarUnpack` for public beta. :350-383 parses `--protected-store-build-job` and `--protected-store-build-job-sha256`. :408-422 refuses the job off-Mac. :440-503 signs the consumers on every private darwin build and throws "Replacement native profile consumers require the existing signing owner" when signing is disabled.
- `apps/desktop/electron-builder.config.json`:11-17 `asarUnpack` lists `dist/desktop-profile-adoption-v1.cjs`, `dist/desktop-protected-store-*` and `dist/desktop-keychain-ui-fence-v1.node`. `apps/desktop/package.json`:5 sets `"desktopProfileAdoptionProtocol": 2`.

*Consumer search.* `git grep -l -e profile-adoption -e ProfileAdoption -e profile-continuity -e protected-store -e omnyo-profile-continuity -e desktopProfileAdoptionProtocol -e keychain-ui-fence e9e1b74c3 -- .` finds no reference outside `apps/desktop` (src, test, scripts, `package.json`, `electron-builder.config.json`). `git grep -l -e origin-adoption -e originAdoption -e OriginAdoption e9e1b74c3 -- .` finds only the 33 files listed above: nothing in `apps/mobile`, `apps/cli`, `packages/sdk`, `packages/server-contract` or `plugins`. Both `@omnyo/desktop-contract` and `@omnyo/server-archive` are `"private": true`, so no external plugin or SDK consumer exists. Neither search proves that private tooling outside the repository does not call these modules; that case was checked separately, next.

*External consumers: private release tooling (Proven by inspection; counterevidence).* Private releases are still produced from the `alexburlis/omnyo-private` Git store at `$ARCHIVED_OMNYO_CHECKOUT`. The most recent is the `1.0.179-ios-96--private-ship` worktree from 25 November 2026, whose `apps/desktop/package.json` still declares `desktopProfileAdoptionProtocol: 2`. In that store:
- `scripts/private-ship-native.mjs` `prepareProtectedStoreBuildJobV1` (about line 255) runs for **every** `latest`-channel macOS native release. It throws "Native protected-store package metadata differs" unless `apps/desktop/package.json` has `desktopProfileAdoptionProtocol === 2`. `scripts/private-release-build.mjs` (about 520-545) then passes `--protected-store-build-job` to `desktop:build`.
- `scripts/private-mac-profile-adoption-v2.cjs` and `scripts/private-ship-native-bootstrap.cjs` drive the stopped-profile cutover and call `prepareDesktopProfileAdmissionV2`, `installDesktopProtectedStoreSignedJobV2`, `prepareDesktopProfileSelectionV2` and `inspectDesktopProfileAdoptionCheckpointV2`.
- **The Electron trust probe is not part of the migration.** `scripts/private-electron-trust.mjs` (`--omnyo-electron-trust-probe`, line 430) is a packaged-Electron TLS trust gate used by `private-release-build.mjs`, `private-native-builder.mjs` and `private-ship-native.mjs`. The sweep reports proposed deleting this startup mode and the probe copy; that would break the private release gate, so this card keeps both. The probe source `scripts/private-electron-trust-probe.cjs` exists only in the private store, not in this snapshot (`git ls-tree -r --name-only e9e1b74c3 | grep trust-probe` finds nothing).

*Is the migration finished? (Reproduced, read-only inspection on the owner's MacBook Pro, 26 November 2026.)*
- `~/Library/Application Support/Omnyo Private/product-profile-v1.json` has `kind: "fresh"`. The profile was never adopted, so `readAdoptedDesktopProfileV1Sync` returns false for it.
- No `BB Private*` profile directory and no `.omnyo-profile-adoption-*` fence file exist under `~/Library/Application Support`.
- `Omnyo Private/server-target.json` has no `omnyoOriginAdoptionV1` key.
- `$HOME/.agents/docs/machines.md`:18-24 records that the MacBook Air (`host_demo`) and the 5080 are gone. a connected MacBook joined after the BB era and was not inspected (Hypothesis: it never had a BB Private profile).
- The iPhone moved by a fresh start: `omnyo-private` commit `68cca64070` (11 November 2026) removed the iPhone identity handoff "now that Omnyo replaced BB Private" and left desktop origin adoption unchanged.
- Counterevidence: `omnyo-private` `docs/execplans/2026-11-03-omnyo-migration.md`:100 "Complete guarded identity cutover/publication and affected installed journeys" is still unchecked, and :94 ties the Air's "final native profile entry" to a deferred origin. The retired `AGENTS.md`:48 says the private origin `$OMNYO_COORDINATOR_URL` "remains only for the desktop update feeds and the installed desktop and phone apps, and is retired once they move".

*Public-source state (Proven by inspection).* The publication scrub replaced the real target origin with `https://app.example.invalid` in `desktop-profile-adoption-v1.ts`:107, `server-target.ts`:79, `apps/server/src/services/maintenance/origin-adoption-v1.ts`:20 and `browser-request-guard.ts`:250-253. In public builds the origin path therefore cannot match a real origin, and public users never have a BB profile. For the public support scope the whole mechanism is dead. Its only possible live scope is the private channel, which is built from the private store.

*Maintenance cost today.* Changing the private origin, the Electron version, the profile directory layout or the keychain naming means editing strict literals in four packages, the native sources' signing identifiers, the adoption journals' schemas and the out-of-repo controller. Every private Mac build needs clang and a signing identity even for local packaging.

**Proposed end state and preservation argument**

*What disappears.*
- Desktop: profile adoption, continuity and the protected-store transfer; the native keychain helpers and their build, sign and unpack steps; the `--omnyo-profile-continuity*` startup mode; origin-window admission in `main.ts`; `ServerTargetStore.adoptOriginV1` and its hold; the `resolveInitialUrl` and `onNavigation` factory hooks; `desktopProfileAdoptionProtocol`.
- Server: the ticket protocol, the static bundle, both middleware bypasses, `originAdoptionRequestUrlV1`, both maintenance routes and the build step.
- App: the adoption page and its modules.
- Contracts: the `./internal/origin-adoption-v1` export and the metadata store.

*What remains.*
- `apps/desktop/src/desktop-profile-v1.ts` `prepareDesktopProfilePathV1` stays the single profile owner and keeps the `product-profile-v1.json` identity marker. It must keep two behaviors:
  - **Accept an existing adopted marker.** Treat a marker with `kind: "adopted"` and a matching `applicationName` as owned, without reading its job directory. Without this, any previously adopted profile would fail `currentProfileSchema` (it requires `kind: "fresh"`) and the app would refuse to start. The gate expects no such profile, but keeping the acceptance costs about 10 lines and makes the deletion safe even if one exists. This applies only when the adopted marker's journal `nativeOwner.storageName` equals the application name; see the gate.
  - **Keep the refusal to start next to a legacy profile.** When the target is not marked and a legacy `BB Private`/`BB Private Nightly`/`bb-dev` folder exists, refuse to start, with copy that no longer promises a "verified native identity adoption" that no longer exists. Proposed copy: "An earlier BB Private profile was found. Move it aside to start Omnyo; its files were preserved." This keeps the current no-silent-data-mixing behavior. Alex may instead choose to drop the refusal (decision 2 in the gate).
- `--omnyo-electron-trust-probe`, the probe copy in `build.mjs`, the `private-electron-trust-probe.cjs` entry in `excludedArtifacts`, and the public-beta refusal of the trust-probe flag all stay. Rename `selection.privateContinuity` to `selection.privateTrustProbe` so the flag names what remains.
- `app.setName(applicationName)` replaces the `profileStorageName` indirection. For a fresh profile, `desktopProfileStorageNameV1` already returns `applicationName`, so behavior is unchanged.
- `persistedServerTargetSchema` is `.passthrough()` (`server-target.ts`:65-72). An existing `omnyoOriginAdoptionV1` field in `server-target.json` is preserved untouched. No migration is needed.
- `packages/server-archive/src/server-owned-paths.ts`:20 keeps `"origin-adoption-v1"` in `SERVER_OWNED_TOP_LEVEL_DIRECTORIES`, so archives of older data directories that contain that folder still classify it as server-owned. This is a persisted-format non-goal.
- Server maintenance holds (`desktop-update`, `migration`) and the maintenance status contract stay; private-ship `assertProfileCutoverV2` and other features read them.

*Preservation.* The public channel and public self-hosted installs run none of this code today (the scrubbed literals and `privateContinuity` false for `public-beta`), so their behavior is unchanged. On a fresh private profile, the only runtime differences are fewer synchronous file reads at start and on each window load, and no `adoptOriginV1` attempt. UI is unchanged except the legacy-profile refusal copy, which goes through `docs/product-ui-and-copy.md` review. The middleware bypasses only widen what the host and origin guards admit, so removing them can only make the guards stricter, and only for requests carrying a `$LEGACY_HOST` or scrubbed host.

*Non-goals.* RF-006 identity adoption, RF-008 native first entry, the mobile `bb.*` storage migration (RF-015), any change to private update feeds, and deleting any user data, keychain item or BB-era folder on any machine.

*Remaining uncertainty.* a connected MacBook was not inspected, and the private store's own branches may carry later adoption work. Both are covered by the gate.

**Expected gain and cost**

All counts are `wc -l` over the snapshot extract (projections where marked).

| Scope | Removed (handwritten production) | Basis |
|---|---|---|
| Desktop modules deleted | 5,065 | adoption 1,495; continuity 751; continuity entry 187; catalog 181 + `.d.mts` 29; protected-store TS 290 and `.m` 526; query guard `.m` 181 + `.h` 42; UI fence `.c` 80; `prepare-protected-store-consumers.mjs` 1,181 + `.d.mts` 100; `desktop-profile-storage-v1.ts` 22 |
| Desktop wiring (projected) | about 330-420 | `main.ts` about 125 (imports, storage name, storage init, `onNavigation`, `resolveInitialUrl`); `server-target.ts` about 100; `run-electron-builder.mjs` about 110; `build.mjs` about 40; `desktop-window-factory.ts` about 20; `startup.ts` about 10; release-channel, builder config and package.json about 15 |
| `desktop-profile-v1.ts` (projected) | about 60-70 net (193 to about 125) | drop the adoption imports and re-exports, the fence assertion and the adopted-journal read; add an adopted-marker acceptance of about 10 lines |
| `packages/desktop-contract` | 202 | `src/internal/origin-adoption-v1.ts`, shared with RF-008 (count once) |
| Server | about 700 | `origin-adoption-v1.ts` 377; build script 85; `server.ts` about 150; routes about 70; guard 22; maintenance about 10 |
| `packages/server-archive` | 187 | `origin-adoption-metadata-v1.ts` and its 3 export lines |
| App | about 2,010 | `origin-adoption-v1.ts` 701; `origin-storage-transfer-v1.ts` 421; `origin-window-state-v1.ts` 588; `origin-database-inventory-v1.ts` 189; `origin-native-completion-v1.ts` 79; HTML 12; vite config 18; 1 input line. The storage-transfer and window-state modules can go only when RF-008 removes their other importer, `origin-native-session-restore-v1.ts` |
| **Total** | **about 8,500-8,700** | about 10 lines added |

Not counted: `apps/app/src/lib/prompt-draft-recovery-v1.ts`, which the sweep listed. It is live composer recovery imported by `usePromptDraftStorage.ts`, `composer-submission-journal.ts` and `pending-chat-creations.ts`; only its `originRecoveryMutationsV1` may become unused after RF-008. The trust probe is also excluded, because it is kept.

Tests and fixtures, reported separately:
- Desktop tests: 2,477 lines across `desktop-profile-adoption-native`, `-adoption-v1`, `-continuity-v2`, `-standalone-v2`, `-storage-v1`, `desktop-protected-store-closed-v2` and `native-fixture-metadata.d.ts`. In addition, `desktop-profile-v1.test.ts` (186 lines) is rewritten rather than deleted, and the continuity cases in `startup.test.ts` and the adoption cases in `server-target-persistence.test.ts` (:315, :351) are removed.
- Desktop fixtures: 1,292 lines across 9 files in `apps/desktop/test/fixtures/`.
- Server tests: 718 lines (`origin-adoption-v1`, `-route-v1`, `-assets-v1`).
- App tests: 769 lines (database-inventory 63, storage-transfer 343, native-completion 363).

*Mechanisms before and after.*
- Before: two signed native executables and one Node addon, compiled per private Mac build; two reserved startup modes (one is kept); four persisted job formats (journal, marker kind `adopted`, fence, origin-window admission); strict origin literals in five schemas; two server control routes; two middleware bypasses; a separate app bundle and a server build step.
- After: one profile marker reader and the trust-probe mode.

*Maintenance example.* Today, changing the private origin means editing `desktop-profile-adoption-v1.ts`, `server-target.ts`, `origin-adoption-v1.ts` (server), `browser-request-guard.ts`, `desktop-contract` and the private controller in lockstep. After the change, no source holds the BB-era origin. A local private Mac build also stops needing clang and a signing identity, because `run-electron-builder.mjs` no longer throws when signing is disabled.

*Performance (Hypothesis until measured).* A private-channel cold start loses the synchronous fence, marker and journal reads in `prepareDesktopProfilePathV1`, and every window load loses one marker read. The build loses two clang invocations and the codesign steps. A public-channel build changes only by the removed vite build step in the server build. Measure with `apps/desktop/scripts/measure-packaged-startup.mjs`; the command is not confirmed to run without its packaged prerequisites.

**Execution steps**

1. **Investigation gate (must pass before any edit).**
   1. Ask the owner to confirm two decisions. (a) No desktop install or browser profile still needs the BB-to-Omnyo transfer, including a connected MacBook and any tester outside `machines.md`. (b) Keep or drop the refusal to start next to a legacy `BB Private` folder; the recommendation is to keep it with new copy.
   2. On every private-channel Mac that Alex names, read only the names and kinds, never the contents of credentials:
      - list `~/Library/Application Support` for `BB Private*`, `bb-dev` and `.omnyo-profile-adoption-*`;
      - read `kind`/`applicationName` from `Omnyo Private*/product-profile-v1.json`;
      - check whether `server-target.json` has an `omnyoOriginAdoptionV1` key.

      If any marker has `kind: "adopted"`, read that marker's `jobDir`, then `desktop-profile-adoption-v1.json` `input.version` and `input.nativeOwner.storageName`. **Stop** if `storageName` differs from the application name: that profile's Electron safe storage depends on the legacy keychain name, and deleting `desktopProfileStorageNameV1` would strand its cookies and encrypted credentials.
   3. In the `omnyo-private` store, confirm which repository future private Mac releases build from. Confirm that Alex authorizes changing `scripts/private-ship-native.mjs` (`prepareProtectedStoreBuildJobV1`, `assertProfileCutoverV2` callers and the profile-cutover routes), `scripts/private-release-build.mjs` (the `protectedStoreBuildJobV1` flags), `scripts/private-ship-native-bootstrap.cjs` and `scripts/private-mac-profile-adoption-v2.cjs`. Run `git -C $ARCHIVED_OMNYO_CHECKOUT grep -n "desktopProfileAdoptionProtocol\|protected-store-build-job\|private-mac-profile-adoption" HEAD` on the release branch Alex names.
   4. Recheck the anchors in this card against the target commit. Re-plan if new callers of any listed export appear, or if RF-008 has changed the app modules.
2. **Baseline.** On a Mac with dependencies installed, run the desktop, server and app typecheck and test commands listed in the next section, and record the results. Package a private `latest` build with `pnpm exec turbo run package --filter=@omnyo/desktop`; it needs the trust-probe file from the private store. Record start-to-first-window time with a fresh profile.
3. **Desktop checkpoint (one commit).**
   1. `apps/desktop/src/desktop-profile-v1.ts`:
      - delete the imports and re-exports from `./desktop-profile-adoption-v1.js` and the call to `assertDesktopProfileSourceNotFencedV1`;
      - replace `readAdoptedDesktopProfileV1Sync(target, applicationName)` with a local `isOwnedAdoptedMarker(path, applicationName)` that parses `{version: 1, kind: "adopted", applicationName}`, using `.passthrough()` or an explicit `jobDir`/`bindingSha256` string, and applies the same ownership checks as `prepareFreshProfile`;
      - keep `legacyProfileNamesV1` and the legacy-folder refusal (or drop it, per decision 1(b)), and update its message.
   2. `apps/desktop/src/main.ts`:
      - remove the imports at :22-29 and `initializeDesktopProfileStorageV1`;
      - in `runDesktopApp`, replace `profileStorageName` with `applicationName` (`app.setName(applicationName)`) and delete the `initializeDesktopProfileStorageV1` call at :3515-3526;
      - delete `onNavigation` and `resolveInitialUrl` from the `createDesktopWindowFactory` call at :4181-4283.
   3. `apps/desktop/src/desktop-window-factory.ts`: delete the optional `resolveInitialUrl` and `onNavigation` members (:115-123), the `did-finish-load` listener (:292-298), and the `resolveInitialUrl` branch (:332-338; use `createArgs.initialUrl`).
   4. `apps/desktop/src/server-target.ts`: delete `admittedOriginSchema`, `adoptOriginV1` (interface :45 and implementation :175-249), `originAdoptionHeld` and `assertMutable` with its two call sites (:272, :302). Keep `persistedServerTargetSchema` `.passthrough()` and `persistedMetadata` so unknown fields survive.
   5. `apps/desktop/src/startup.ts`: delete the `--omnyo-profile-continuity` branch and its public-beta refusal entries. Keep the `--omnyo-electron-trust-probe` branch and its refusal.
   6. `apps/desktop/scripts/build.mjs`: delete the import and the two continuity `build()` entries and `compileDesktopProtectedStoreConsumersV1`. Gate the trust-probe copy on `selection.privateTrustProbe`.
   7. `apps/desktop/scripts/desktop-release-channel.mjs` and `.d.mts`: rename `privateContinuity` to `privateTrustProbe`, and reduce `excludedArtifacts` to `private-electron-trust-probe.cjs`.
   8. `apps/desktop/scripts/run-electron-builder.mjs`:
      - delete the import (:1);
      - delete the `internalFlags` parsing at :350-389, replacing it with a refusal of any `--protected-store-*` argument that reports a clear "retired" error;
      - delete the public-beta and Mac-surface job checks (:404-422) and the consumer-signing block (:440-503);
      - drop the two `asarUnpack` filters at :250-251.
   9. `apps/desktop/electron-builder.config.json`: drop the three `asarUnpack` entries. `apps/desktop/package.json`: drop `desktopProfileAdoptionProtocol`.
   10. Delete these files: `desktop-profile-adoption-v1.ts`, `desktop-profile-continuity-v2.ts`, `desktop-profile-continuity-entry-v2.ts`, `desktop-profile-catalog-v2.mjs`/`.d.mts`, `desktop-protected-store-closed-v2.ts`/`.m`, `desktop-keychain-query-guard-v1.m`/`.h`, `desktop-keychain-ui-fence-v1.c`, `desktop-profile-storage-v1.ts`, and `scripts/prepare-protected-store-consumers.mjs`/`.d.mts`. Delete their tests and the 9 fixtures named under "Expected gain and cost". Rewrite `desktop-profile-v1.test.ts` to cover fresh, adopted-marker, foreign-marker, legacy-folder and explicit-path cases. Remove the continuity cases from `startup.test.ts` and the adoption cases from `server-target-persistence.test.ts`, keeping its URL-migration and opaque-field cases.
   11. Check that `@omnyo/server-archive/mac-state-acl-v1` and `@omnyo/config/file-lock` still have other importers before removing any package dependency. Remove only dependencies that become unused, such as `@omnyo/desktop-contract` if RF-008 has also landed.
   12. Checkpoint: desktop typecheck and test pass; a packaged private `latest` build starts on a fresh profile and on a copy of the current `Omnyo Private` profile.
4. **Private release tooling (in the `omnyo-private` store, with the owner's authority).** Remove `prepareProtectedStoreBuildJobV1` and the `protectedStoreBuildJobV1` plumbing, the stopped-profile cutover routes, `private-mac-profile-adoption-v2.cjs` and its bootstrap staging, and the tests that pin `desktopProfileAdoptionProtocol`. Keep `private-electron-trust.mjs`. Land this before or together with step 3: otherwise the next private Mac release fails with "Native protected-store package metadata differs", and the builder rejects `--protected-store-build-job` once step 3.8 lands.
5. **Server checkpoint.**
   - Delete `apps/server/src/services/maintenance/origin-adoption-v1.ts` and `apps/server/scripts/build-origin-adoption-v1.mjs`.
   - Remove `&& node scripts/build-origin-adoption-v1.mjs` from the `build` script in `apps/server/package.json`.
   - In `apps/server/src/server.ts`: remove the import (:28), :388-529, the `originAdoptionAssets` option (:1397-1402) and `registerOriginAdoptionStaticRoutesV1` (:1404). In the host guard (:858-872), throw `ApiError(problem.status, "forbidden_host", ...)` directly when `problem !== null`. In the origin guard (:1476-1500), throw `ApiError(problem.status, "forbidden_origin", ...)` directly.
   - Delete `originAdoptionRequestUrlV1` in `browser-request-guard.ts` and its import at `server.ts`:154.
   - Delete the `origin-adoption-v1` routes and their `body` helper in `routes/server-maintenance.ts`, and the `originAdoption` member and options parameter in `services/maintenance/server-maintenance.ts`.
   - Delete `packages/server-archive/src/origin-adoption-metadata-v1.ts` and its exports in `index.ts`. Keep `"origin-adoption-v1"` in `server-owned-paths.ts`.
   - Delete the three server tests.
   - Checkpoint: server typecheck and test pass, including `apps/server/test/security/api-origin-guard.test.ts` and `browser-websocket-origin.test.ts`.
6. **App checkpoint (after or with RF-008).** Delete `apps/app/src/origin-adoption-v1.ts`, `lib/origin-storage-transfer-v1.ts`, `lib/origin-window-state-v1.ts`, `lib/origin-database-inventory-v1.ts`, `lib/origin-native-completion-v1.ts`, their tests, `apps/app/origin-adoption-v1.html`, `apps/app/vite.origin-adoption-v1.config.ts` and the `originAdoption` input in `vite.config.ts`:41. Delete `packages/desktop-contract/src/internal/origin-adoption-v1.ts` and its `./internal/origin-adoption-v1` export once no importer remains. Run `rg -n "origin-adoption-v1|desktop-contract/internal/origin" apps packages` and expect no hits.
7. **Closeout.**
   - Run `git grep -n -e "$LEGACY_HOST" -e "BB Private Safe Storage" -e protected-store -e profile-continuity`. Expect only the retained legacy-folder names in `desktop-profile-v1.ts` and unrelated BB-era migrations owned by other RF items.
   - Inspect the complete diff for unrelated changes.
   - Recount with `wc -l` against the snapshot numbers above.

**Verification and acceptance criteria**

Commands from the repository root unless stated otherwise. Each command comes from `apps/desktop/README.md`:84-98 or a `package.json` `scripts` entry; none was executed for this card, because the snapshot has no `node_modules`.
- `pnpm exec turbo run typecheck --filter=@omnyo/desktop --filter=omnyo-app`
- `pnpm exec turbo run test --filter=@omnyo/desktop --force`. The desktop `test:prepare` script (`install-electron`) may be needed first.
- `pnpm exec turbo run build --filter=@omnyo/desktop` with `OMNYO_DESKTOP_RELEASE_CHANNEL` unset and with `OMNYO_DESKTOP_RELEASE_CHANNEL=public-beta`.
- `pnpm exec turbo run typecheck test --filter=@omnyo/server --filter=@omnyo/server-archive --filter=@omnyo/desktop-contract --filter=@omnyo/app` and `pnpm exec turbo run build --filter=@omnyo/server --filter=@omnyo/app`.
- Packaged checks on macOS: `pnpm exec turbo run package --filter=@omnyo/desktop`, then `pnpm exec turbo run smoke:packaged --filter=@omnyo/desktop`.

Behavior checks:
- (a) A fresh private profile starts and writes a `kind: "fresh"` marker.
- (b) A copy of the current `Omnyo Private` profile starts with cookies and Connect sign-in intact. The keychain item name must be unchanged ("Omnyo Private Safe Storage").
- (c) A synthetic profile with a `kind: "adopted"` marker and no job directory starts. In the old code this case refuses to start, because `readAdoptedDesktopProfileV1Sync` calls `lstatSync(marker.jobDir)` outside its ENOENT guard.
- (d) A legacy `BB Private` folder next to an unmarked target refuses with the new copy, or starts if decision 1(b) dropped the refusal.
- (e) `--omnyo-electron-trust-probe` still loads the probe; `--omnyo-profile-continuity-v2` now starts the ordinary app path or is refused as an unknown internal flag. Decide which and assert it in `startup.test.ts`.
- (f) A `server-target.json` with an `omnyoOriginAdoptionV1` field round-trips unchanged through a server choice change.
- (g) Requests with `Host: $LEGACY_HOST` are rejected with `forbidden_host`.

Release-tooling check: one private Mac candidate build through the updated `private:ship --mac --prepare` path. Releasing it requires the owner's explicit per-release authority.

Performance: compare the start-to-first-window time from the baseline with `node apps/desktop/scripts/measure-packaged-startup.mjs` on the same machine and packaged build type. Accept only if the result is not slower beyond the run-to-run spread of 5 runs each.

Structural completion: none of the deleted symbols are referenced; `electron-builder.config.json` and `excludedArtifacts` list only existing outputs; no source holds `$LEGACY_ORIGIN`; one owner (`prepareDesktopProfilePathV1`) decides profile identity.

**Rollback and stop conditions**

Each checkpoint (desktop, server, app, private tooling) is a separate commit that `git revert` restores. Deletion leaves all persisted data in place: markers, journals, fence files, keychain items, `server-target.json` fields and the server data `origin-adoption-v1/` directory. Rollback therefore needs no data repair.

Stop and re-plan if:
- the gate finds an adopted marker whose `storageName` differs from the application name, or any live `BB Private` profile that Alex wants migrated rather than started fresh;
- the private release branch Alex names has new callers of the adoption exports;
- Alex wants to keep the stopped-profile cutover for a future identity change. The smaller alternative is then to keep the mechanism, fix the public default-build failure (the missing `scripts/private-electron-trust-probe.cjs`, recorded in the incidental-findings backlog), and move the private-only modules behind the existing `privateContinuity` selection.
- A packaged smoke shows lost cookies or sign-in on an existing profile, or start time regresses.
