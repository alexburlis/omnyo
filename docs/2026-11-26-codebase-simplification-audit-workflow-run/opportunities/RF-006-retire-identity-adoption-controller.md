# RF-006 — Retire the stopped-state BB-to-Omnyo identity adoption: the `adopt-identity` controller, its server-archive state-root engine and identity holds, the plugin artifact and state adoption, and the worker restart hook

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Potential:** high. About 7,700-8,150 handwritten production lines and one complete maintenance pipeline disappear: one CLI subcommand, one server bundle entry, a five-phase stopped-state controller, a 3,049-line state-root copy/fence/rollback engine with three helper modules, six identity-hold transitions, two plugin adoption modules and an identity branch inside the ordinary bundled-plugin update path. This is the largest verified block of single-purpose migration machinery in the server, `@omnyo/server-archive` and the host daemon. The sweep estimate of about 3,000-3,500 lines was too small, because it missed the server-archive engine that only this controller calls.
- **Confidence:** medium-high on reachability, which is Proven by inspection: every listed production symbol has no caller outside this pipeline at the snapshot. It is medium on the support boundary. That boundary rests on owner records and one observed machine, not on a repository rule.
- **Readiness:** decision-needed. Alex must set the upgrade floor: no installation that still holds BB-era (`bb-app` 0.46.x) state will be upgraded in place by a future runtime. The private release tooling that drives identity cutover must stop needing it at the same time. The investigation gate in Execution steps, step 1, lists the exact checks.
- **Effort:** about 2-4 days after the gate clears. That covers about 1 day of deletion in four checkpoints, about half a day of replacement tests for the refusal guards and snapshot projection that stay, and 1-2 days of typecheck, focused tests and diff review across 7 packages. The gate itself takes about an hour of owner confirmation plus one read-only check on the 3090.
- **Risk:** medium. The deletion is code-only and reversible with `git revert`. The real failure mode is an installation that still carries BB-era state upgrading past the removal. The kept refusal guards make that a visible boot refusal rather than silent corruption, but the in-place recovery route would be gone.
- **Prerequisites:** the owner decision and checks in step 1. None of the other RF items has to land first.
- **Related and overlapping work:**
  - **RF-007** (orphaned retired-machine identity recovery) owns `packages/server-archive/src/omnyo-state-root.ts:155-204` (`assertOmnyoStateRootRollbackSelected`) and `:322-768` (`assertHeldIdentitySourceFenceV1`, `assertDisconnectedStopAcquisitionV1`, `prepareHeldIdentitySourceFenceV1`), plus `legacy-runtime-identity-v1.ts`, `legacy-runtime-archive-v1.ts` and `projectLegacyAppUpdateInventoryPathV1`. This card's counts exclude those roughly 500 + 340 lines. If RF-007 has not landed when this card runs, deleting the whole of `omnyo-state-root.ts` absorbs RF-007's state-root steps. Count those lines once, under RF-007.
  - **RF-005** (BB Private desktop profile continuity) keeps `packages/server-archive/mac-state-acl-v1.mjs`, which `apps/desktop` still imports. This card must not delete it.
  - **RF-008** (never-wired native origin first entry) owns `apps/desktop/src/desktop-final-runtime-v1.ts`, which reads `hold.identityAdoption`. This card keeps `identityAdoptionBindingSchema` regardless.
  - **RF-041** (SDK next-major batch) is where the public SDK type `IdentityAdoptionControlRequestV1` can go. This card keeps it.
  - **RF-012**, **RF-039**, **RF-040**, **RF-015** and **RF-043** belong to the same BB-to-Omnyo retirement family, but each removes a different mechanism.
- **Why it deserves its place:** every change to the maintenance hold, the state-admission config, the runtime-identity inventory, bundled-plugin staging or plugin namespaces currently has to keep this pipeline compiling and correct. That includes about 6,800 test lines that exercise it. The two enrolled machines it existed for were adopted on 7 and 8 November 2026.

**Context and evidence**

*Snapshot.* Commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 26 November 2026). The audit worktree had already been removed, so this card reads the commit through `git archive e9e1b74c3 | tar -x` into disposable scratch. All paths are repository-relative at that commit. No tests ran: the snapshot has no `node_modules`.

*What the mechanism does.* BB was the private predecessor of Omnyo. Its installations kept state under `~/.bb`, used plugin IDs such as `bb-guide` and `bb-core-work`, and used the bundled marketplace name `bb-official`. "Identity adoption" moves one stopped BB-era coordinator or worker into the Omnyo identity. It copies the state root into the Omnyo profile, fences the old profile, converts and verifies the SQLite database, re-stages every installed plugin artifact, renames plugin namespaces and the bundled marketplace, and supports rollback until the first write. The release tooling drives it in phases through:

- `apps/cli/src/commands/server.ts:397-430`, the `maintenance adopt-identity` subcommand with `--request-file` and `--phase preflight|stage|rollback`. It calls `runIdentityAdoptionLocal` at `apps/cli/src/commands/server-local.ts:51-95`. That function verifies the selected runtime and spawns `<runtimeRoot>/server/dist/omnyo-identity-adoption.js` (`:72`).
- `apps/server/src/omnyo-identity-adoption.ts` (83 lines). This is the bundle entry. `apps/server/package.json:12` "build" builds it with `node ../../scripts/build-node-entry.mjs src/omnyo-identity-adoption.ts dist/omnyo-identity-adoption.js`. It dispatches to the five phases `preflightIdentityAdoptionV1`, `preflightIdentityAdoptionDatabaseV1`, `verifyIdentityAdoptionDatabaseV1`, `stageIdentityAdoptionV1` and `rollBackIdentityAdoptionV1` in `apps/server/src/services/maintenance/omnyo-identity-controller-v1.ts` (893 lines, exports at `:385`, `:662`, `:678`, `:707` and `:848`).
- The controller calls the server-archive engine `packages/server-archive/src/omnyo-state-root.ts` (3,049 lines). That engine exports `stageOmnyoStateRootFromOwnerV2`, `rollBackOmnyoStateRoot`, `verifyOmnyoStateRootDatabaseV2`, `verifyOmnyoSourceDatabaseCapacityV2`, `preflightOmnyoStateRootKindsV1`, `readOmnyoStateRootJobBindingV2`, `restoreUnstagedOmnyoSourceFenceV1`, `assertOmnyoStagedStateRoot` and `OmnyoStateWorkPendingError`. It is the only importer of `omnyo-state-database-v2.ts` (230), `../omnyo-state-tree-v1.mjs` (1,041, with a 97-line `.d.mts`) and `legacy-app-update-files-v1.ts` (481).
- The controller also calls the identity-hold transitions in `packages/server-archive/src/maintenance-hold.ts:61-935`: `assertPromotedIdentityHoldV1` (`:82`), `promoteDesktopUpdateHoldForIdentityV1` (`:209`), `assertIdentityAdoptionHoldCanReleaseV1` (`:391`), `restoreIdentityHoldAfterRollbackV1` (`:421`), `restoreUnstagedIdentityHoldV1` (`:606`) and `restoreAbortedIdentityHoldV1` (`:736`).
- On the plugin side, the controller calls `adoptOmnyoPluginStateV1` (`apps/server/src/services/plugins/omnyo-plugin-state-v1.ts:732`, 746-line file) and the functions `readIdentityPluginArtifactsSelectionV1`, `verifyIdentityPluginArtifactsV1` and `adoptIdentityPluginArtifactsV1` (`apps/server/src/services/plugins/omnyo-plugin-artifacts-v1.ts`, 859 lines). The artifact module stages bundled plugins through the `identityAdoption` option of `stageBuiltinPluginArtifact` (`apps/server/src/services/plugins/builtin-plugin-artifacts.ts:293`, with branches at `:300-318`, `:345-352`, `:354-427`, `:430-470` and `:511-540`). The state module calls `prepareLegacyBundledMarketplaceV1`/`adoptLegacyBundledMarketplaceV1` (`apps/server/src/services/plugins/legacy-bundled-marketplace-v1.ts:47`, `:157`).
- The host daemon has a worker-side hook. `apps/host-daemon/src/identity-adoption-update.ts` (104 lines), `prepareWorkerIdentityAdoptionRestart`, is wired as `onBeforeRestart` at `apps/host-daemon/src/app.ts:1219-1227` (import at `:19`). It reads `<dataDir>/identity-adoption-request-v1.json` and returns early when that file is absent.
- On the server, `server-maintenance.ts:525-534` calls `assertIdentityAdoptionHoldCanReleaseV1` when the release route meets a non-released hold that carries `identityAdoption`.

*Consumer search (Proven by inspection).* For each export above, `rg -l "\b<symbol>\b" apps packages plugins scripts tools tests` (excluding the defining file) found only the files named here and their tests. The two exceptions are recorded below. String and dynamic searches for `omnyo-identity-adoption`, `adopt-identity`, `identity-adoption-request-v1`, `held-source-fence-v1` and `identityAdoption` found, outside this pipeline, only:

- the docs `docs/configuration.md:308-319`, `docs/lint-policy.md:43-44`, `packages/templates/src/templates/omnyo-guide-machines.md:309-316`, `plugins/omnyo-guide/skills/omnyo-cli/references/configuration.md:161` and `plugins/omnyo-guide/skills/omnyo-cli/references/command-index.md:221`. `apps/cli/src/__tests__/omnyo-cli-skill-coverage.test.ts` requires that command index to list every visible core command;
- the lint override `.oxlintrc.json:286-287`;
- `packages/omnyo-app/src/machine-state.ts:30`, which re-exports `promoteDesktopUpdateHoldForIdentityV1` into the packaged `dist/machine-state.mjs` entry;
- the public SDK type re-export `packages/sdk/src/areas/server.ts:20-23` (`IdentityAdoptionBinding` and `IdentityAdoptionControlRequestV1`), which reaches consumers through `packages/sdk/src/public-types.ts:67`;
- the persisted hold schema `packages/domain/src/server-maintenance.ts:77` (`identityAdoption: identityAdoptionBindingSchema.optional()` inside the `.strict()` `maintenanceHoldSchema`);
- `apps/desktop/src/desktop-final-runtime-v1.ts:3`, `:21` and `:48`, which belong to RF-008.

*Live code that shares names but must stay (Proven by inspection).*

- `assertStoppedIdentityRuntimeOwnersV1` (`maintenance-hold.ts:160-207`) is also called by `omnyo server import` (`apps/cli/src/commands/server-local.ts:344` "assertNoRunningApp"). Keep it.
- The per-boot refusal guards are the visible failure for an unmigrated database. Keep them: `assertOmnyoPluginNamespacesAdopted` (`omnyo-plugin-state-v1.ts:250-280`, called at `apps/server/src/services/plugins/plugin-registration.ts:851` "reconcileBundled") and `assertLegacyBundledMarketplaceAdoptedV1` (`legacy-bundled-marketplace-v1.ts:32-45`, called at `apps/server/src/services/plugin-catalog/plugin-catalog-service.ts:193`). The CLI import refusal `assertNoPreCutoverDatabaseV1` in `server-local.ts` stays as well.
- `projectOmnyoSnapshotPathV1` and `projectLegacyBundledMarketplaceSnapshotV1` (`omnyo-plugin-state-v1.ts:182-243`, with `remapPath` at `:169-180` and the receipt schema at `:41-56`) are called on every plugin-snapshot restore by `apps/server/src/services/plugins/plugin-state-snapshot.ts:19-20`, `:164`, `:169` and `:185`. They remap paths in snapshots taken before adoption, using the receipt `omnyo.plugin-state.v1` that adoption leaves in `app_settings_values`. Snapshots normally expire 7 days after creation (`DEFAULT_ARTIFACT_RETENTION_MS`, `apps/server/src/services/plugins/plugin-service.ts:504`; `retainedUntil` at `plugin-activation.ts:253`). However, `listExpiredPluginStateSnapshots` (`packages/db/src/data/plugin-state-snapshots.ts:148-166`) never expires a snapshot in `rollback-pending` or `restoring`. So this card keeps the projection.
- The state-admission boot contract (`@omnyo/config/omnyo-state-admission`, `@omnyo/config/omnyo-state-startup`, including `retireCompletedOmnyoStateAdmissionV1`) runs on every server, host-daemon and CLI start, and it reads persisted `config.json` `stateMigration`. It is out of scope.
- `mac-state-acl-v1.mjs` is still imported by `apps/desktop` (RF-005).
- `legacy-npm-plugin-engines-v1.ts`, `legacy-plugin-skill-identity-v1.ts`, `plugin-consolidations.ts`, the `.bb/plugins.json` reader and the `@omnyo/domain` `importLegacy*V1` helpers serve ongoing compatibility, as the S07 sweep found. They are out of scope.

*Support boundary.* Owner records and one read-only observation:

- **Mac coordinator (observed read-only on 26 November 2026).** The data directory's `server-maintenance-hold.json` is a version 1 hold with `kind: "migration"` and `phase: "released"`, created on 7 November 2026. It carries an `identityAdoption` coordinator binding. The binding's source `~/.bb`, its job directory and its runtime root no longer exist. No `identity-adoption*`, `held-source-fence-v1.json` or `root-adoption.json` file was found in the current release-tooling directories under `~/Library/Application Support` (search depth 6). **Consequence:** the persisted hold schema must keep accepting `identityAdoption`. `readMaintenanceHold` (`maintenance-hold.ts:34-49`) parses with the strict `maintenanceHoldSchema`, so removing the field would make every hold read on this machine throw.
- **3090 worker (owner record, not observed).** `$HOME/.agents/docs/machines.md` ("3090 daemon startup") records that the worker has run from an Omnyo profile since its migration on 8 November 2026. The original `bb-app` profile was moved to an archive on 9 November 2026 "as the migration's recovery copy", and the record says not to start, edit or delete it without the owner's approval.
- **a connected MacBook** joined after 10 November 2026 as an Omnyo worker (Hypothesis: it never had BB state).
- **Public users (Hypothesis, strong).** Adoption needs a request that binds a private-ship job directory, maintenance hold, runtime archive digest and plugin-artifact selection. Only the private release tooling produces such a request, so a public self-hoster cannot reach this path. The public line is 1.x; BB was the private 0.46.x line.

*External consumers outside this repository (Proven by inspection of the local retired checkout, which is not part of the snapshot).* The private release tooling in `$ARCHIVED_OMNYO_CHECKOUT/scripts/` still contains an identity-cutover phase. `private-ship.mjs` uses `coordinator.identityAdoption` and the `"identity-cutover"` route, and both it and `private-ship-coordinator.mjs` spawn `server/dist/omnyo-identity-adoption.js`. `private-plugin-cohort.mjs:33` imports `selectIdentityPluginCohortSourceV1` from that checkout's own source copy of `omnyo-plugin-artifacts-v1.ts`. Within this repository, that function is used only by `apps/server/test/system/omnyo-identity-controller.test.ts:882`. A search of the retired checkout, `~/.agents` and `~/projects/omnyo-plugins` found no importer of `promoteDesktopUpdateHoldForIdentityV1` through `machine-state.mjs`. A search without matches is not proof of absence.

*Maintenance cost today.* Several kinds of ordinary change must keep this pipeline compiling and its tests passing:

- `maintenanceHoldSchema`, the runtime-identity inventory, `@omnyo/config` state admission or managed config;
- bundled-plugin staging, where `stageBuiltinPluginArtifact` interleaves about 120 lines of identity-only branches with the normal update path that `plugin-updates.ts:703` uses;
- plugin namespace tables, because `namespaceColumns` in `omnyo-plugin-state-v1.ts:76-90` must list every plugin-keyed table;
- the server build, which carries one extra bundle entry.

About 6,800 test lines exercise the pipeline.

*Sweep claims corrected.*

1. The sweep listed `selectIdentityPluginCohortSourceV1` as "no production caller". It does have an out-of-repository consumer, and it goes only with the gate.
2. The server-archive scope is about 5,150 lines, not "about 870": `omnyo-state-root.ts` and three helper modules serve only this controller.
3. The `identityAdoption` hold field and `identityAdoptionBindingSchema` must stay, because a persisted released hold uses them.
4. `assertStoppedIdentityRuntimeOwnersV1` is live, through `server import`.
5. The snapshot projection is live on adopted installations.
6. The refusal guards are kept, so the claimed per-boot query saving does not materialize.

**Proposed end state and preservation argument**

*What disappears:*

- the `adopt-identity` subcommand and `runIdentityAdoptionLocal`;
- the `dist/omnyo-identity-adoption.js` entry and its build step;
- `omnyo-identity-controller-v1.ts`;
- `omnyo-plugin-artifacts-v1.ts`;
- the adoption half of `omnyo-plugin-state-v1.ts` and of `legacy-bundled-marketplace-v1.ts`;
- the `identityAdoption` option of `stageBuiltinPluginArtifact`;
- `omnyo-state-root.ts`, `omnyo-state-database-v2.ts`, `omnyo-state-tree-v1.mjs`/`.d.mts` and `legacy-app-update-files-v1.ts`;
- the six identity-hold transitions in `maintenance-hold.ts`;
- the host-daemon `prepareWorkerIdentityAdoptionRestart` and its wiring;
- `identityAdoptionPreflightRequestSchemaV1`;
- the `machine-state.ts` re-export;
- the two lint overrides and the identity paragraphs in the five docs;
- the dedicated tests and test fixtures.

*What remains, and who owns it:*

- **Refusal guards.** `assertOmnyoPluginNamespacesAdopted` and its helpers `namespaceColumns`, `scopedSettings` and `namespacePopulated` stay in `omnyo-plugin-state-v1.ts`. `assertLegacyBundledMarketplaceAdoptedV1` stays in `legacy-bundled-marketplace-v1.ts`. Both files keep their names, so `plugin-registration.ts`, `plugin-catalog-service.ts` and `plugin-state-snapshot.ts` keep their imports. An unmigrated database still fails at boot with the same messages.
- **Snapshot projection.** `omnyoPluginStateReceiptKeyV1`, `omnyoPluginStateReceiptSchemaV1`, `pathBindingSchema`, `remapPath`, `projectOmnyoSnapshotPathV1` and `projectLegacyBundledMarketplaceSnapshotV1` stay unchanged in `omnyo-plugin-state-v1.ts`. A restore of a pre-adoption snapshot behaves exactly as today.
- **Persisted hold format.** `identityAdoptionBindingSchema` and the optional `identityAdoption` field of `maintenanceHoldSchema` stay. So do `identityAdoptionControlRequestSchemaV1` and its inferred type, because the public SDK type `IdentityAdoptionControlRequestV1` is derived from them. Removing that type is left to RF-041.
- **Release route.** In `server-maintenance.ts`, a non-released hold that carries `identityAdoption` is refused with the existing `ApiError(409, "maintenance_conflict", …)` shape and a fixed message: "This hold belongs to a retired identity adoption; release it with the runtime that created it". A released hold still returns `{ released: true }` before this check (`:523`), exactly as today, so the Mac's persisted hold is unaffected.
- **`server import`.** `assertStoppedIdentityRuntimeOwnersV1` stays in `maintenance-hold.ts` with its current behavior. Renaming it is out of scope.

*Intentional behavior changes, accepted only through the gate:*

- `omnyo server maintenance adopt-identity` no longer exists. Commander reports it as an unknown command.
- A runtime built after this change cannot serve as the identity-control runtime for a BB-era profile. An operator who must adopt such a profile has to use a retained older runtime, which still contains the entry, and then upgrade.
- A non-released identity hold can no longer be released through the new runtime.

*Non-goals:* do not change state admission, server move or held-runtime repair (`held-runtime-repair.ts` uses server-move promotion, not identity promotion). Also leave unchanged the desktop profile adoption (RF-005), `desktop-final-runtime-v1.ts` (RF-008), the domain `importLegacy*V1` helpers, the generic `onBeforeRestart` option of `apps/host-daemon/src/protocol-self-update.ts:154` and its tests, and applied database migrations. Do not touch the retired private checkout; its tooling changes are a separate change in a separate repository.

*Why this is the simplest sufficient option.* The pipeline has one purpose, and both enrolled machines have completed it. Keeping only the refusal guards, the snapshot projection and the persisted hold field keeps every observable behavior on adopted and fresh installations. Every one of those pieces is read on a live path today.

*Remaining uncertainty:* the 3090 worker's data directory has not been observed, and the retired private tooling might be run again for a cutover.

**Expected gain and cost**

Handwritten production lines (wc -l at the snapshot; "about" marks function-range estimates):

| Area | Removed | Kept or added |
|---|---|---|
| `apps/server/src/services/maintenance/omnyo-identity-controller-v1.ts` | 893 | 0 |
| `apps/server/src/omnyo-identity-adoption.ts` | 83 | 0 |
| `apps/server/src/services/plugins/omnyo-plugin-artifacts-v1.ts` | 859 | 0 |
| `apps/server/src/services/plugins/omnyo-plugin-state-v1.ts` (746) | about 570 | about 175 kept |
| `apps/server/src/services/plugins/legacy-bundled-marketplace-v1.ts` (210) | about 180 | about 30 kept |
| `builtin-plugin-artifacts.ts` identity branches | about 100-150 | 0 |
| `server-maintenance.ts` release check, `package.json` build segment | about 10 | about 6 added |
| `apps/cli` (`server.ts:397-430`, `server-local.ts:51-95`, imports) | about 80 | 0 |
| `apps/host-daemon` (`identity-adoption-update.ts` and wiring) | about 114 | 0 |
| `packages/server-archive/src/omnyo-state-root.ts` (3,049, less about 497 counted under RF-007) | about 2,552 | 0 |
| `omnyo-state-database-v2.ts`, `omnyo-state-tree-v1.mjs`, `legacy-app-update-files-v1.ts` (net of RF-007's 5 lines) | 230 + 1,041 + 476 | 0 |
| `maintenance-hold.ts:61-935` less `assertStoppedIdentityRuntimeOwnersV1` | about 827 | 0 |
| `server-archive/src/index.ts`, `packages/domain`, `packages/omnyo-app/src/machine-state.ts` | about 32 | 0 |
| **Total** | **about 8,050-8,100** | **about 210 kept, about 6 added** |

The projected net reduction is about 7,700-8,100 production lines, allowing for import adjustments. Separately, the hand-written declaration `omnyo-state-tree-v1.d.mts` (97 lines) is removed.

- **Tests (separate):** these deletions total about 6,800 lines. The files are `apps/server/test/system/omnyo-identity-controller.test.ts` (1,378) and most of `apps/server/test/services/plugins/omnyo-plugin-state.test.ts` (1,115, of which about 100-150 are rewritten as guard and projection tests). In `packages/server-archive/test`: the six `omnyo-state-root*.test.ts` files (1,899), `identity-hold-v1.test.ts` (505), `omnyo-worker-root.test.ts` (111), `omnyo-state-database-verification-v2.test.ts` (532), `omnyo-state-tree-copy.test.ts` (671), `legacy-app-update-files-v1.test.ts` (320) and the fixtures `omnyo-root-fixture.ts` (100), `omnyo-worker-root-fixture.ts` (67) and `omnyo-worker-runtime-fixture.ts` (58). Also `apps/host-daemon/src/identity-adoption-update.test.ts` (158). `omnyo-state-acl-tree.test.ts` stays as the direct coverage for `mac-state-acl-v1.mjs`.
- **Config and docs (separate):** three test-fixture subpath exports in `packages/server-archive/package.json:7-11` and `:27-36`, two `.oxlintrc.json` entries, and about 25 doc lines in five files.
- **Mechanisms before and after:**
  - The server bundle entries in `package.json` "build" drop from five `build-node-entry` targets to four.
  - The `server maintenance` CLI loses one subcommand.
  - The maintenance hold goes from four kinds of identity transition to none. The hold keeps one inert field.
  - Bundled-plugin staging goes from two code paths to one.
  - The host daemon's self-update has no pre-restart identity work.
  - `@omnyo/server-archive` goes from about 8,800 lines to about 3,600 (Projection).
- **Maintenance example:** today, adding a plugin-keyed table means updating `namespaceColumns`, which serves both the guard and the adoption, and re-running the adoption tests. A change to the stage logic of `stageBuiltinPluginArtifact` has to preserve the `adoption !== undefined` receipt, directory-ownership and collision branches. After the change, the table addition updates only the guard list, and bundled staging has one path.
- **Performance:** neutral at runtime, because the per-boot guards stay. The server build has one fewer esbuild entry, and `server/dist` loses one bundle. Bundle size and build time effects are Hypothesis until measured.
- **Unknowns:** the exact length of the builtin branches (100-150) and of the kept helpers (about 175) will be fixed when the edit is made. Recount with the same `wc -l` basis.

**Execution steps**

1. **Investigation gate.** Stop unless every item passes, and record the evidence in the change description.
   1. **Owner decision (Alex):** no BB-era installation will be adopted in place by any runtime built after this change. This includes the archived original 3090 profile recorded in `machines.md`. If that archive is ever needed, it will be adopted with a retained older runtime, which still contains the entry, before upgrading. If Alex wants new runtimes to keep this ability, stop and retain the pipeline.
   2. **Owner decision (Alex):** the private release tooling's identity-cutover branch (`private-ship.mjs`, `private-ship-coordinator.mjs`, `private-plugin-cohort.mjs`) will not be run against a runtime built after this change. Either retire that branch in its own repository first, or confirm that it will refuse a runtime without `server/dist/omnyo-identity-adoption.js`. That tooling lives outside this repository and needs its own scoped change.
   3. **Read-only check on the 3090 worker:** confirm that `identity-adoption-request-v1.json` is absent from its live Omnyo data directory. For example, use `Test-Path` over the existing SSH route, or `omnyo file` with read-only semantics. Also confirm that its `server-maintenance-hold.json`, if present, is `released` or carries no `identityAdoption`. If the request file exists, stop: a worker adoption is in flight.
   4. **Mac coordinator check:** confirm that `server-maintenance-hold.json` is still `phase: "released"`. Confirm also that no `plugin_state_snapshots` row is in `rollback-pending` or `restoring` with a `created_at` before 2026-11-07. Run the query read-only against a copy of the database, not the live WAL database. If such a row exists, the kept snapshot projection already covers it, so continue, but do not remove the projection.
   5. **Re-planning triggers:** re-run the consumer searches below on the target commit. Re-plan if any new production importer of the removed symbols appears, if RF-007 has changed `omnyo-state-root.ts` (re-derive its line ranges by symbol name), or if `maintenanceHoldSchema` has changed shape.

   ```sh
   # repository root
   rg -n "omnyo-identity-adoption|adopt-identity|identity-adoption-request-v1|held-source-fence-v1" -g '!node_modules' .
   rg -n "\b(stageOmnyoStateRootFromOwnerV2|rollBackOmnyoStateRoot|verifyOmnyoStateRootDatabaseV2|verifyOmnyoSourceDatabaseCapacityV2|preflightOmnyoStateRootKindsV1|readOmnyoStateRootJobBindingV2|restoreUnstagedOmnyoSourceFenceV1|assertOmnyoStagedStateRoot|OmnyoStateWorkPendingError|OmnyoStagedStateRoot|OmnyoStateRootInput|inspectOmnyoStateRoot|inspectOmnyoStateRootForAdoptionV2|stageOmnyoStateRoot|assertPromotedIdentityHoldV1|promoteDesktopUpdateHoldForIdentityV1|assertIdentityAdoptionHoldCanReleaseV1|restoreIdentityHoldAfterRollbackV1|restoreUnstagedIdentityHoldV1|restoreAbortedIdentityHoldV1|adoptOmnyoPluginStateV1|adoptIdentityPluginArtifactsV1|selectIdentityPluginCohortSourceV1|prepareLegacyBundledMarketplaceV1|adoptLegacyBundledMarketplaceV1|adoptLegacyAppUpdateFilesV1|assertLegacyAppUpdateOwnerStoppedV1|identityAdoptionPreflightRequestSchemaV1)\b" -g '!node_modules' apps packages plugins scripts tools tests
   ```

   Expect matches only in the files this card deletes or edits.

2. **Characterize the behavior that stays (before deleting anything).** Add a focused test file, for example `apps/server/test/services/plugins/omnyo-identity-guards.test.ts`, that uses only `createConnection` and seeded rows, without the state-root fixture. It must assert the following, using today's messages:
   - `assertOmnyoPluginNamespacesAdopted` throws "Plugin namespace … requires the stopped Omnyo state migration before registration" when a `plugin_settings` row exists under an ID from `legacyOwnedPluginIdsV1`;
   - it throws the guide message for `plugin_id='omnyo-guide' AND key='bbCli'`, and the core-work message for `thread_plugin_metadata.plugin_id='bb-core-work'`;
   - it does not throw on a fresh database;
   - `projectOmnyoSnapshotPathV1` returns its input unchanged without a receipt, and remaps a `from` prefix when an `omnyo.plugin-state.v1` receipt row exists;
   - `projectLegacyBundledMarketplaceSnapshotV1` passes through non-`bb-official` names, throws "Legacy bundled marketplace snapshot requires the stopped Omnyo migration" without a receipt, and maps to `omnyo-official` when the receipt and an `omnyo-official` marketplace row exist.

   Move only these obligations out of `omnyo-plugin-state.test.ts` (`:140`, `:172`, and the snapshot reads at `:339` and `:1020`). Keep `apps/server/test/services/plugin-catalog/plugin-catalog-service.test.ts:206` ("refuses a legacy bundled marketplace before the constructor can seed any catalog") unchanged. Add a case to `apps/server/test/system/server-maintenance.test.ts` that writes a released hold carrying an `identityAdoption` binding and asserts that release returns `{ released: true }`, and that a `held` hold with the binding gets 409 `maintenance_conflict`. Run these tests and see them pass on the unmodified code. The 409 case passes today too, as long as `assertIdentityAdoptionHoldCanReleaseV1` throws for a fixture without its job directory; confirm that.

3. **Checkpoint A: CLI, entry, controller and plugin adoption (apps/server and apps/cli).**
   - **`apps/cli/src/commands/server.ts`:** delete the `maintenance.command("adopt-identity")` block (`:397-430`) and the `runIdentityAdoptionLocal` import (`:31`).
   - **`apps/cli/src/commands/server-local.ts`:** delete `runIdentityAdoptionLocal` (`:51-95`). Drop `identityAdoptionControlRequestSchemaV1` (`:4`), `readRuntimeIdentity` and `verifyRuntimeIdentity` from the imports only if they have no other use. Keep `assertStoppedIdentityRuntimeOwnersV1`.
   - **`apps/server/package.json:12`:** remove the segment ` && node ../../scripts/build-node-entry.mjs src/omnyo-identity-adoption.ts dist/omnyo-identity-adoption.js`.
   - **Delete files:** delete `apps/server/src/omnyo-identity-adoption.ts`, `apps/server/src/services/maintenance/omnyo-identity-controller-v1.ts` and `apps/server/src/services/plugins/omnyo-plugin-artifacts-v1.ts`.
   - **`omnyo-plugin-state-v1.ts`:** delete `moveSchema`, `journalSchema`, `stateDigest`, `syncDirectory`, `writeJournal`, `assertEmptyTarget`, `assertLegacyGuidePreferencesV1`, `projectCommand`, `updateStructuredReferences`, `updateNamespaces`, `adoptStagedPluginState` and `adoptOmnyoPluginStateV1`. Then remove the imports that become unused, such as `withFileLock`, `threadTabsSchema`, `importLegacyNavigationKeyV1`, the server-archive types and the `prepare`/`adopt` marketplace imports. Keep everything listed under "What remains".
   - **`legacy-bundled-marketplace-v1.ts`:** delete `legacyRowSchemaV1`, `prepareLegacyBundledMarketplaceV1` and `adoptLegacyBundledMarketplaceV1`, together with the imports only they use. Keep `legacyNameV1` and `assertLegacyBundledMarketplaceAdoptedV1`. Drop `currentNameV1` if it becomes unused.
   - **`builtin-plugin-artifacts.ts` `stageBuiltinPluginArtifact`:** remove the `identityAdoption` parameter and every `adoption` branch. The surviving code is what runs today when `adoption === undefined`:
     - `id = randomUUID()`, and `registeredRoot` equals `rootDir`;
     - an existing inventory always throws "Bundled identity artifact inventory collision";
     - no receipt is written;
     - `mkdir(dirname(rootDir), { recursive: true }); mkdir(rootDir)`;
     - per-file `mkdir(dirname(path), { recursive: true })`;
     - `existing = null`.

     Delete `ensureIdentityDirectory`, and drop the `assertOmnyoStagedStateRoot`/`OmnyoStagedStateRoot` imports. Keep the error strings of the surviving branches byte-identical. `plugin-updates.ts:703` is the only remaining caller.
   - **`server-maintenance.ts:525-534`:** replace the `assertIdentityAdoptionHoldCanReleaseV1` call with an unconditional `throw new ApiError(409, "maintenance_conflict", "This hold belongs to a retired identity adoption; release it with the runtime that created it")`. Remove that function from the import at `:25`.
   - **Delete tests:** delete `apps/server/test/system/omnyo-identity-controller.test.ts` and the adoption cases in `omnyo-plugin-state.test.ts`, which is every case except those moved in step 2. Delete the file if nothing remains.
   - **Verify:** run the server and CLI typechecks and the focused tests listed under Verification.

4. **Checkpoint B: the host-daemon hook.**
   - **`apps/host-daemon/src/app.ts`:** delete the `onBeforeRestart: (target) => prepareWorkerIdentityAdoptionRestart({...})` property (`:1219-1227`) and the import (`:19`). Leave the `onBeforeRestart` option in `protocol-self-update.ts`, which still has generic test coverage at `protocol-self-update.test.ts:1009`.
   - **Delete files:** delete `apps/host-daemon/src/identity-adoption-update.ts` and `identity-adoption-update.test.ts`.
   - **Verify:** run the host-daemon typecheck and `protocol-self-update.test.ts`.

5. **Checkpoint C: the server-archive engine and identity holds.**
   - **Delete files:** delete `packages/server-archive/src/omnyo-state-root.ts` (its RF-007 ranges go too, if still present), `src/omnyo-state-database-v2.ts`, `omnyo-state-tree-v1.mjs`, `omnyo-state-tree-v1.d.mts` and `src/legacy-app-update-files-v1.ts`.
   - **`src/maintenance-hold.ts`:** delete `PromoteIdentityHoldInput`, `assertPromotedIdentityHoldV1`, `promoteDesktopUpdateHoldForIdentityV1` and every private helper between `:209` and `:935`, which ends at `restoreAbortedIdentityHoldV1`. Keep `SERVER_MAINTENANCE_HOLD_FILE_NAME`, `readMaintenanceHold`, `writeMaintenanceHold` and `assertStoppedIdentityRuntimeOwnersV1`, and remove the imports that become unused.
   - **`src/index.ts`:** remove the `legacy-app-update-files-v1` export block (`:1-5`) and the whole `./omnyo-state-root.js` export block (`:110-128`). `export * from "./maintenance-hold.js"` stays.
   - **`packages/server-archive/package.json`:** remove the `./test/omnyo-root-fixture`, `./test/omnyo-worker-root-fixture` and `./test/omnyo-worker-runtime-fixture` exports once no test imports them.
   - **`packages/omnyo-app/src/machine-state.ts:30`:** remove the `promoteDesktopUpdateHoldForIdentityV1` re-export.
   - **Delete tests:** delete the tests and fixtures listed under Expected gain. If `omnyo-state-tree-copy.test.ts` contains a case that tests only `inspectMacStateAclV1`, confirm that `omnyo-state-acl-tree.test.ts` already covers it before deleting.
   - **Verify:** run the server-archive, omnyo-app, server and desktop typechecks (desktop imports `@omnyo/server-archive`) and the server-archive test suite.

6. **Checkpoint D: domain, docs and lint config.**
   - **`packages/domain/src/server-maintenance.ts`:** delete `identityAdoptionPreflightRequestSchemaV1` and its type (`:48-53`). Keep `identityAdoptionBindingSchema`, `identityAdoptionControlRequestSchemaV1` with `IdentityAdoptionControlRequestV1` (public SDK type), and `maintenanceHoldSchema` unchanged.
   - **Docs:** delete the identity paragraphs at `docs/configuration.md:308-319`. First confirm that `:308-310` refers only to the identity-migration offer, and keep any sentence about the generic idle-only update. Also delete `docs/lint-policy.md:43-44`, `packages/templates/src/templates/omnyo-guide-machines.md:309-315`, `plugins/omnyo-guide/skills/omnyo-cli/references/configuration.md:161` and `plugins/omnyo-guide/skills/omnyo-cli/references/command-index.md:221`. The `omnyo-guide` plugin skill files are plugin content, so follow the repository's plugin release rules for that plugin.
   - **`.oxlintrc.json:286-287`:** remove the two identity paths from the override.
   - **Docs to keep:** add one sentence to `docs/configuration.md` near the maintenance commands. It should say that a BB-era data directory is refused at startup and must be adopted with a pre-removal runtime before upgrading. This keeps the visible refusal documented.

7. **Closeout.** Re-run the searches from step 1.5; only the kept symbols may match. Inspect the full diff for unrelated changes. Recount removed lines with `git diff --numstat <base> -- apps packages`, keeping production and tests separate, and compare against the table above.

**Verification and acceptance criteria**

Every command below runs from the repository root. The package scripts were confirmed in each `package.json` at the snapshot. None of them was run for this card.

- **Typecheck** (each package has `"typecheck": "tsc --noEmit"`; the root script is `pnpm typecheck`, which runs `turbo run typecheck`):
  - `pnpm --filter @omnyo/server typecheck`
  - `pnpm --filter @omnyo/server-archive typecheck`
  - `pnpm --filter @omnyo/cli typecheck`
  - `pnpm --filter @omnyo/host-daemon typecheck`
  - `pnpm --filter @omnyo/domain typecheck`
  - `pnpm --filter @omnyo/sdk typecheck`
  - `pnpm --filter omnyo-app typecheck`
  - the desktop package typecheck; confirm its package name and script in `apps/desktop/package.json`.
- **Server focused tests** (`"test": "vitest run --config vitest.config.ts"`), from `apps/server`:
  - `pnpm exec vitest run --config vitest.config.ts test/services/plugins/omnyo-identity-guards.test.ts test/services/plugin-catalog/plugin-catalog-service.test.ts test/services/plugins/plugin-state-snapshot.test.ts test/services/plugins/builtin-plugin-update.test.ts test/services/plugins/builtin-plugins.test.ts test/services/plugins/plugin-update.test.ts test/system/server-maintenance.test.ts`
  - Expect all to pass with unchanged assertions, plus the new cases from step 2.
- **Server-archive** (`"test": "vitest run --config vitest.config.ts"`), from `packages/server-archive`: `pnpm exec vitest run --config vitest.config.ts`. Expect the remaining suites to pass, including `omnyo-state-acl-tree.test.ts`, `runtime-identity.test.ts` and the server-move tests.
- **Host daemon**, from `apps/host-daemon`: `pnpm exec vitest run --config vitest.config.ts src/protocol-self-update.test.ts`.
- **CLI**, from `apps/cli`: `pnpm exec vitest run src/__tests__/omnyo-cli-skill-coverage.test.ts src/__tests__/command-output/server-local.test.ts`. The coverage test must pass with `adopt-identity` absent from both the program and `command-index.md`.
- **Build:** `pnpm --filter @omnyo/server build` must succeed, and `apps/server/dist/omnyo-identity-adoption.js` must not exist afterwards. `apps/server/test/app/omnyo-app-artifact-prepared.test.ts` must still pass; it lists the packaged entries.
- **Lint and format:** run `pnpm exec oxlint --deny-warnings --format=agent` and `pnpm format:check` (root scripts `lint` and `format:check` exist; oxlint is a root devDependency). Format changed files with `pnpm exec oxfmt <files>`.
- **Contracts:**
  - a released hold with `identityAdoption` still parses through `readMaintenanceHold` and still releases idempotently;
  - an unmigrated database still refuses plugin registration and catalog construction with the same messages;
  - snapshot restore still remaps through the receipt;
  - the `server import` refusal for a running app is unchanged, which `server-local.test.ts` covers.
- **UI:** none is affected. **Performance:** no runtime path changes. Optionally compare `apps/server/dist` size and `pnpm --filter @omnyo/server build` wall time before and after on the same machine, and report the measurements as observations.
- **Structural completion:** step 7's searches match only the kept symbols. `@omnyo/server-archive` exports no `*OmnyoStateRoot*` and no identity-hold transition. `stageBuiltinPluginArtifact` has no `identityAdoption` parameter. `package.json` "build" has four `build-node-entry` targets.

**Rollback and stop conditions**

- **Rollback:** land the four checkpoints as separate commits on one branch, so that each can be reverted alone. No persisted format, database migration or setting changes. The hold field, receipt key and guards stay, so reverting restores the pipeline without data repair.
- **Stop conditions:**
  - any gate item in step 1 fails or is unanswered;
  - a production importer of a removed symbol appears outside this card's files;
  - the 3090 has `identity-adoption-request-v1.json` or an unreleased identity hold;
  - a typecheck in `apps/desktop` or `packages/omnyo-app` fails on a removed name, which means a consumer was missed: restore that symbol and investigate;
  - a kept-behavior test from step 2 needs a changed assertion to pass;
  - the private release tooling still plans a cutover against new runtimes.
- **Smaller safe alternative if the gate is only partly answered:** if Alex wants to keep the controller, land only the out-of-pipeline cleanups that do not depend on the floor, which are RF-007's orphan deletions. Leave this card's pipeline intact. Do not split the pipeline itself: a half-removed controller would leave the CLI pointing at a missing entry.
